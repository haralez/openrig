// #1077 — a resumed Claude seat whose session id changes. The seat launched with `--resume T1`,
// Claude continued as T2 and its SessionStart hook recorded T2. The proof accepts T1 in argv only
// when that hook said `source: resume` and carried the node's current occupant generation.
// A /clear (source clear), a fresh startup, a compaction that changes the id, a stale generation and
// a hook without a source all keep today's refusal.

import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry, claudeRotatedFromToken } from "../src/domain/session-registry.js";
import { verifyClaudePaneProcess, observeClaudeDelivery, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildSessionIdentityPayload(payload: Record<string, unknown>, env: Record<string, string>): Record<string, unknown> | null;
};

const T1 = "00000000-0000-4000-8000-000000001077";
const T2 = "00000000-0000-4000-8000-000000001078";
const T3 = "00000000-0000-4000-8000-000000001079";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function seat(opts: { launched?: boolean } = {}) {
  const db = createDb(); databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = rigRepo.createRig("rotation");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const session = registry.registerSession(node.id, "dev-impl@rotation");
  // The launch records the token it resumed (startup-orchestrator, provenance scrape).
  if (opts.launched !== false) registry.updateResumeToken(session.id, "claude_id", T1, "scrape");
  const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
  const row = () => db.prepare(
    "SELECT resume_token, resume_provenance, resume_source, resume_rotated_from FROM sessions WHERE id = ?",
  ).get(session.id) as { resume_token: string; resume_provenance: string; resume_source: string | null; resume_rotated_from: string | null };
  const hook = (token: string, source: string | null, currentGeneration = true) =>
    registry.recordHookSessionIdentity(session.id, "claude_id", token, { source, currentGeneration });
  return { db, registry, session, node, generation, row, hook };
}

