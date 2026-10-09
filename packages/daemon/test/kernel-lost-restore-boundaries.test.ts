// #1078 — boundaries of a manual `rig up kernel --existing` while daemon start restores the kernel:
// non-interruptive choices and plans are not merged, a failed automatic restore is reported as such,
// and a request made after an operator corrected a seat's token (a changed current target) takes
// the ordinary path instead of joining. Contributed by dev-review in its review of bc72e6bf.

import { describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { bootKernelIfNeeded } from "../src/domain/kernel-boot.js";
import { restoreExistingRigUnattended, chooseRestoreSnapshot } from "../src/domain/existing-rig-restore.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

describe("real automatic kernel restore and manual-up race", () => {
  it.each(["auto-first-nonintr-true", "auto-first-nonintr-false", "auto-first-plan", "auto-failed", "auto-occupant-changed"])("restores once: %s", async mode => {
    const db = createFullTestDb();
    const name = "operator-agent@kernel", token = "00000000-0000-4000-8000-000000001078";
    const live = new Set([name]);
    let entered!: () => void, release!: () => void;
    const atLaunch = new Promise<void>(r => { entered = r; });
    const launchGate = new Promise<void>(r => { release = r; });
    const tmux = {
      hasSession: vi.fn(async (n: string) => live.has(n)),
      probeSession: vi.fn(async (n: string) => ({ state: live.has(n) ? "present" : "absent" })),
      listSessions: vi.fn(async () => [...live].map(name => ({ name }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => [{ id: "%1078", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 100),
      getPaneCommand: vi.fn(async () => "sh"),
      capturePaneContent: vi.fn(async () => "Claude Code\n❯ accept edits on"),
      createSession: vi.fn(async (n: string) => { if(mode!=="auto-occupant-changed") { entered(); await launchGate; } if(mode === "auto-failed") return {ok:false,error:"fixture launch refused"}; live.add(n); return { ok: true }; }),
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
      launchHarness: async () => { if(mode==="auto-occupant-changed") {entered(); await launchGate;} return { ok: true, resumeType: "claude_id", resumeToken: token }; },
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
    if (mode !== "auto-rehydrate") snapshotCapture.captureSnapshot(rig.id, "manual");
    live.clear();
    await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(rig.id);
    let automatic!: Promise<{ errors: string[] }>;
    const boot = () => bootKernelIfNeeded({ rigRepo, sessionRegistry, eventBus, bootstrapOrchestrator: setup.bootstrapOrchestrator,
      specsDir: "/tmp", cwdOverride: "/tmp", degradedTimeoutMs: 0, probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }), log: () => {},
      restoreLostKernel: rigId => automatic = restoreExistingRigUnattended({ rigRepo, snapshotRepo, snapshotCapture, restoreOrchestrator,
        runtimeAdapters: { "claude-code": adapter } as never }, rigId, () => true),
    });
    const up = (extra: Record<string, unknown> = {}) => app.request("/api/up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceRef: "kernel", ...extra }) });
    let tracker;
    try {
      if (mode === "manual-first") {
        const manual = up();
        await atLaunch;
        tracker = await boot();
        expect(automatic).toBeUndefined();
        expect(tracker.getStatus().kernelState).toBe("skipped");
        release();
        const result = await manual;
        expect(result.status, JSON.stringify(await result.clone().json())).toBe(200);
        expect(await result.json()).toMatchObject({ rigResult: "fully_restored" });
      } else {
        tracker = await boot();
        expect(tracker.getStatus().kernelState).toBe("booting");
        await atLaunch;
        if (mode === "auto-occupant-changed") {
          // The operator corrects the target token while automatic launch awaits I/O.
          const corrected = await app.request(`/api/sessions/${encodeURIComponent(name)}/resume-token`, {
            method:"POST", headers:{"content-type":"application/json"},
            body:JSON.stringify({token:"00000000-0000-4000-8000-000000001079",reason:"correct the current restore target"}) });
          expect(corrected.status,JSON.stringify(await corrected.clone().json())).toBe(200);
          const choice=chooseRestoreSnapshot({rigRepo,snapshotRepo,snapshotCapture,restoreOrchestrator},rig.id);
          expect(choice).toMatchObject({ok:true,staleSnapshot:true,snapshot:null});
          console.log(JSON.stringify({phase:"before manual",rows:sessionRegistry.getSessionsForRig(rig.id).map(s=>({id:s.id,status:s.status,token:s.resumeToken})),choice:choice.ok?{staleSnapshot:choice.staleSnapshot,snapshotId:choice.snapshot?.id}:choice}));
          let settled = false;
          const manual = up().then(response => { settled=true; return response; });
          await new Promise<void>(r=>setTimeout(r,20));
          const settledWhileHeld = settled;
          release();
          const response = await manual;
          const body = await response.json();
          console.log(JSON.stringify({mode,settledWhileHeld,status:response.status,body}));
          expect.soft(response.status).toBeGreaterThanOrEqual(400);
          expect.soft(JSON.stringify(body.warnings ?? [])).not.toContain("no second restore");
          expect.soft(body.rigResult).not.toBe("fully_restored");
        } else if (mode === "auto-first-plan") {
          const snapshotsBefore=db.prepare("SELECT COUNT(*) AS n FROM snapshots").get();
          const response=await up({plan:true});
          const body=await response.json();
          expect(response.status).toBe(200); expect(body).toMatchObject({status:"plan",mutated:false});
          if(snapshotsBefore) expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()).toEqual(snapshotsBefore);
          release();
        } else if (mode.startsWith("auto-first-nonintr")) {
          // A request for a different restore is not merged into the running one.
          const collision = await up({ nonInterruptive: mode === "auto-first-nonintr-true" });
          expect(collision.status).toBe(400);
          expect(await collision.json()).toMatchObject({ code: "restore_in_progress" });
          release();
        } else {
          // The same restore, asked for by hand: it waits for the running one instead of colliding.
          let settled = false;
          const manual = up().then((response) => { settled = true; return response; });
          await new Promise<void>(r => setTimeout(r, 20));
          expect(settled).toBe(false);
          release();
          const response = await manual;
          const body = await response.json();
          expect(response.status, JSON.stringify(body)).toBe(200);
          expect(body).toMatchObject({ status: "restored", rigResult: mode === "auto-failed" ? "failed" : "fully_restored" });
          expect(body.warnings[0]).toContain("no second restore was started");
          expect(JSON.stringify(body)).not.toMatch(/rig down|guard_target_changed|rig_not_stopped/);
        }
        const autoResult=await automatic; if(mode === "auto-failed") expect(autoResult.errors.length).toBeGreaterThan(0); else if(mode!=="auto-occupant-changed") expect(autoResult).toEqual({errors:[]});
      }
      await new Promise<void>(r => setImmediate(r));
      const status = tracker.getStatus();
      if(mode!=="auto-occupant-changed") expect(status.kernelState).toBe(mode === "auto-failed" ? "bootstrap_failed" : "ready");
      expect(tmux.createSession).toHaveBeenCalledTimes(1);
      if(mode!=="auto-occupant-changed") expect(sessionRegistry.getSessionsForRig(rig.id).filter(s => s.status === "running")).toHaveLength(mode === "auto-failed" ? 0 : 1);
      if (mode === "auto-rehydrate") {
        expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE kind = 'auto-rehydrate'").get()).toEqual({ n: 1 });
      }
    } finally { release(); tracker?.stop(); db.close(); }
  });
});
