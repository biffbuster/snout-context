/**
 * The mode policy and its two thresholds. Pure: no Node imports, so the CLI and the hooks
 * apply the exact same policy to the exact same numbers.
 */
import type { Decision, Mode } from "../types.js";

export interface Thresholds {
  /** Enforce mode withholds at or above this; asks below it. */
  denyMinConfidence: number;
  /** Below this, every mode reads the file. Not a tunable invariant — see docs/thresholds.md. */
  askMinConfidence: number;
}

/** Confidence floors. Phase 3 replaces these with calibrated values from .snout/thresholds.json. */
export const THRESHOLDS: Readonly<Thresholds> = {
  denyMinConfidence: 0.9,
  askMinConfidence: 0.5,
};

/**
 * The smallest read worth blocking, in estimated tokens. A deny is not free: the agent
 * spends a turn on it, and that turn re-sends the conversation. Below this size the turn
 * costs more than the file, so the read is recorded as flagged and allowed. Secrets and
 * crafted names are exempt — withholding them is a safety decision, not a token one. Measured by
 * bench/ab.mjs, where denying a 9-token config file only added a turn.
 */
export const MIN_GATE_TOKENS = 2000;

/**
 * Whether the blocking hook should act on a read at all, before mode applies: only regular
 * files (a Read of a directory fails on its own) that are big enough to outweigh the turn
 * a deny costs.
 */
export function worthGating(d: Decision, isFile: boolean, estimatedTokens: number): boolean {
  if (d.rule === "secret" || d.rule === "crafted-path") return isFile;
  return isFile && estimatedTokens >= MIN_GATE_TOKENS;
}

/**
 * Turns a raw classification into the verdict the current mode permits.
 *
 * Two invariants, both load-bearing:
 *   - A low-confidence answer always allows. Per docs.typesafe.ai/confidence, low
 *     confidence means the classifier is reporting that it does not know, and a context
 *     gate that acts on "I don't know" is a gate that breaks work.
 *   - `observe` never blocks anything. It is the default so that a user sees their own
 *     numbers before they hand us the power to act on them.
 *
 * `t` exists for what-if views (`/snout:scan --deny`). The hooks
 * always pass the shipped THRESHOLDS.
 */
export function applyMode(d: Decision, mode: Mode, t: Thresholds = THRESHOLDS): Decision {
  if (d.verdict === "allow") return d;

  // Secrets are a safety decision, not a token-value one, so mode does not soften them.
  if (d.rule === "secret") return d;

  if (d.confidence < t.askMinConfidence) {
    return { ...d, verdict: "allow", suppressedByMode: true, reason: d.reason };
  }

  switch (mode) {
    case "observe":
      return { ...d, verdict: "allow", suppressedByMode: true };
    case "advise":
      return { ...d, verdict: "ask" };
    case "enforce":
      return d.confidence >= t.denyMinConfidence ? d : { ...d, verdict: "ask" };
  }
}

/**
 * Which threshold band a classification falls in, independent of mode:
 *   act  — enforce would withhold it
 *   ask  — enforce would ask first
 *   read — every mode reads it
 * This is what enforce mode *would* do, which is the useful question in observe mode.
 */
export type Band = "act" | "ask" | "read";

export function bandOf(d: Decision | null, t: Thresholds = THRESHOLDS): Band {
  if (!d) return "read";
  const v = applyMode(d, "enforce", t).verdict;
  return v === "deny" ? "act" : v === "ask" ? "ask" : "read";
}
