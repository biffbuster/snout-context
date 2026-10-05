/**
 * The per-label distribution of a set of files: how many fall under each label, what they
 * would cost to read whole, and which threshold band each lands in. Pure: no Node imports.
 */
import type { Decision, Mode } from "../types.js";
import { estimateTokens } from "../ledger/tokens.js";
import { applyMode, bandOf, THRESHOLDS, type Band, type Thresholds } from "./policy.js";
import { labelOf, type Label } from "./rules.js";

export interface ScannedFile {
  rel: string;
  bytes: number;
  /** The tier 0 decision before mode is applied, or null when no rule applies. */
  raw: Decision | null;
}

export interface LabelRow {
  label: Label;
  files: number;
  bytes: number;
  tokens: number;
}

export interface BandRow {
  files: number;
  tokens: number;
}

export interface FlaggedFile {
  rel: string;
  label: Label;
  rule: string;
  confidence: number;
  band: Band;
  tokens: number;
}

export interface Summary {
  files: number;
  tokens: number;
  thresholds: Thresholds;
  mode: Mode;
  /** Every label with at least one file, most tokens first. */
  labels: LabelRow[];
  bands: Record<Band, BandRow>;
  /** What the given mode does with these files, as counts per verdict. */
  outcome: Record<"allow" | "ask" | "deny", BandRow>;
  /** Flagged files by token cost, highest first. */
  top: FlaggedFile[];
}

export function summarize(files: readonly ScannedFile[], mode: Mode, t: Thresholds = THRESHOLDS, topN = 10): Summary {
  const labels = new Map<Label, LabelRow>();
  const bands: Record<Band, BandRow> = { act: { files: 0, tokens: 0 }, ask: { files: 0, tokens: 0 }, read: { files: 0, tokens: 0 } };
  const outcome = { allow: { files: 0, tokens: 0 }, ask: { files: 0, tokens: 0 }, deny: { files: 0, tokens: 0 } };
  const flagged: FlaggedFile[] = [];
  let tokens = 0;

  for (const f of files) {
    const tok = estimateTokens(f.bytes, f.rel);
    tokens += tok;
    const label = labelOf(f.raw);
    const row = labels.get(label) ?? { label, files: 0, bytes: 0, tokens: 0 };
    row.files++;
    row.bytes += f.bytes;
    row.tokens += tok;
    labels.set(label, row);

    const band = bandOf(f.raw, t);
    bands[band].files++;
    bands[band].tokens += tok;

    const v = f.raw ? applyMode(f.raw, mode, t).verdict : "allow";
    outcome[v].files++;
    outcome[v].tokens += tok;

    if (f.raw && label !== "read") {
      flagged.push({ rel: f.rel, label, rule: f.raw.rule, confidence: f.raw.confidence, band, tokens: tok });
    }
  }

  flagged.sort((a, b) => b.tokens - a.tokens);
  return {
    files: files.length,
    tokens,
    thresholds: { ...t },
    mode,
    labels: [...labels.values()].sort((a, b) => b.tokens - a.tokens || b.files - a.files),
    bands,
    outcome,
    top: flagged.slice(0, topN),
  };
}
