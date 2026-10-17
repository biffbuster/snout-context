import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { configDir } from "../config.js";
import { terms } from "./memory.js";

/**
 * The optional local embedding model for memory recall (`snout memory model install`). Nothing here
 * runs unless the user installed it: Snout ships without the library or the model, and hooks never
 * download anything. The model loads once inside `snout serve`, which hook processes ask for vectors.
 */
export const MODEL = "Xenova/bge-small-en-v1.5";
const LIBRARY = "@huggingface/transformers@3.8.1";
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
/** bge models rank passages for a query only when the query carries this instruction. */
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export const modelDir = (): string => join(configDir(), "model");
const modelPath = (dir = modelDir()) => join(dir, "models", ...MODEL.split("/"));

/** Test stand-in: a hashed bag of words, so the vector path runs without the library or a download. */
const fake = () => process.env.SNOUT_EMBED_FAKE === "1";

export function modelReady(dir = modelDir()): boolean {
  if (fake()) return true;
  return existsSync(join(modelPath(dir), "onnx", "model_quantized.onnx")) && existsSync(join(dir, "node_modules", "@huggingface", "transformers", "package.json"));
}

type Embed = (texts: string[]) => Promise<Float32Array[]>;
let loading: Promise<Embed> | null = null;

/** Loads the model once per process; later calls share it. */
export function loadEmbedder(dir = modelDir()): Promise<Embed> {
  loading ??= (fake() ? Promise.resolve(fakeEmbed) : realEmbedder(dir));
  loading.catch(() => { loading = null; });
  return loading;
}

async function realEmbedder(dir: string): Promise<Embed> {
  const entry = createRequire(join(dir, "package.json")).resolve("@huggingface/transformers");
  const mod = (await import(pathToFileURL(entry).href)) as Record<string, any>;
  const m = mod.env ? mod : mod.default;
  m.env.localModelPath = join(dir, "models") + "/";
  m.env.allowRemoteModels = false;
  const pipe = await m.pipeline("feature-extraction", MODEL, { dtype: "q8" });
  return async (texts) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const o = await pipe(texts.slice(i, i + 32), { pooling: "cls", normalize: true });
      const d = o.dims[1] as number;
      for (let j = 0; j < o.dims[0]; j++) out.push(Float32Array.from(o.data.slice(j * d, (j + 1) * d)));
    }
    return out;
  };
}

const fakeEmbed: Embed = async (texts) => texts.map((t) => {
  const v = new Float32Array(64);
  for (const w of terms(t.replace(QUERY_PREFIX, ""))) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
});

/** Downloads one file with Node's fetch, or with curl when fetch can't reach the host (IPv6 and some proxies). */
async function download(url: string, file: string): Promise<void> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return;
  } catch { /* try curl */ }
  const c = spawnSync("curl", ["-sSfL", "--max-time", "300", "-o", file, url], { stdio: "ignore", windowsHide: true });
  if (c.status !== 0) throw new Error(`could not download ${url}`);
}

/**
 * Installs the library with npm and the model files from Hugging Face into the per-user config folder.
 * About 34 MB of model plus the ONNX runtime the library brings (a few hundred MB on disk).
 */
export async function installModel(log: (s: string) => void, dir = modelDir()): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), '{ "name": "snout-model", "private": true }\n');
  if (!existsSync(join(dir, "node_modules", "@huggingface", "transformers", "package.json"))) {
    log(`Installing ${LIBRARY} into ${dir} ...`);
    const npm = spawnSync("npm", ["install", LIBRARY, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
    if (npm.status !== 0) throw new Error("npm install failed (is npm on PATH?)");
  }
  for (const f of MODEL_FILES) {
    const file = join(modelPath(dir), ...f.split("/"));
    if (existsSync(file)) continue;
    mkdirSync(join(file, ".."), { recursive: true });
    log(`Downloading ${MODEL}/${f} ...`);
    await download(`https://huggingface.co/${MODEL}/resolve/main/${f}`, `${file}.part`);
    renameSync(`${file}.part`, file);
  }
}

export function removeModel(dir = modelDir()): boolean {
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
