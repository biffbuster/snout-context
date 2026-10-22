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
import { randomBytes } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// On Windows a rename fails with EPERM, EACCES or EBUSY while antivirus, the search indexer or
// another process briefly holds either file open. Those locks clear within milliseconds.
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const WAITS_MS = [5, 10, 20, 40, 80];
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameRetrying(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !BUSY.has(code) || i >= WAITS_MS.length) throw err;
      pause(WAITS_MS[i]!);
    }
  }
}

export function writeAtomic(path: string, contents: string): void {
  // pid + time + random: two writers in one process and millisecond never share a temp file.
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, contents);
    renameRetrying(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created */
    }
    // Still locked after ~150 ms: write in place. A torn read is possible but rare; failing the
    // write would lose the data outright.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (process.platform === "win32" && BUSY.has(code)) {
      writeFileSync(path, contents);
      return;
    }
    throw err;
  }
}
