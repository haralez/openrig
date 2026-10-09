import { Hono } from "hono";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #1077 maintainer review of 6266c2fa (pull/1080#issuecomment-6089024117): a recorded rotation
// T1 -> T2 vouches only for the process whose first hook qualified it. After the rotation is
// recorded, a different process started on T1 (a replacement), or a deeper Claude under the
// qualified one naming a third conversation, must leave identity, clear-attention, send and
// strict restore unproved, as on main. Real teardown, restore, hook and clear-attention routes,
// identity reconcile and SessionTransport; native observations are fixtures. The recorded process
// is checked by pid and start time.

// Shape of Fleet's Claude 2.1.220 auto-mode screen after full down/up:
// the header has scrolled out; the empty prompt and mode footer remain.
const autoScreen = "Restored conversation\n────────────────\n❯\u00a0\n────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n   ✘ Auto-update failed: no write permission to npm prefix · Run claude doctor\n  ● high · /effort\n";
// With the pane labelled claude and Claude's TUI header on screen, strict restore rests on the
// process-lineage search alone.
const tuiScreen = "Claude Code\n❯ \n";
const token = "00000000-0000-4000-8000-000000000006";
const third = "00000000-0000-4000-8000-000000000003";

describe("a recorded Claude resume rotation after the qualifying process", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  // first-hook: the launch's first hook arrives while restore runs. late-hook: that post was lost
  // and the relay's claim file removed, so a later post from the same process counts as first.
  it.each([
    ["first-hook", "same"], ["late-hook", "same"],
    ["first-hook", "replaced"], ["late-hook", "replaced"],
    ["first-hook", "deeper-third"],
  ] as const)("%s, then %s process", async (hookTiming, after) => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("restore-test");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("restore-pod", rig.id, "Test");
    const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code", podId: "restore-pod" });
    new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "auto" }, "fixture", "retained Fleet posture");
    const name = "test-c@restore-test";
    const old = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(old.id, "running");
    sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const rotated = "00000000-0000-4000-8000-000000001077";
    const activity = new AgentActivityStore({ db, eventBus });
    const hooks = new Hono();
    hooks.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, tmux as never);
      c.set("listProcesses" as never, hookProcesses as never);
      c.set("agentActivityStore" as never, activity as never);
      c.set("activityHookToken" as never, "fixture" as never);
      c.set("sessionRegistry" as never, sessionRegistry as never);
      c.set("eventBus" as never, eventBus as never);
      await next();
    });
    hooks.route("/api/activity", activityRoutes);
    const row = () => db.prepare("SELECT id, resume_token, resume_provenance, resume_rotated_from, startup_status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(node.id) as Record<string, unknown>;
    const hook = async () => {
      const response = await hooks.request("/api/activity/hooks", { method: "POST",
        headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" },
        body: JSON.stringify({ eventFamily: "session_identity", hookEvent: "SessionStart", sessionName: name, nodeId: node.id,
          runtime: "claude-code", generation: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid,
          source: "resume", resumeLaunch: launchMarker, resumeLaunchFirst: true, hookPid: 111, sessionId: rotated }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ tokenPersisted: true });
    };
    let launchMarker: string | undefined;
    const launched = (cmd: string) => { launchMarker = /OPENRIG_RESUME_LAUNCH='?([^' ]+)/.exec(cmd)?.[1]; };
    let live = true;
    const tmux = {
      hasSession: vi.fn(async () => live),
      probeSession: vi.fn(async () => ({ state: live ? "present" : "absent" })),
      killSession: vi.fn(async () => { live = false; return { ok: true }; }),
      createSession: vi.fn(async () => { live = true; return { ok: true }; }),
      listSessions: vi.fn(async () => live ? [{ name }] : []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => ["%new"].map(id => ({ id, index: 0, cwd: "/", width: 80, height: 24, active: true }))),
      getPanePid: vi.fn(async () => 100),
      getPaneCommand: vi.fn(async () => phase === "after" && after.startsWith("deeper") ? "claude" : "sh"),
      capturePaneContent: vi.fn(async () => phase === "after" && after.startsWith("deeper") ? tuiScreen : autoScreen),
      sendText: vi.fn(async (_session: string, cmd: string) => { launched(cmd); return { ok: true }; }),
      sendShellCommand: vi.fn(async (_session: string, cmd: string) => { launched(cmd); if (hookTiming === "first-hook") await hook(); return { ok: true }; }),
      sendKeys: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapter;
    const startedAt = "Thu Oct  1 05:53:16 2026";
    // Native observations are unavailable while restore runs, so the seat ends in attention and
    // recovers only through clear-attention's strict restore reconcile.
    let phase: "restoring" | "launched" | "after" = "restoring";
    const claude = (pid: number, ppid: number, conversation: string, began: string) =>
      ({ pid, ppid, pgid: 101, tpgid: 101, executableName: "claude", command: `/opt/claude.exe --permission-mode auto --resume ${conversation} --name ${name}`, startedAt: began });
    const paneRows = () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /tmp/fixture-launch.txt", startedAt },
      ...(phase === "after" && after === "replaced"
        ? [claude(202, 101, token, "Thu Oct  1 06:10:00 2026")]
        : [claude(102, 101, token, startedAt)]),
      ...(phase === "after" && after === "deeper-third" ? [claude(103, 102, third, "Thu Oct  1 06:10:00 2026")] : []),
    ];
    const listProcesses = async () => phase === "restoring" ? [] : paneRows();
    // The relay of a SessionStart hook runs under the launched Claude (102) through a shell.
    const hookProcesses = async () => [...paneRows(),
      { pid: 110, ppid: 102, pgid: 110, tpgid: 101, executableName: "sh", command: "/bin/sh -c node relay.cjs", startedAt },
      { pid: 111, ppid: 110, pgid: 110, tpgid: 101, executableName: "node", command: "node relay.cjs", startedAt }];
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
    expect(down.errors).toEqual([]);
    const managed = { prepare: async () => ({ command: (args: readonly string[], env: Record<string, string> = {}) => [...Object.entries(env).map(([k, v]) => `${k}=${v}`), "claude", ...args].join(" "), assertCurrent: () => {}, configDir: "/fixture", executable: "/opt/claude.exe" }) } as unknown as ClaudeManagedLaunch;
    const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {}, claudeManagedLaunch: managed,
      fsOps: { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} } });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux, { listProcesses, maxWaitMs: 0, sleep: async () => {}, claudeManagedLaunch: managed }),
      codexResume: new CodexResumeAdapter(tmux), listProcesses });
    const up = await restore.restore(down.snapshotId!, { adapters: { "claude-code": adapter } });
    expect(up.ok).toBe(true);
    if (!up.ok) throw new Error(up.message);
    expect(up.result.nodes[0].status).toBe("attention_required");
    phase = "launched";
    if (hookTiming === "late-hook") await hook();
    // The rotation is recorded against the process that qualified it, before anything changes.
    expect(row()).toMatchObject({ resume_token: rotated, resume_provenance: "hook", resume_rotated_from: token });
    phase = "after";
    await new SeatIdentityReconciler({ db, tmux, listProcesses }).reconcileAll();
    const identity = new SeatIdentityStore(db).getForNode(node.id);
    const clear = new SeatAttentionReconciler({ db, sessionRegistry, eventBus, agentActivityStore: activity, tmux, listProcesses,
      reconcileRestoreOutcome: (rigId, nodeId) => restore.reconcileNodeRuntimeTruth(rigId, nodeId),
      sendVerify: async () => { throw new Error("unexpected input from clear-attention"); } });
    const admin = new Hono();
    admin.use("*", async (c, next) => {
      c.set("seatAttentionReconciler" as never, clear as never);
      c.set("terminalBearerToken" as never, "fixture" as never); await next();
    });
    admin.route("/api/sessions", sessionAdminRoutes);
    const cleared = await admin.request(`/api/sessions/${encodeURIComponent(name)}/clear-attention`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" }, body: "{}" });
    const clearBody = await cleared.json();
    const strict = await restore.reconcileNodeRuntimeTruth(rig.id, node.id);
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
    const sent = await transport.send(name, "isolated QA restore message");
    const warning = String((sent as { warning?: string }).warning ?? "");
    const same = after === "same";
    expect(cleared.status, JSON.stringify(clearBody)).toBe(same ? 200 : 422);
    expect(strict.ok, JSON.stringify(strict)).toBe(same);
    if (after === "deeper-third") {
      // The pane label and screen are main's own evidence (no rotation involved), so only the
      // restore proof is in question here; two Claude conversations are a delivery conflict.
      expect(strict).toMatchObject({ code: "process_lineage_mismatch" });
      expect(sent.ok && !warning).toBe(false);
      return;
    }
    expect(identity?.verdict, JSON.stringify(identity)).toBe(same ? "verified" : "mismatch");
    expect(sent.ok).toBe(true);
    expect(warning.includes("without verified native identity")).toBe(!same);
  });
});
