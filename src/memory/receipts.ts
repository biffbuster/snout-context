import { join } from "node:path";
import { appendRow, readRows, rotateIfLarge } from "../ledger/store.js";
import type { Card } from "./memory.js";

/**
 * Recall decision records: one row per prompt where memory had cards to weigh, whether recall spoke
 * or stayed silent, with what each candidate scored and why it was kept or dropped. Joined later
 * with the session's reads and its own card, they say whether a recall was used (a recalled file
 * opened, or changed) and whether a silence missed something (a dropped card named a file the
 * session went on to change). Local, never sent anywhere; the data a recall threshold or model is
 * tuned and graded on.
 */

export type RecallReason = "spoke" | "no-match" | "already-recalled" | "map-gate";

export interface RecallCandidate {
  id: string;
  agent: "claude" | "codex";
  /** The ranker's score: BM25 for words, reciprocal-rank fusion for words and meaning. */
  score: number;
  /** Files of the card the prompt names outright. */
  named: number;
  /** A file of the card is in the repo map's top candidates for the prompt (null: not checked). */
  mapAgree: boolean | null;
  kept: boolean;
  files: string[];
}

export interface RecallDecision {
  ts: string;
  session: string;
  turn: number;
  kind: "recall";
  ranker: "words" | "hybrid";
  spoke: boolean;
  reason: RecallReason;
  cands: RecallCandidate[];
  tokensEst?: number;
}

const file = (snoutDir: string) => join(snoutDir, "decisions.jsonl");

export function recordRecallDecision(snoutDir: string, row: Omit<RecallDecision, "kind">): void {
  const path = file(snoutDir);
  rotateIfLarge(path);
  appendRow(path, { ...row, kind: "recall", cands: row.cands.slice(0, 10).map((c) => ({ ...c, files: c.files.slice(0, 8) })) });
}

export function readRecallDecisions(snoutDir: string): RecallDecision[] {
  return readRows<RecallDecision>(file(snoutDir)).filter((r) => r?.kind === "recall" && Array.isArray(r.cands));
}

export interface Read { session: string; ts: string; path: string }

export interface RecallOutcome extends RecallDecision {
  /** Recalled files the session read after the recall. */
  opened: string[];
  /** Recalled files the session changed (from its own card). */
  changed: string[];
  /** For a silence: files of dropped cards the session went on to change. */
  missed: string[];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Joins each decision with what its session did next. */
export function recallOutcomes(decisions: RecallDecision[], cards: Card[], reads: Read[]): RecallOutcome[] {
  const changedBy = new Map<string, Set<string>>();
  for (const c of cards) changedBy.set(c.session, new Set([...c.changed, ...c.commits.flatMap((k) => k.files)].map(norm)));
  const readsBy = new Map<string, Read[]>();
  for (const r of reads) (readsBy.get(r.session) ?? readsBy.set(r.session, []).get(r.session)!).push(r);
  return decisions.map((d) => {
    const changed = changedBy.get(d.session) ?? new Set<string>();
    const kept = new Set(d.cands.filter((c) => c.kept).flatMap((c) => c.files.map(norm)));
    const dropped = new Set(d.cands.filter((c) => !c.kept).flatMap((c) => c.files.map(norm)));
    const later = new Set((readsBy.get(d.session) ?? []).filter((r) => r.ts >= d.ts).map((r) => norm(r.path)));
    return {
      ...d,
      opened: d.spoke ? [...kept].filter((f) => later.has(f)) : [],
      changed: d.spoke ? [...kept].filter((f) => changed.has(f)) : [],
      missed: d.spoke ? [] : [...dropped].filter((f) => changed.has(f)),
    };
  });
}

export interface RecallSummary {
  prompts: number;
  spoke: number;
  opened: number;
  changed: number;
  silent: number;
  missed: number;
  byReason: Record<RecallReason, number>;
}

export function summarizeRecall(outcomes: RecallOutcome[]): RecallSummary {
  const byReason: Record<RecallReason, number> = { spoke: 0, "no-match": 0, "already-recalled": 0, "map-gate": 0 };
  for (const o of outcomes) byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
  const spoke = outcomes.filter((o) => o.spoke);
  const silent = outcomes.filter((o) => !o.spoke);
  return {
    prompts: outcomes.length,
    spoke: spoke.length,
    opened: spoke.filter((o) => o.opened.length).length,
    changed: spoke.filter((o) => o.changed.length).length,
    silent: silent.length,
    missed: silent.filter((o) => o.missed.length).length,
    byReason,
  };
}
