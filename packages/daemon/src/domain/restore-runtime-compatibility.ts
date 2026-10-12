import { resumeTypeForRuntime } from "./resume-token-validation.js";

/** Describe incompatible restore inputs before a pane or native session starts. */
export function restoreRuntimeCompatibilityError(
  runtime: string | null,
  startupRuntime: string | null | undefined,
  session: { restorePolicy: string | null; resumeType: string | null } | null,
  freshRequested: boolean,
): string | null {
  if (!runtime) return null; // Legacy snapshots may not declare a runtime.
  if (startupRuntime && startupRuntime !== runtime) {
    return `Restore runtime mismatch: seat runtime '${runtime}' differs from saved startup runtime '${startupRuntime}'. No session was started. Use a snapshot whose startup context matches the seat runtime.`;
  }
  const type = session?.resumeType;
  if (freshRequested || !session || (session.restorePolicy ?? "resume_if_possible") !== "resume_if_possible" || !type || type === "none") return null;
  const canonicalType = type === "claude_name" ? "claude_id" : type === "codex_last" ? "codex_id" : type === "stub_session" ? "stub_id" : type;
  const expectedType = runtime === "stub" ? "stub_id" : resumeTypeForRuntime(runtime);
  if (canonicalType === expectedType) return null;
  return `Restore runtime mismatch: resume type '${type}' does not belong to seat runtime '${runtime}'. No session was started. Use a matching resume history or choose an explicit fresh start.`;
}
