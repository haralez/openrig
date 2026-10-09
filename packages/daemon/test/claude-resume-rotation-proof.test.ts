// #1077 — a resumed Claude seat whose session id changes. OpenRig launched the seat with
// `--resume T1`, Claude continued as T2 and its SessionStart hook recorded T2. The proof accepts T1
// in argv only when the first current-generation hook after that launch said `source: resume`.
// Every other hook (a /clear, startup or compaction, no source, a stale generation, and anything
// after the first) keeps today's refusal.

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function seat(opts: { armed?: boolean; launchWrite?: boolean } = {}) {
  const db = createDb(); databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = rigRepo.createRig("rotation");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const session = registry.registerSession(node.id, "dev-impl@rotation");
  // OpenRig arms the launch before starting `claude --resume T1` (startup-orchestrator, legacy restore).
  if (opts.armed !== false) registry.recordResumeLaunch(session.id, T1);
  // The launch path may write T1 afterwards (provenance scrape); the hook can also land first.
  if (opts.launchWrite !== false) registry.updateResumeToken(session.id, "claude_id", T1, "scrape");
  const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
  const row = () => db.prepare(
    "SELECT resume_token, resume_provenance, resume_launch_token, resume_rotated_from FROM sessions WHERE id = ?",
  ).get(session.id) as { resume_token: string; resume_provenance: string; resume_launch_token: string | null; resume_rotated_from: string | null };
  // By default the hook comes from the process OpenRig launched, whose command carried the marker.
  const hook = (token: string, source: string | null, currentGeneration = true, resumeLaunch: string | null = T1, launchedProcess = true) =>
    registry.recordHookSessionIdentity(session.id, "claude_id", token, { source, currentGeneration, resumeLaunch, launchedProcess });
  return { db, registry, session, node, generation, row, hook };
}

describe("the first hook after OpenRig's --resume launch", () => {
  it.each([true, false])("a resume into a new id names the launch token (launch wrote T1 first: %s)", (launchWrite) => {
    const s = seat({ launchWrite });
    expect(s.hook(T2, "resume")).toBe(true);
    expect(s.row()).toEqual({ resume_token: T2, resume_provenance: "hook", resume_launch_token: null, resume_rotated_from: T1 });
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
    expect(s.registry.claudeResumeRotatedFrom(s.session.id, T1)).toBe(true);
  });

  it.each(["clear", "startup", "compact", null])("source %s consumes the launch and names nothing", (source) => {
    const s = seat();
    s.hook(T2, source);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_launch_token: null, resume_rotated_from: null });
    // A resume after that (in-process /resume, a child `claude -p --resume`) has no launch to name.
    s.hook(T3, "resume");
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("a resume that kept the id consumes the launch; a later in-process /resume names nothing", () => {
    const s = seat();
    s.hook(T1, "resume");
    expect(s.row()).toMatchObject({ resume_token: T1, resume_launch_token: null, resume_rotated_from: null });
    s.hook(T2, "resume");
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it.each([
    ["a Claude started by hand in the pane (no marker), or a relay that predates it", null],
    ["a marker naming another launch", T3],
  ] as const)("%s consumes the launch and names nothing", (_label, marker) => {
    const s = seat();
    s.hook(T2, "resume", true, marker);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_launch_token: null, resume_rotated_from: null });
    s.hook(T3, "resume");
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("a hook not observed to come from the launched process (a child claude -p inheriting the marker) names nothing", () => {
    const s = seat();
    s.hook(T2, "resume", true, T1, false);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_launch_token: null, resume_rotated_from: null });
  });

  it("a stale-generation hook neither qualifies nor consumes the launch", () => {
    const s = seat();
    s.hook(T3, "resume", false);
    expect(s.row()).toMatchObject({ resume_launch_token: T1, resume_rotated_from: null });
    s.hook(T2, "resume");
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
  });

  it("a hook the provenance rank refuses still consumes the launch and records nothing", () => {
    const s = seat();
    s.registry.updateResumeToken(s.session.id, "claude_id", T1, "operator");
    expect(s.hook(T2, "resume")).toBe(false);
    expect(s.row()).toMatchObject({ resume_token: T1, resume_launch_token: null, resume_rotated_from: null });
  });

  it("without an armed launch (fresh, or a process OpenRig did not launch) nothing qualifies", () => {
    const fresh = seat({ armed: false });
    fresh.hook(T2, "resume");
    expect(claudeRotatedFromToken(fresh.row())).toBeNull();
    const freshFallback = seat();
    freshFallback.registry.recordResumeLaunch(freshFallback.session.id, null);
    freshFallback.hook(T2, "resume");
    expect(claudeRotatedFromToken(freshFallback.row())).toBeNull();
  });
});

