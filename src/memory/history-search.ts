/**
 * Search over the imported history (commits, PRs, CI runs: history.ts), kept apart from notes and
 * session records because it is long and machine-made. Two steps, deliberately separate:
 *
 *   ranking    every record the viewer may see at the as-of date is scored, never a shortlist:
 *              BM25 over its words and file names (word rarity from these records only, so a
 *              later commit can't change how an earlier question ranks), meaning from the optional
 *              local model, and the files the agent says it is working on. Ranks are fused (RRF).
 *   admission  whether a ranked record answers at all. Only the first `eligible` are considered,
 *              and each needs evidence: a sha, PR number, version or path the question names; or,
 *              with the model, a close meaning alone or a fair one together with the question's
 *              rarer words; or, without it, most of the question's rarer words. Files and meaning
 *              are clues for ranking, not proof: a file the agent knows never admits a record.
 *
 * The thresholds were fixed on development sets (bench/import-asof/{vite,django}, 2026-11-09),
 * before any evaluation on new projects; docs/memory-gates.md has the numbers.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../util/atomic.js";
import { MODEL, QUERY_PREFIX } from "./embed.js";
import type { HistRecord } from "./history.js";
import { terms } from "./memory.js";

/** Rank fusion constant: the usual 60, so no single ranking's top places dominate. */
const RRF_K = 60;
/** With the model: a meaning this close answers alone; a fair one needs the question's rarer words too. */
export const MEANING_ALONE = 0.74;
export const MEANING_WITH_WORDS = 0.68;
export const COVER_WITH_MEANING = 0.3;
/** Without the model: most of the question's rarer words, and at least two of them (one, for a one-term question). */
export const COVER_ALONE = 0.4;
export const WORDS_ALONE = 2;
/** Records embedded during one search at most; the rest use the word rule until they are embedded. */
export const MAX_LAZY_VECTORS = 256;

/** Light stemming, the same for questions and records: "timing" and "timed" meet at "tim", "fixes" and "fixed" at "fix". */
const stem = (w: string) => w.replace(/ies$/, "y").replace(/(?<=\w{3})(?:es|s)$/, "").replace(/(?<=\w{3})(?:ed|ing)$/, "");
/** A text's search terms: words and code names split at case and underscores, stop words out, light stemming. */
export const historyTerms = (text: string): string[] => terms(text).map((t) => stem(t.toLowerCase()));
const pathTerms = (files: string[]) => files.flatMap((f) => f.toLowerCase().split(/[/._-]+/)).filter((p) => p.length >= 3).map(stem);

/** What the model reads for a record: its title, the start of its body and a few file names. */
export const vectorText = (r: HistRecord): string => `${r.title}\n${r.body.slice(0, 600)}\n${r.files.slice(0, 8).join(" ")}`;

interface Tokens { key: string; tf: Map<string, number>; len: number }
const tokenCache = new Map<string, Tokens>();
function tokensOf(r: HistRecord): Tokens {
  const key = `${r.at}|${r.title.length}|${r.body.length}|${r.files.length}`;
  const was = tokenCache.get(r.id);
  if (was?.key === key) return was;
  const all = [...historyTerms(`${r.title} ${r.body}`), ...pathTerms(r.files)];
  const tf = new Map<string, number>();
  for (const t of all) tf.set(t, (tf.get(t) ?? 0) + 1);
  const tok = { key, tf, len: all.length };
  tokenCache.set(r.id, tok);
  return tok;
}

/** A file the agent named, against a record's repository-relative paths: the same path, or one ending in it. */
const sameFile = (known: string, file: string) => {
  const k = known.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const f = file.toLowerCase();
  return !!k && (f === k || f.endsWith(`/${k}`) || k.endsWith(`/${f}`));
};

export interface HistoryQuery {
  text: string;
  /** Project-relative files the agent says it is working on. */
  files?: string[];
  /** A record the question names itself (sha, PR number, version, a path it gives): always admitted, first. */
  exact: (r: HistRecord) => boolean;
  /** The question's vector, when the model ran for it, and the records' vectors it has. */
  qvec?: Float32Array;
  vecOf?: (r: HistRecord) => Float32Array | undefined;
  /** How many of the best ranked records admission considers (the search's limit). */
  eligible: number;
  /** Extra admission for a kind of record (a CI question and a failed run): one shared term is enough. */
  lenient?: (r: HistRecord) => boolean;
}

export interface HistoryScore { r: HistRecord; fused: number; cover: number; words: number; cos?: number; fileHit: number; exact: boolean; admitted: boolean }

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

