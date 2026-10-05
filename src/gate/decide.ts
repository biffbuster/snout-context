/**
 * The ladder. The mode policy and its thresholds live in policy.ts, in code, so changing a
 * mode or a threshold never triggers re-inference.
 *
 * Phase 0 implements tier 0 only; the tier 1 and tier 2 hooks are marked and return null
 * so the ladder reads the same once they land.
 */
import type { Config } from "../config.js";
import type { Decision } from "../types.js";
import { tier0 } from "./tier0.js";
import { applyMode } from "./policy.js";
import { safePath } from "../util/safe.js";

export { THRESHOLDS, MIN_GATE_TOKENS, applyMode, bandOf, worthGating, type Band, type Thresholds } from "./policy.js";

export interface DecideInput {
  absPath: string;
  projectDir: string;
  cfg: Config;
}

export function decide(input: DecideInput): Decision {
  const raw =
    tier0(input) ??
    // tier1(input) — Phase 1: the turn relevance vector.
    // tier2(input) — Phase 2: one Jev call for an ambiguous file.
    null;

  if (!raw) {
    return {
      verdict: "allow",
      tier: 0,
      rule: "unclassified",
      value: 2,
      confidence: 0,
      reason: "No rule applies and the semantic tier is not enabled yet.",
    };
  }

  return applyMode(raw, input.cfg.mode);
}

/**
 * The override hint appended to every reason.
 *
 * The path is sanitised here too. It was not, and that single interpolation was enough to
 * keep a crafted filename's newlines flowing into `permissionDecisionReason` even after
 * the rule text itself had been fixed — the sanitiser has to cover every path into the
 * field, not most of them.
 */
export function withOverride(reason: string, relPath: string): string {
  const p = safePath(relPath);
  return `${reason} (/snout:explain ${p} · /snout:allow ${p})`;
}

/**
 * A cheaper way to get what the agent was after, appended to a deny or ask. Without it a
 * denied agent that needs one fact from a lockfile falls back to `cat`, and the whole file
 * enters context anyway (bench/ab.mjs saw exactly that). Empty when no search makes sense:
 * secrets, binaries, crafted names and the user's own deny list.
 *
 * The path is untrusted, so it is only ever emitted single-quoted, and a path that cannot
 * be single-quoted safely gets no hint at all. `oneLine` marks a file whose content is one
 * huge line (a bundle under dist/ is labelled build output, not minified): a plain `grep -n`
 * there prints the whole file, so the hint bounds the match instead.
 */
export function searchHint(rule: string, relPath: string, opts: { oneLine?: boolean } = {}): string {
  if (!TEXT_RULES.has(rule)) return "";
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069'`]/.test(relPath)) return "";
  const safe = relPath.startsWith("-") ? `./${relPath}` : relPath; // never parsed as a flag
  const f = /^[A-Za-z0-9._\/@+-]+$/.test(safe) ? safe : `'${safe}'`;
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const cmd =
    base === "package-lock.json" || base === "npm-shrinkwrap.json" ? `grep -n -A3 '"node_modules/<name>"' ${f}`
    : base === "yarn.lock" ? `grep -n -A3 '^"\\?<name>@' ${f}`
    : base === "Cargo.lock" ? `grep -n -A1 'name = "<crate>"' ${f}`
    : rule === "lockfile" ? `grep -n '<name>' ${f}`
    : rule === "minified" || opts.oneLine ? `grep -o '.\\{0,80\\}<symbol>.\\{0,80\\}' ${f}`
    : `grep -n '<symbol>' ${f}`;
  return ` Need one fact from it? Search instead of reading it whole: \`${cmd}\`.`;
}

/** Rules about text files an agent might legitimately need a line from. */
const TEXT_RULES = new Set(["lockfile", "vendored", "generated", "minified", "snapshot", "oversized", "license"]);