describe("after a recorded rotation", () => {
  const rotated = () => {
    const s = seat();
    s.hook(T2, "resume");
    return s;
  };

  it.each([
    ["an in-process /resume", "resume"],
    ["a child claude -p --resume sharing the seat's environment", "resume"],
    ["a /clear", "clear"],
  ] as const)("%s drops it and names nothing new", (_label, source) => {
    const s = rotated();
    s.hook(T3, source);
    expect(s.row()).toMatchObject({ resume_token: T3, resume_rotated_from: null });
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("a later hook for the same id (a compaction) keeps it", () => {
    const s = rotated();
    s.hook(T2, "compact");
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
  });

  it("an operator token, or any other write that changes the token, drops it", () => {
    const s = rotated();
    s.registry.updateResumeToken(s.session.id, "claude_id", T3, "operator");
    expect(s.row()).toMatchObject({ resume_token: T3, resume_provenance: "operator", resume_rotated_from: null });
    expect(claudeRotatedFromToken(s.row())).toBeNull();
  });

  it("an equal-value refresh or a later launch-path write of T1 keeps it", () => {
    const s = rotated();
    s.registry.updateResumeToken(s.session.id, "claude_id", T2, "hook");
    s.registry.updateResumeToken(s.session.id, "claude_id", T1, "scrape");
    s.registry.recordResumeAttempt(s.session.id, "claude_id", T1);
    expect(claudeRotatedFromToken(s.row())).toBe(T1);
  });
});

describe("the relay forwards the evidence", () => {
  it("sends SessionStart's source, the occupant generation and the launch marker with the session id", () => {
    const payload = relay.buildSessionIdentityPayload(
      { hook_event_name: "SessionStart", session_id: T2, source: "resume" },
      { OPENRIG_SESSION_NAME: "dev-impl@rotation", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "gen-1",
        OPENRIG_RESUME_LAUNCH: T1 },
    );
    expect(payload).toMatchObject({ eventFamily: "session_identity", sessionId: T2, source: "resume", generation: "gen-1", resumeLaunch: T1,
      hookPid: process.pid });
  });

  it("claims the launch's first SessionStart once, on disk, per launch token and generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-relay-claim-"));
    try {
      expect(relay.claimFirstLaunchHook(T1, "gen-1", dir)).toBe(true);
      // A later hook of the same launch (in-process /resume, a child) finds it claimed.
      expect(relay.claimFirstLaunchHook(T1, "gen-1", dir)).toBe(false);
      expect(relay.claimFirstLaunchHook(T1, "gen-2", dir)).toBe(true);
      expect(relay.claimFirstLaunchHook(null, "gen-1", dir)).toBe(false);
      expect(relay.claimFirstLaunchHook(T1, null, dir)).toBe(false);
      // An unwritable record never reads as first.
      expect(relay.claimFirstLaunchHook(T2, "gen-1", join(dir, "missing\0dir"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("sends nulls when the runtime or launch did not provide them", () => {
    const payload = relay.buildSessionIdentityPayload(
      { hook_event_name: "SessionStart", session_id: T2 },
      { OPENRIG_SESSION_NAME: "dev-impl@rotation", OPENRIG_RUNTIME: "claude-code" },
    );
    expect(payload).toMatchObject({ sessionId: T2, source: null, generation: null, resumeLaunch: null });
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
