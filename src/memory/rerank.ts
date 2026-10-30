/**
 * The optional answerability reranker (`snout memory reranker install`): a small local cross-encoder
 * (ms-marco MiniLM-L6, about 23 MB) reads a question together with each short-listed record and
 * scores whether the record answers it, not only whether the two share words. `snout recall` and
 * the MCP search use it when asked; the prompt hooks never load it. Nothing leaves the machine.
 *
 * It only chooses among records the path may already show: the hard filters (the viewer's scope,
 * verified, not held back, out-of-date claims removed) run first, and the shortlist is today's
 * ranking followed by records sharing a word with the question (RERANK_SHORTLIST of them). Then:
 *
 *   override  today's ranking shows something, and the reranker is sure (OVERRIDE_P) of a record
 *             clearly ahead of the next (OVERRIDE_MARGIN): that record goes first
 *   keep      otherwise today's ranking stands
 *   none      today's ranking found nothing: nothing is shown, whatever the reranker thinks
 *
 * It never fills an empty result. It did once (a record clearly ahead when nothing else was), and
 * on Gate 3's unseen 12 that showed a related session as the answer to a prompt with none (S03,
 * "Set up Dependabot for the Python packages"): being the only related record is not answering.
 *
 * The thresholds were set on 2026-10-27 from the twelve Gate 3 sets scored before unseen 12
 * (bench/memory-rerank.mjs). A score is a logit; "ahead" is measured against the next record or
 * FLOOR (an unrelated record's typical score), whichever is higher.
 *
 * Without the model (not installed, failed to load, too old a Node), every path is exactly what it
 * was: the scores are simply absent.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Config } from "../config.js";
import { modelDir } from "./embed.js";
import { terms } from "./memory.js";
import { variants, wordForms } from "./retrieve.js";

export const RERANKER = "Xenova/ms-marco-MiniLM-L-6-v2";
export const RERANKER_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
export const RERANK_SHORTLIST = 10;
export const OVERRIDE_P = 0.9;
export const OVERRIDE_MARGIN = 4;
export const FLOOR = -10;

const rerankerPath = (dir = modelDir()) => join(dir, "models", ...RERANKER.split("/"));
/** Test stand-in: shared words decide the score, so the reranker path runs without the library or a download. */
const fake = () => process.env.SNOUT_RERANK_FAKE === "1";

export function rerankReady(dir = modelDir()): boolean {
  if (fake()) return true;
  return existsSync(join(rerankerPath(dir), "onnx", "model_quantized.onnx")) && existsSync(join(dir, "node_modules", "@huggingface", "transformers", "package.json"));
}

/** On once installed, unless the user turned it off (`memoryRerank: false`, SNOUT_MEMORY_RERANK=0). */
export const rerankOn = (cfg: Config): boolean => cfg.memoryRerank !== false && rerankReady();

type Score = (question: string, texts: string[]) => Promise<number[]>;
let loading: Promise<Score> | null = null;

/** Loads the model once per process; later calls share it. */
export function loadReranker(dir = modelDir()): Promise<Score> {
  loading ??= fake() ? Promise.resolve(fakeScore) : realReranker(dir);
  loading.catch(() => { loading = null; });
  return loading;
}

async function realReranker(dir: string): Promise<Score> {
  const entry = createRequire(join(dir, "package.json")).resolve("@huggingface/transformers");
  const mod = (await import(pathToFileURL(entry).href)) as Record<string, any>;
  const m = mod.env ? mod : mod.default;
  m.env.localModelPath = join(dir, "models") + "/";
  m.env.allowRemoteModels = false;
  const tokenizer = await m.AutoTokenizer.from_pretrained(RERANKER);
  const model = await m.AutoModelForSequenceClassification.from_pretrained(RERANKER, { dtype: "q8" });
  return async (question, texts) => {
    if (!texts.length) return [];
    const inputs = tokenizer(new Array(texts.length).fill(question), { text_pair: texts, padding: true, truncation: true, max_length: 256 });
    const { logits } = await model(inputs);
    return Array.from(logits.data as ArrayLike<number>);
  };
}

const fakeScore: Score = async (question, texts) => {
  const q = [...new Set(terms(question))];
  return texts.map((t) => { const f = wordForms(terms(t)); return q.length ? -10 + 14 * (q.filter((w) => variants(w).some((v) => f.has(v))).length / q.length) : -10; });
};

const scores = new Map<string, number>();
const key = (question: string, text: string) => `${question}\u0000${text}`;

/** Scores each text against the question, for rerankChoice. Fails open: on any error there are no scores. */
export async function prepareRerank(question: string, texts: string[], dir = modelDir()): Promise<void> {
  try {
    const todo = [...new Set(texts)].filter((t) => !scores.has(key(question, t)));
    if (!todo.length) return;
    const got = await (await loadReranker(dir))(question, todo);
    todo.forEach((t, i) => { if (Number.isFinite(got[i])) scores.set(key(question, t), got[i]!); });
  } catch { /* today's ranking alone */ }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export type RerankMode = "override" | "keep" | "none";

/**
 * The reranker's verdict on a shortlist (today's ranking first, then other records sharing a word),
 * or undefined when it has no score for every record on it (not installed, not prepared, failed).
 * `current`: how many of the shortlist's first records today's ranking shows.
 */
export function rerankChoice<T>(question: string, shortlist: { item: T; text: string }[], current: number): { mode: RerankMode; item?: T } | undefined {
  if (!shortlist.length || current === 0) return { mode: "none" };
  const scored = shortlist.map((s) => ({ ...s, logit: scores.get(key(question, s.text)) }));
  if (scored.some((s) => s.logit === undefined)) return undefined;
  const ranked = [...scored].sort((a, b) => b.logit! - a.logit!);
  const [top, next] = ranked;
  const margin = top!.logit! - Math.max(next?.logit ?? FLOOR, FLOOR);
  if (sigmoid(top!.logit!) >= OVERRIDE_P && margin >= OVERRIDE_MARGIN) return { mode: "override", item: top!.item };
  return { mode: "keep" };
}

/**
 * Records sharing a word with the question, in any form, most shared first, then the rarer words:
 * the rest of the reranker's shortlist after today's ranking.
 */
export function byWords<T>(question: string, records: { item: T; text: string }[]): T[] {
  const q = [...new Set(terms(question))];
  if (!q.length) return [];
  const forms = records.map((r) => wordForms(terms(r.text)));
  const has = (f: Set<string>, w: string) => variants(w).some((v) => f.has(v));
  const df = new Map(q.map((w) => [w, forms.filter((f) => has(f, w)).length]));
  return records.map((r, i) => {
    const hit = q.filter((w) => has(forms[i]!, w));
    return { r, n: hit.length, idf: hit.reduce((a, w) => a + Math.log(1 + records.length / df.get(w)!), 0) };
  }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || b.idf - a.idf).map((x) => x.r.item);
}

/** Today's ranking, then records sharing a word, each once (by `id`), the first RERANK_SHORTLIST. */
export function shortlist<T>(current: T[], words: T[], id: (t: T) => string): T[] {
  const seen = new Set<string>();
  return [...current, ...words].filter((t) => !seen.has(id(t)) && !!seen.add(id(t))).slice(0, RERANK_SHORTLIST);
}
