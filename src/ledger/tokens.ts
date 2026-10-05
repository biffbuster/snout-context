/**
 * Token accounting. Two kinds of number, never mixed:
 *
 *   ESTIMATED — tokens for content that was withheld. By definition this read never
 *   happened, so no tokenizer can measure it. We estimate from byte length using a
 *   per-extension characters-per-token ratio and label it `~` everywhere it is shown.
 *
 *   MEASURED — real usage pulled from the session transcript that Claude Code writes.
 *
 * Ratios below are bytes per token, measured with `bench/tokens.mjs` against the
 * `count_tokens` endpoint for claude-opus-5 on 612 real files from the 100-repo corpus
 * (2026-09-23). Opus 4.7+, Opus 5 and Fable share that tokenizer; older and smaller
 * models use fewer tokens for the same text, so for them these estimates run high.
 *
 * The previous hand-set ratios (3.4 for TypeScript, 4.0 for prose) under-reported every
 * file type by 19-64%, typically ~31%. Per-file spread within one extension is about
 * ±15% (p10-p90 in the bench output), so any single estimate carries that band even
 * though the per-extension average is calibrated.
 *
 * Validated on a holdout of 573 different files: 29 of 31 extensions within ±10%, most
 * within ±5%. The exceptions are mixed types — `.txt` (prose, logs, data dumps) and `.xml`
 * (POMs, layouts, data) — where two independent 20-file samples disagree by 15-19%, so no
 * single ratio fits both. Those, and `.jsx` (12 samples), use the mean of both sets, which
 * sits within ±9% of each; they are fitted, not held out, and carry a wider band.
 */

const RATIOS: Record<string, number> = {
  json: 2.22,
  lock: 1.92,
  sum: 1.3, // go.sum: hashes tokenize badly
  csv: 1.52,
  svg: 1.73,
  xml: 2.15, // mixed type, see above
  yaml: 2.43,
  yml: 2.58,
  toml: 2.08,
  ts: 2.24,
  tsx: 2.41,
  js: 2.34,
  jsx: 2.54, // mixed type, see above
  py: 2.45,
  go: 2.2,
  rs: 2.4,
  java: 2.42,
  kt: 2.24,
  cs: 2.49,
  swift: 2.4,
  rb: 2.19,
  php: 2.17,
  c: 2.26,
  h: 2.19,
  cpp: 2.25,
  sh: 2.03,
  sql: 2.19, // 8 samples
  html: 2.47,
  css: 2.12,
  md: 2.74,
  rst: 2.58,
  txt: 2.22, // mixed type, see above
};

/** Files with no extension measured 2.27; other unlisted extensions sit near it. */
const DEFAULT_RATIO = 2.3;

export function ratioFor(path: string): number {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m?.[1]?.toLowerCase();
  if (!ext) return DEFAULT_RATIO;
  return RATIOS[ext] ?? DEFAULT_RATIO;
}

/**
 * An image an agent reads is sent as vision input, not bytes: it is resized to fit about
 * 1.15 megapixels and costs width×height/750 tokens, so ~1,600 at most. Dividing its bytes
 * by a text ratio counted one screenshot as 270k tokens.
 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const IMAGE_TOKENS = 1600;
export const isImagePath = (path: string): boolean => IMAGE_EXT.has(/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "");

/** Estimated tokens for a byte count at a path's ratio. Always shown with a `~`. */
export function estimateTokens(bytes: number, path: string): number {
  if (bytes <= 0) return 0;
  if (isImagePath(path)) return Math.min(IMAGE_TOKENS, Math.round(bytes / DEFAULT_RATIO));
  return Math.round(bytes / ratioFor(path));
}

export interface TranscriptUsage {
  requests: number;
  inputUncached: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
}

/**
 * Reads real usage out of a Claude Code transcript.
 *
 * Format confirmed empirically against a live transcript: one JSON object per line;
 * assistant lines carry `message.usage` and a `requestId`. A single request can appear on
 * several lines, so we keep the highest-output record per `requestId` — the same dedupe
 * the official session-report plugin performs.
 *
 * `cacheRead` matters more than it looks: content already in context is re-billed at the
 * cache-read rate on later turns, not the full input rate. See docs/evaluation.md.
 */
export function readTranscriptUsage(text: string): TranscriptUsage {
  const byRequest = new Map<string, { input: number; create: number; read: number; output: number }>();

  for (const line of text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a partially flushed final line is normal while a session is live
    }
    const usage = obj?.message?.usage;
    if (!usage) continue;
    const id: string = obj.requestId || obj.uuid || `${byRequest.size}`;
    const rec = {
      input: usage.input_tokens || 0,
      create: usage.cache_creation_input_tokens || 0,
      read: usage.cache_read_input_tokens || 0,
      output: usage.output_tokens || 0,
    };
    const prev = byRequest.get(id);
    if (!prev || rec.output >= prev.output) byRequest.set(id, rec);
  }

  const total: TranscriptUsage = {
    requests: byRequest.size,
    inputUncached: 0,
    cacheCreate: 0,
    cacheRead: 0,
    output: 0,
  };
  for (const r of byRequest.values()) {
    total.inputUncached += r.input;
    total.cacheCreate += r.create;
    total.cacheRead += r.read;
    total.output += r.output;
  }
  return total;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
