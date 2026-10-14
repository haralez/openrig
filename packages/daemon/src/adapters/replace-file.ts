import fs from "node:fs";
import path from "node:path";

/**
 * Replace a file through exclusively created sibling staging and an atomic rename.
 * Preserve the source mode so read-only packaged assets can be provisioned repeatedly.
 * Never follow an existing temporary slot, and clean only this invocation's staging.
 */
export function replaceFile(src: string, dest: string): void {
  const staging = fs.mkdtempSync(`${dest}.tmp-`);
  const tmp = path.join(staging, "asset");
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tmp, dest);
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // A cleanup error must not replace a copy/rename error or undo a successful replacement.
    }
  }
}
