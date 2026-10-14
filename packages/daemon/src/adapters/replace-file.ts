import fs from "node:fs";

/**
 * Copy `src` over `dest` by renaming a sibling into place instead of opening `dest` for writing.
 * `copyFileSync` carries the source mode over, so a read-only source (a package-manager store such as
 * Nix's) leaves a read-only destination that a later plain copy cannot overwrite (EACCES). Renaming
 * over it needs only a writable directory, and a reader never sees a half-written file.
 */
export function replaceFile(src: string, dest: string): void {
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
