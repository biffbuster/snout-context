/**
 * Splits Grep's content-mode output by the file each line came from, so matches from a
 * lockfile or a minified bundle are classified as what they are rather than lumped into
 * one "search" figure. Only `output_mode: "content"` carries file content; the default
 * files mode and count mode return paths and numbers, which are counted as tool output.
 *
 * Output lines look like `path:12:text` (with -n), `path-12-text` (context lines),
 * `path:text`, or just `text` when a single file was searched. A candidate prefix only
 * counts if it exists on disk as a file — the same fail-closed rule as the Bash parser:
 * an unattributed line is counted as tool output, never pinned on a guessed file.
 */
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Past this many lines the rest is counted as tool output: attribution is a nicety. */
const MAX_LINES = 5000;

export interface GrepSplit {
  /** Absolute path → bytes of output lines from that file. */
  files: Map<string, number>;
  /** Bytes no file could be found for: separators, headers, unmatched lines. */
  rest: number;
}

export function splitGrepOutput(text: string, cwd: string, searchPath?: string): GrepSplit {
  const files = new Map<string, number>();
  let rest = 0;
  const isFileCache = new Map<string, boolean>();
  const isFile = (p: string): boolean => {
    const hit = isFileCache.get(p);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      ok = statSync(p).isFile();
    } catch {
      ok = false;
    }
    isFileCache.set(p, ok);
    return ok;
  };
  const resolve = (p: string) => (isAbsolute(p) ? p : join(cwd, p));
  const single = searchPath && isFile(resolve(searchPath)) ? resolve(searchPath) : null;

  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const bytes = Buffer.byteLength(line) + 1;
    if (i >= MAX_LINES || line === "" || line === "--") {
      rest += bytes;
      return;
    }
    const owner = ownerOf(line, resolve, isFile) ?? single;
    if (owner) files.set(owner, (files.get(owner) ?? 0) + bytes);
    else rest += bytes;
  });
  return { files, rest };
}

/** The file a line belongs to: the shortest `:`- or `-`-delimited prefix that is a real file. */
function ownerOf(line: string, resolve: (p: string) => string, isFile: (p: string) => boolean): string | null {
  for (let i = 1; i < line.length && i < 1024; i++) {
    const c = line[i];
    if (c !== ":" && c !== "-") continue;
    const abs = resolve(line.slice(0, i));
    if (isFile(abs)) return abs;
  }
  return null;
}