/** Every visible record, ranked, with whether it is admitted. `records` must already be the viewer's, cut at the as-of date. */
export function rankHistory(records: HistRecord[], q: HistoryQuery): HistoryScore[] {
  const N = records.length;
  if (!N) return [];
  const qt = [...new Set(historyTerms(q.text))];
  const toks = records.map(tokensOf);
  const avg = toks.reduce((s, t) => s + t.len, 0) / N || 1;
  const df = new Map(qt.map((t) => [t, toks.filter((x) => x.tf.has(t)).length]));
  const idf = (t: string) => Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
  const idfSum = qt.reduce((s, t) => s + idf(t), 0) || 1;
  const files = (q.files ?? []).filter(Boolean);
  const rows = records.map((r, i) => {
    const tok = toks[i]!;
    let bm = 0, cover = 0, words = 0;
    for (const t of qt) {
      const f = tok.tf.get(t);
      if (!f) continue;
      words++;
      cover += idf(t);
      bm += idf(t) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * tok.len / avg));
    }
    const v = q.qvec && q.vecOf?.(r);
    return { r, bm, cover: cover / idfSum, words, ...(v ? { cos: dot(q.qvec!, v) } : {}), fileHit: files.filter((k) => r.files.some((f) => sameFile(k, f))).length, exact: q.exact(r) };
  });
  const fused = new Map(rows.map((x) => [x, x.exact ? 1 : 0]));
  const add = (list: typeof rows) => list.forEach((x, i) => fused.set(x, fused.get(x)! + 1 / (RRF_K + i + 1)));
  const byAt = (a: (typeof rows)[number], b: (typeof rows)[number]) => b.r.at.localeCompare(a.r.at);
  add(rows.filter((x) => x.bm > 0).sort((a, b) => b.bm - a.bm || byAt(a, b)));
  add(rows.filter((x) => x.cos !== undefined).sort((a, b) => b.cos! - a.cos! || byAt(a, b)));
  if (files.length) add(rows.filter((x) => x.fileHit > 0).sort((a, b) => b.fileHit - a.fileHit || byAt(a, b)));
  const ranked = rows.filter((x) => fused.get(x)! > 0).sort((a, b) => fused.get(b)! - fused.get(a)! || byAt(a, b));
  return ranked.map((x, i) => {
    const meaning = x.cos !== undefined && (x.cos >= MEANING_ALONE || (x.cos >= MEANING_WITH_WORDS && x.cover >= COVER_WITH_MEANING));
    const wordsOnly = x.cover >= COVER_ALONE && x.words >= Math.min(WORDS_ALONE, qt.length);
    const lenient = !!q.lenient?.(x.r) && (x.words > 0 || (x.cos ?? 0) >= MEANING_WITH_WORDS);
    return { ...x, fused: fused.get(x)!, admitted: x.exact || (i < q.eligible && (meaning || wordsOnly || lenient)) };
  });
}

// ---------------------------------------------------------------- vectors

/**
 * Record vectors, cached per project next to the records (`vectors.json`), by each record's id and
 * the hash of the text the model read. A search embeds at most MAX_LAZY_VECTORS missing records,
 * newest first; an import embeds them all when meaning is on.
 */
interface VectorCache { model: string; v: Record<string, [string, string]> }
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const pack = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const unpack = (s: string) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

let loaded: { file: string; mtime: number; cache: VectorCache; vecs: Map<string, Float32Array> } | null = null;
function vectorCache(file: string): NonNullable<typeof loaded> {
  let mtime = -1;
  try { mtime = statSync(file).mtimeMs; } catch { /* none yet */ }
  if (loaded?.file === file && loaded.mtime === mtime) return loaded;
  let cache: VectorCache = { model: MODEL, v: {} };
  try { const c = JSON.parse(readFileSync(file, "utf8")) as VectorCache; if (c.model === MODEL && c.v && typeof c.v === "object") cache = c; } catch { /* none yet */ }
  const vecs = new Map(Object.entries(cache.v).map(([id, [, s]]) => [id, unpack(s)]));
  loaded = { file, mtime, cache, vecs };
  return loaded;
}

/** The question's vector and the records' vectors one search uses, set by prepareHistoryVectors. */
let prepared: { query: string; qvec: Float32Array; file: string } | null = null;

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

/**
 * Embeds the question and up to `max` records that have no vector for their current text, and saves
 * them. Returns how many records still lack one. Any failure leaves the word rule in place.
 */
export async function prepareHistoryVectors(historyRoot: string, records: HistRecord[], query: string | null, embed: EmbedFn, max = MAX_LAZY_VECTORS): Promise<number> {
  const file = join(historyRoot, "vectors.json");
  try {
    const c = vectorCache(file);
    const stale = records.filter((r) => c.cache.v[r.id]?.[0] !== hash(vectorText(r))).sort((a, b) => b.at.localeCompare(a.at));
    const batch = stale.slice(0, max);
    const got = await embed([...(query ? [`${QUERY_PREFIX}${query}`] : []), ...batch.map(vectorText)]);
    if (!got) return stale.length;
    if (query) prepared = { query, qvec: got[0]!, file };
    const vecs = got.slice(query ? 1 : 0);
    batch.forEach((r, i) => { c.cache.v[r.id] = [hash(vectorText(r)), pack(vecs[i]!)]; c.vecs.set(r.id, vecs[i]!); });
    if (batch.length) {
      writeAtomic(file, JSON.stringify(c.cache));
      try { c.mtime = statSync(file).mtimeMs; } catch { /* re-read next time */ }
    }
    return stale.length - batch.length;
  } catch {
    return records.length;
  }
}

/** The vectors a search may use for this question: only after prepareHistoryVectors ran for it. */
export function historyVectors(historyRoot: string, query: string): { qvec: Float32Array; vecOf: (r: HistRecord) => Float32Array | undefined } | null {
  const file = join(historyRoot, "vectors.json");
  if (!prepared || prepared.query !== query || prepared.file !== file) return null;
  const c = vectorCache(file);
  return { qvec: prepared.qvec, vecOf: (r) => (c.cache.v[r.id]?.[0] === hash(vectorText(r)) ? c.vecs.get(r.id) : undefined) };
}