describe("recording how a Claude session began", () => {
  it("a resume into a new id, for the current generation, keeps the replaced launch token", () => {
    const s = seat();
    expect(s.hook(T2, "resume")).toBe(true);
    expect(s.row()).toEqual({ resume_token: T2, resume_provenance: "hook", resume_source: "resume", resume_rotated_from: T1 });
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
  });

  it.each(["clear", "startup", "compact"])("source %s into a new id records the source but no accepted launch token", (source) => {
    const s = seat();
    s.hook(T2, source);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_source: source, resume_rotated_from: null });
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it.each([
    ["no source (older Claude, other runtimes)", null, true],
    ["a stale occupant generation", "resume", false],
  ] as const)("%s is no evidence: fail closed", (_label, source, currentGeneration) => {
    const s = seat();
    s.hook(T2, source, currentGeneration);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_source: null, resume_rotated_from: null });
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("a later hook for the same id (for example a compaction) keeps the resume record", () => {
    const s = seat();
    s.hook(T2, "resume");
    s.hook(T2, "compact");
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
  });

  it("one hop: a /clear after the resume drops the acceptance", () => {
    const s = seat();
    s.hook(T2, "resume");
    s.hook(T3, "clear");
    expect(s.row()).toMatchObject({ resume_token: T3, resume_source: "clear", resume_rotated_from: null });
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("an operator token, or any other write that changes the token, drops the record", () => {
    const s = seat();
    s.hook(T2, "resume");
    s.registry.updateResumeToken(s.session.id, "claude_id", T3, "operator");
    expect(s.row()).toMatchObject({ resume_token: T3, resume_provenance: "operator", resume_source: null, resume_rotated_from: null });
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("an equal-value refresh by another writer keeps the record", () => {
    const s = seat();
    s.hook(T2, "resume");
    s.registry.updateResumeToken(s.session.id, "claude_id", T2, "hook");
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
  });

  it("a hook the provenance rank refuses records nothing", () => {
    const s = seat();
    s.registry.updateResumeToken(s.session.id, "claude_id", T1, "operator");
    expect(s.hook(T2, "resume")).toBe(false);
    expect(s.row()).toMatchObject({ resume_token: T1, resume_source: null, resume_rotated_from: null });
  });
});

describe("a resume hook that lands before the launch records its token", () => {
  // Claude's SessionStart can fire while the launch is still settling, before any launch path writes
  // T1 (or, on an attention or legacy path, without one ever writing it). The launch token, recorded
  // before the launch, is what the hook names then.
  const early = () => {
    const s = seat({ launched: false });
    s.registry.recordResumeLaunch(s.session.id, T1);
    return s;
  };

  it("names the launch token the resume replaced", () => {
    const s = early();
    s.hook(T2, "resume");
    expect(s.row()).toEqual({ resume_token: T2, resume_provenance: "hook", resume_source: "resume", resume_rotated_from: T1 });
    expect(s.registry.claudeResumeRotatedFrom(s.session.id, T1)).toBe(true);
  });

  it("a later launch-path write of T1 loses to the hook and leaves the record", () => {
    const s = early();
    s.hook(T2, "resume");
    s.registry.updateResumeToken(s.session.id, "claude_id", T1, "scrape");
    s.registry.recordResumeAttempt(s.session.id, "claude_id", T1);
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
  });

  it.each(["clear", "startup", "compact", null])("an early hook with source %s names nothing", (source) => {
    const s = early();
    s.hook(T2, source);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_rotated_from: null });
    expect(s.registry.claudeResumeRotatedFrom(s.session.id, T1)).toBe(false);
  });

  it("an early hook for a stale generation names nothing", () => {
    const s = early();
    s.hook(T2, "resume", false);
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("an early resume hook that kept the id needs no rotation", () => {
    const s = early();
    s.hook(T1, "resume");
    expect(s.row()).toMatchObject({ resume_token: T1, resume_source: null, resume_rotated_from: null });
  });

  it("a stored token outranks the launch token as what the resume replaced", () => {
    const s = seat();
    s.registry.recordResumeLaunch(s.session.id, T3);
    s.hook(T2, "resume");
    expect(s.row()).toMatchObject({ resume_token: T2, resume_rotated_from: T1 });
  });

  it("a fresh launch records no launch token", () => {
    const s = seat({ launched: false });
    s.registry.recordResumeLaunch(s.session.id, T1);
    s.registry.recordResumeLaunch(s.session.id, null);
    s.hook(T2, "resume");
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("one hop: a /clear and a later in-process resume name the cleared conversation, not the launch", () => {
    const s = early();
    s.hook(T2, "clear");
    s.hook(T3, "resume");
    expect(claudeRotatedFromToken(s.row())).toBe(T2);
    expect(s.registry.claudeResumeRotatedFrom(s.session.id, T1)).toBe(false);
  });
});

describe("the relay forwards the evidence", () => {
  it("sends SessionStart's source and the seat's occupant generation with the session id", () => {
    const payload = relay.buildSessionIdentityPayload(
      { hook_event_name: "SessionStart", session_id: T2, source: "resume" },
      { OPENRIG_SESSION_NAME: "dev-impl@rotation", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "gen-1" },
    );
    expect(payload).toMatchObject({ eventFamily: "session_identity", sessionId: T2, source: "resume", generation: "gen-1" });
  });

  it("sends nulls when the runtime or launch did not provide them", () => {
    const payload = relay.buildSessionIdentityPayload(
      { hook_event_name: "SessionStart", session_id: T2 },
      { OPENRIG_SESSION_NAME: "dev-impl@rotation", OPENRIG_RUNTIME: "claude-code" },
    );
    expect(payload).toMatchObject({ sessionId: T2, source: null, generation: null });
  });
});

describe("the identity proof", () => {
  const startedAt = "Fri Oct  9 01:00:00 2026";
  const rows = (argvToken: string): NativeProcessRow[] => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude --resume ${argvToken}`, startedAt },
  ];
  const tmux = { getPanePid: async () => 100 };
  const proof = (argvToken: string, rotatedFromToken: string | null) => ({
    target: "%1", tmux, listProcesses: async () => rows(argvToken), expectedToken: T2, rotatedFromToken,
  });

  it("accepts the launch token a resume replaced", async () => {
    expect(await verifyClaudePaneProcess(proof(T1, T1))).not.toBeNull();
    expect(await observeClaudeDelivery(proof(T1, T1))).toMatchObject({ state: "verified" });
  });

  it("still accepts the stored token itself", async () => {
    expect(await verifyClaudePaneProcess(proof(T2, T1))).not.toBeNull();
  });

  it("refuses the launch token without a recorded resume (the /clear case)", async () => {
    expect(await verifyClaudePaneProcess(proof(T1, null))).toBeNull();
    expect(await observeClaudeDelivery(proof(T1, null))).toMatchObject({ state: "unknown" });
  });

  it("refuses a third token even with a recorded resume", async () => {
    expect(await verifyClaudePaneProcess(proof(T3, T1))).toBeNull();
    expect(await observeClaudeDelivery(proof(T3, T1))).toMatchObject({ state: "unknown" });
  });
});
