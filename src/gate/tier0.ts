/**
 * Tier 0: free, deterministic classification. No model call, no network, one `stat` and at
 * most a 2 KB head read. Target: resolves >= 70% of decisions in under 5 ms.
 *
 * The rules themselves live in `rules.ts`, as pure functions. This file supplies their
 * signals from disk.
 *
 * Rules are ordered by authority, not by cost. The first that matches wins, and the order
 * is the policy: safety (credentials) before user overrides, user overrides before our own
 * heuristics. Changing the order changes behaviour, so the order is tested.
 *
 * Ignore files: `.snoutignore` is read from the project root and appended to the deny list.
 * The root `.gitignore` is read only to decide whether an output-named directory (`dist/`,
 * `build/`…) is ignored build output or committed source; it is not otherwise a policy.
 */
import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { relative, isAbsolute, join } from "node:path";
import type { Config } from "../config.js";
import type { Decision } from "../types.js";
import { firstHit, ignoredOutputDirIn, parseGitignore, scoreLabels, type IgnoreRule, type LabelScore, type Signals } from "./rules.js";

export interface Tier0Input {
  absPath: string;
  projectDir: string;
  cfg: Config;
}

/** Returns a decision, or null to hand the file to the next tier. */
export function tier0(input: Tier0Input): Decision | null {
  return firstHit(signalsFor(input));
}

/** Every label's score for a file on disk. Explains a decision; never changes one. */
export function scoreFile(input: Tier0Input): LabelScore[] {
  return scoreLabels(signalsFor(input));
}

/** Disk-backed signals. Head and size are read at most once, and only if a rule asks. */
export function signalsFor({ absPath, projectDir, cfg }: Tier0Input): Signals {
  let head: Uint8Array | null | undefined;
  let bytes: number | undefined;
  return {
    rel: toRel(absPath, projectDir),
    cfg,
    head: () => (head === undefined ? (head = readHead(absPath)) : head),
    bytes: () => (bytes === undefined ? (bytes = sizeOf(absPath)) : bytes),
    ignoredOutputDir: (rel) => ignoredOutputDirIn(rel, gitignoreRules(projectDir)),
    snoutignore: snoutignore(projectDir),
  };
}

export function toRel(absPath: string, projectDir: string): string {
  const abs = isAbsolute(absPath) ? absPath : join(projectDir, absPath);
  const rel = relative(projectDir, abs);
  // A path outside the project stays absolute so the rules still see something sensible.
  return rel.startsWith("..") ? abs.replace(/\\/g, "/") : rel.replace(/\\/g, "/");
}

const gitignoreCache = new Map<string, IgnoreRule[]>();

/** The root `.gitignore`, parsed once per process. No file means nothing is ignored. */
function gitignoreRules(projectDir: string): IgnoreRule[] {
  const hit = gitignoreCache.get(projectDir);
  if (hit) return hit;
  let rules: IgnoreRule[] = [];
  try {
    rules = parseGitignore(readFileSync(join(projectDir, ".gitignore"), "utf8"));
  } catch {
    // no .gitignore: nothing is ignored, so no output dir counts
  }
  gitignoreCache.set(projectDir, rules);
  return rules;
}

/** `size:mtime`, from one stat. Changes when the file is edited; no content read. */
export function fingerprintOf(absPath: string): string | undefined {
  try {
    const st = statSync(absPath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

export function sizeOf(absPath: string): number {
  try {
    return statSync(absPath).size;
  } catch {
    return 0;
  }
}

/** Reads at most 2 KB from the head of a file. One read, shared by the checks that need it. */
function readHead(absPath: string): Uint8Array | null {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.allocUnsafe(2048);
    const n = readSync(fd, buf, 0, 2048, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
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

/**
 * Globs from `.snoutignore` in the project root: one pattern per line, `#` starts a comment.
 * Appended to the deny list. Cached per process, which is the whole life of a hook.
 */
const snoutignoreCache = new Map<string, string[]>();

export function snoutignore(projectDir: string): string[] {
  const hit = snoutignoreCache.get(projectDir);
  if (hit) return hit;
  let patterns: string[] = [];
  try {
    const raw = readFileSync(join(projectDir, ".snoutignore"), "utf8");
    patterns = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .slice(0, 500); // a pathological ignore file should not become a pathological regex set
  } catch {
    patterns = []; // absent is the normal case
  }
  snoutignoreCache.set(projectDir, patterns);
  return patterns;
}
