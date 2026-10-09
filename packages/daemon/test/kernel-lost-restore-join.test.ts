// #1078 — what a manual `rig up kernel --existing` does while daemon start is restoring the kernel.
// The same restore waits for the running one and reports its outcome; a request for something else
// (non-interruptive choice, plan) or for a target that has changed since (an operator's token
// correction, with or without a new snapshot) is not merged. Real SQLite, reconcile, restore and HTTP
// routes; terminal and provider I/O are fixtures, with the automatic launch held at a gate.
// Derived from dev-review's boundary reproductions in its reviews of bc72e6bf and 0bd8f934.

import { describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { bootKernelIfNeeded } from "../src/domain/kernel-boot.js";
import { restoreExistingRigUnattended } from "../src/domain/existing-rig-restore.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const name = "operator-agent@kernel";
const token = "00000000-0000-4000-8000-000000001078";
const corrected = "00000000-0000-4000-8000-000000001079";

/** A lost kernel whose automatic restore is held: before tmux creates the session (`at: "create"`),
 *  or once the new session row exists and the runtime is launching (`at: "launch"`). */
async function heldRestore(opts: { at: "create" | "launch"; launchFails?: boolean }) {
  const db = createFullTestDb();
  const live = new Set([name]);
  let entered!: () => void, release!: () => void;
  const atGate = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const tmux = {
    hasSession: vi.fn(async (n: string) => live.has(n)),
    probeSession: vi.fn(async (n: string) => ({ state: live.has(n) ? "present" : "absent" })),
    listSessions: vi.fn(async () => [...live].map(name => ({ name }))),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%1078", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 100),
    getPaneCommand: vi.fn(async () => "sh"),
    capturePaneContent: vi.fn(async () => "Claude Code\n❯ accept edits on"),
    createSession: vi.fn(async (n: string) => {
      if (opts.at === "create") { entered(); await gate; }
      if (opts.launchFails) return { ok: false, error: "fixture launch refused" };
      live.add(n);
      return { ok: true };
    }),
    killSession: vi.fn(async (n: string) => { live.delete(n); return { ok: true }; }),
    setSessionOption: vi.fn(async () => ({ ok: true })),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  const listProcesses = async () => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt: "fixture-start" },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude --resume ${token}`, startedAt: "fixture-start" },
  ];
  const adapter = {
    runtime: "claude-code",
    project: async () => ({ applied: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: [], skipped: [], failed: [] }),
    launchHarness: async () => {
      if (opts.at === "launch") { entered(); await gate; }
      return { ok: true, resumeType: "claude_id", resumeToken: token };
    },
    checkReady: async () => ({ ready: true }),
  };
  const setup = createTestApp(db, { tmux, listProcesses, adapters: { "claude-code": adapter } as never });
  const { rigRepo, sessionRegistry, snapshotRepo, snapshotCapture, restoreOrchestrator, eventBus, app } = setup;
  const rig = rigRepo.createRig("kernel");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod1078", rig.id, "Kernel");
  const node = rigRepo.addNode(rig.id, "operator.agent", { runtime: "claude-code", cwd: "/tmp", podId: "pod1078" });
  const old = sessionRegistry.registerSession(node.id, name);
  sessionRegistry.updateStatus(old.id, "running");
  sessionRegistry.updateStartupStatus(old.id, "ready");
  sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
  sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1078" });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
    .run(node.id, "[]", "[]", "[]", "claude-code");
  snapshotCapture.captureSnapshot(rig.id, "manual");
  live.clear();
  await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(rig.id);

  let automatic!: Promise<{ errors: string[] }>;
  const tracker = await bootKernelIfNeeded({ rigRepo, sessionRegistry, eventBus, bootstrapOrchestrator: setup.bootstrapOrchestrator,
    specsDir: "/tmp", cwdOverride: "/tmp", degradedTimeoutMs: 0, probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }), log: () => {},
    restoreLostKernel: rigId => automatic = restoreExistingRigUnattended({ rigRepo, snapshotRepo, snapshotCapture, restoreOrchestrator,
      runtimeAdapters: { "claude-code": adapter } as never }, rigId, () => true),
  });
  expect(tracker.getStatus().kernelState).toBe("booting");
  await atGate;

  const post = (path: string, body: Record<string, unknown>) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const up = (extra: Record<string, unknown> = {}) => post("/api/up", { sourceRef: "kernel", ...extra });
  /** A manual up made while the launch is held: whether it settled before release, then its answer. */
  const upWhileHeld = async () => {
    let settled = false;
    const manual = up().then((response) => { settled = true; return response; });
    await new Promise<void>(r => setTimeout(r, 20));
    const settledWhileHeld = settled;
    release();
    const response = await manual;
    return { settledWhileHeld, status: response.status, body: await response.json() };
  };
  const finish = async () => {
    release();
    await automatic;
    await new Promise<void>(r => setImmediate(r));
  };
  const close = () => { release(); tracker.stop(); db.close(); };
  return { db, tmux, rig, tracker, post, up, upWhileHeld, finish, close, automatic: () => automatic, snapshots: () =>
    (db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n };
}

describe("manual up while daemon start restores the kernel", () => {
  it.each([true, false])("a non-interruptive choice (%s) is not merged", async (nonInterruptive) => {
    const h = await heldRestore({ at: "create" });
    try {
      const collision = await h.up({ nonInterruptive });
      expect(collision.status).toBe(400);
      expect(await collision.json()).toMatchObject({ code: "restore_in_progress" });
      await h.finish();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it("a plan stays read-only and is not merged", async () => {
    const h = await heldRestore({ at: "create" });
    try {
      const before = h.snapshots();
      const response = await h.up({ plan: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "plan", mutated: false });
      expect(h.snapshots()).toBe(before);
      await h.finish();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it("a failed automatic restore is the joined request's outcome, without rig down advice", async () => {
    const h = await heldRestore({ at: "create", launchFails: true });
    try {
      const joined = await h.upWhileHeld();
      expect(joined.settledWhileHeld).toBe(false);
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(joined.body).toMatchObject({ status: "restored", rigResult: "failed" });
      expect(joined.body.warnings[0]).toContain("no second restore was started");
      expect(JSON.stringify(joined.body)).not.toMatch(/rig down|guard_target_changed|rig_not_stopped/);
      expect((await h.automatic()).errors.length).toBeGreaterThan(0);
      await new Promise<void>(r => setImmediate(r));
      expect(h.tracker.getStatus().kernelState).toBe("bootstrap_failed");
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });

  it.each([
    ["an operator's token correction", corrected, false, false],
    ["a token correction and a new snapshot of it", corrected, true, false],
    ["the same token and a new snapshot", token, true, true],
  ] as const)("after %s: joins only for the same target", async (_label, attested, snapshot, joins) => {
    const h = await heldRestore({ at: "launch" });
    try {
      const correction = await h.post(`/api/sessions/${encodeURIComponent(name)}/resume-token`,
        { token: attested, reason: "correct the current restore target" });
      expect(correction.status, JSON.stringify(await correction.clone().json())).toBe(200);
      if (snapshot) expect((await h.post(`/api/rigs/${h.rig.id}/snapshots`, { kind: "manual" })).status).toBe(201);
      const answer = await h.upWhileHeld();
      if (joins) {
        expect(answer.settledWhileHeld).toBe(false);
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect(answer.body).toMatchObject({ status: "restored", rigResult: "fully_restored" });
        expect(answer.body.warnings[0]).toContain("no second restore was started");
      } else {
        expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(answer.body.warnings ?? [])).not.toContain("no second restore");
      }
      await h.finish();
      expect(h.tmux.createSession).toHaveBeenCalledTimes(1);
    } finally { h.close(); }
  });
});
