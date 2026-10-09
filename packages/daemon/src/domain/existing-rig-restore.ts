// Restoring an existing rig from its latest restore-usable snapshot: what `rig up <rig> --existing`
// does (routes/up.ts), and what daemon start does for a kernel that a reboot left down (kernel-boot.ts).
// One copy, so the two cannot choose snapshots differently.

import { summarizeSnapshot, type SnapshotRepository } from "./snapshot-repository.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { RestoreOrchestrator } from "./restore-orchestrator.js";
import type { RigRepository } from "./rig-repository.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { RestoreSnapshotSelection, Snapshot } from "./types.js";
import { assessCurrentStateRehydrateEligibility, snapshotMatchesCurrentOccupants } from "./rehydrate-eligibility.js";

export interface ExistingRigRestoreDeps {
  rigRepo: RigRepository;
  snapshotRepo: SnapshotRepository;
  snapshotCapture: SnapshotCapture;
  restoreOrchestrator?: RestoreOrchestrator;
  runtimeAdapters?: Record<string, RuntimeAdapter>;
}

type Rig = NonNullable<ReturnType<RigRepository["getRig"]>>;

export type RestoreSnapshotChoice =
  | { ok: true; rig: Rig; snapshot: Snapshot | null; snapshotSelection: RestoreSnapshotSelection | undefined; staleSnapshot: boolean }
  | { ok: false; status: 404; body: { error: string; code: "rig_not_found" | "no_snapshot"; blockers?: unknown } };

/** L3b: prefers `auto-pre-down` when present but falls back to the latest manual snapshot whose
 *  structural metadata satisfies `RestoreOrchestrator.restore`'s pre-validation. A snapshot naming an
 *  older occupant is not used. `snapshot: null` means current DB state is eligible for rehydrate. */
export function chooseRestoreSnapshot(deps: ExistingRigRestoreDeps, rigId: string): RestoreSnapshotChoice {
  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) {
    return { ok: false, status: 404, body: { error: `Rig ${rigId} not found`, code: "rig_not_found" } };
  }
  const automaticSelection = deps.snapshotRepo.selectRestoreUsable(rigId);
  let snapshot = automaticSelection.ok ? automaticSelection.snapshot : null;
  let snapshotSelection = automaticSelection.ok ? automaticSelection.selection : undefined;
  let staleSnapshot = false;
  if (snapshot && !snapshotMatchesCurrentOccupants(deps.snapshotRepo.db, rig, snapshot)) {
    snapshot = null;
    snapshotSelection = undefined;
    staleSnapshot = true;
  }
  if (!snapshot) {
    const eligibility = assessCurrentStateRehydrateEligibility(deps.snapshotRepo.db, rig);
    if (!eligibility.ok) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `Rig exists but ${staleSnapshot ? "its restore snapshots name an older occupant" : "has no restore-usable snapshot"} and current DB state is insufficient for rehydrate. Start fresh with: rig up <spec-path>`,
          code: "no_snapshot",
          blockers: eligibility.blockers,
        },
      };
    }
  }
  return { ok: true, rig, snapshot, snapshotSelection, staleSnapshot };
}

/** Run the restore for a choice: capture current state as `auto-rehydrate` when no snapshot was usable,
 *  then restore from it. */
export async function runExistingRigRestore(
  deps: ExistingRigRestoreDeps,
  choice: Extract<RestoreSnapshotChoice, { ok: true }>,
  opts: { freshLogicalIds?: string[]; nonInterruptive?: boolean; exists: (path: string) => boolean },
) {
  let { snapshot, snapshotSelection } = choice;
  let capturedCurrentState = false;
  if (!snapshot) {
    snapshot = deps.snapshotCapture.captureSnapshot(choice.rig.rig.id, "auto-rehydrate");
    snapshotSelection = {
      ...summarizeSnapshot(snapshot),
      mode: "automatic",
      rationale: "automatic rehydrate captured current eligible state because no current-occupant snapshot was usable",
      newerUsableAlternative: null,
    };
    capturedCurrentState = true;
  }
  if (!deps.restoreOrchestrator) {
    return { snapshot, capturedCurrentState, result: { ok: false as const, code: "restore_unavailable" as const, message: "Restore orchestrator not available" } };
  }
  const result = await deps.restoreOrchestrator.restore(snapshot.id, {
    adapters: deps.runtimeAdapters ?? {},
    fsOps: { exists: opts.exists },
    // OPR.0.3.4.2 — operation B opt-in seats from `rig up --existing --fresh`.
    freshLogicalIds: opts.freshLogicalIds,
    nonInterruptive: opts.nonInterruptive,
    snapshotSelection,
  });
  return { snapshot, capturedCurrentState, result };
}

/** Restore an existing rig with no operator present (daemon start bringing back a lost kernel) and
 *  reduce the outcome to the errors that kept it from restoring. A partial restore is not a
 *  failure: the seats' own status then decides ready or partial_ready. */
export async function restoreExistingRigUnattended(
  deps: ExistingRigRestoreDeps,
  rigId: string,
  exists: (path: string) => boolean,
): Promise<{ errors: string[] }> {
  const choice = chooseRestoreSnapshot(deps, rigId);
  if (!choice.ok) return { errors: [choice.body.error] };
  const { result } = await runExistingRigRestore(deps, choice, { exists });
  if (!result.ok) return { errors: [result.message] };
  const { rigResult, nodes } = result.result;
  if (rigResult !== "failed" && rigResult !== "not_attempted") return { errors: [] };
  const nodeErrors = nodes.filter((node) => node.error).map((node) => `${node.logicalId}: ${node.error}`);
  return { errors: nodeErrors.length > 0 ? nodeErrors : [`restore ${rigResult}`] };
}
