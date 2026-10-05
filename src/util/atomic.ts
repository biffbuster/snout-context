/**
 * Atomic single-file state writes.
 *
 * `writeFileSync` is not atomic: it truncates, then writes. Claude Code issues parallel
 * tool calls, and the recording hook runs with `async: true`, so several processes write
 * `.snout/state.json` at once. Measured with 24 concurrent hooks, the file came back
 * unparseable — which silently reset the turn counter, broke read de-duplication and lost
 * the pending-decision map used to detect user overrides.
 *
 * Write to a unique temporary file in the same directory, then `rename`. POSIX rename is
 * atomic within a filesystem, so a reader sees either the old file or the new one.
 */
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeAtomic(path: string, contents: string): void {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created */
    }
    throw err;
  }
}
