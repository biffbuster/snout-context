/**
 * Meaning for automatic notes (opt-in: `memorySemantic` in the config, and `snout memory model
 * install`). The local model (bge-small, embed.ts) turns a prompt and each verified note into
 * vectors; when no note fits the prompt on its rules, the closest one in meaning may be given, at a
 * high similarity only (facts.ts, NOTE_MEANING). Search and `snout recall` don't use it: there
 * meaning alone answered prompts it shouldn't. Nothing leaves the machine.
 *
 * The hooks are short processes, so they ask the warm model in `snout serve` for vectors over
 * localhost and give up after a few seconds: no answer means words alone, never a failed prompt.
 * Record vectors are cached in
 * `.snout/semantic-vectors.json` by their text; a question's vector is computed each time.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { HOOK_PORT } from "../gate/install.js";
import { writeAtomic } from "../util/atomic.js";
import { loadEmbedder, MODEL, modelReady, QUERY_PREFIX } from "./embed.js";

const SERVE_TIMEOUT_MS = 3000;
const key = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const vectors = new Map<string, Float32Array>();
const queryKey = (q: string) => `q:${key(q)}`;

export const semanticOn = (cfg: Config): boolean => cfg.memorySemantic === true && modelReady();

const pack = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const unpack = (s: string) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

/** Vectors from the warm model in `snout serve`, or, when allowed, from the model loaded here. Null on any failure. */
async function embed(texts: string[], inProcess: boolean): Promise<Float32Array[] | null> {
  if (!texts.length) return [];
  try {
    const r = await fetch(`http://127.0.0.1:${HOOK_PORT}/snout/v1/embed`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts }), signal: AbortSignal.timeout(SERVE_TIMEOUT_MS),
    });
    if (r.ok) {
      const body = (await r.json()) as { vectors?: string[] };
      if (Array.isArray(body.vectors) && body.vectors.length === texts.length) return body.vectors.map(unpack);
    }
  } catch { /* not running, or too slow */ }
  if (!inProcess || !modelReady()) return null;
  try {
    return await (await loadEmbedder())(texts);
  } catch {
    return null;
  }
}

interface Cache { model: string; vectors: Record<string, string> }
const cacheFile = (snoutDir: string) => join(snoutDir, "semantic-vectors.json");

/**
 * Makes the question's vector and every record's available to `meaning()`. Record vectors come
 * from the cache when their text is unchanged. Fails open: on any error, `meaning()` has nothing.
 */
export async function prepareMeaning(snoutDir: string, question: string, records: string[], inProcess = false): Promise<void> {
  try {
    let cache: Cache = { model: MODEL, vectors: {} };
    try {
      const c = JSON.parse(readFileSync(cacheFile(snoutDir), "utf8")) as Cache;
      if (c.model === MODEL && c.vectors && typeof c.vectors === "object") cache = c;
    } catch { /* none yet */ }
    const texts = [...new Set(records)];
    for (const t of texts) { const v = cache.vectors[key(t)]; if (v) vectors.set(key(t), unpack(v)); }
    const missing = texts.filter((t) => !vectors.has(key(t)));
    const got = await embed([`${QUERY_PREFIX}${question}`, ...missing], inProcess);
    if (!got) return;
    vectors.set(queryKey(question), got[0]!);
    missing.forEach((t, i) => { vectors.set(key(t), got[i + 1]!); cache.vectors[key(t)] = pack(got[i + 1]!); });
    if (missing.length) writeAtomic(cacheFile(snoutDir), JSON.stringify(cache));
  } catch { /* words alone */ }
}

/** Whether the local model ran for this question: then any record may match on meaning alone. */
export const meaningPrepared = (question: string): boolean => vectors.has(queryKey(question));

/** Cosine similarity of a question and a record prepared by prepareMeaning, or undefined. */
export function meaning(question: string, record: string): number | undefined {
  const a = vectors.get(queryKey(question));
  const b = vectors.get(key(record));
  if (!a || !b) return undefined;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
