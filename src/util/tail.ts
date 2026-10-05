/**
 * Reads the last N lines of a file without loading the whole thing.
 *
 * The ledger is append-only and grows for the life of a project. `readFileSync` on it was
 * measured at 435 ms for a 40 MB ledger — and the status line reads it on every terminal
 * repaint, so that cost lands in front of the user continuously and worsens forever.
 *
 * Read backwards in blocks from the end and stop once enough newlines have been seen.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

const BLOCK = 64 * 1024;

export function tailLines(path: string, maxLines: number, maxBytes = 8 * 1024 * 1024): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return [];
    fd = openSync(path, "r");

    const chunks: Buffer[] = [];
    let pos = size;
    let newlines = 0;
    let read = 0;

    while (pos > 0 && newlines <= maxLines && read < maxBytes) {
      const len = Math.min(BLOCK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      read += len;
      for (const b of buf) if (b === 0x0a) newlines++;
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split("\n");

    // The first line may be a fragment of a row that began before our read window, unless
    // we happened to read from byte zero. Dropping it is safer than parsing half a row.
    if (pos > 0 && lines.length > 1) lines.shift();

    const nonEmpty = lines.filter((l) => l.length > 0);
    return nonEmpty.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
