#!/usr/bin/env node
/**
 * Calibrates the bytes-per-token ratios in src/ledger/tokens.ts against Claude's real
 * tokenizer. Every token number snout reports is `bytes / ratio`, so these ratios decide
 * whether the `~` on each figure is defensible.
 *
 * Method:
 *   1. For each file extension the estimator keys on (plus the common ones it doesn't),
 *      sample up to N files from the corpus, spread across repos.
 *   2. Count each sample's tokens with the `count_tokens` endpoint — the real tokenizer
 *      for the model, not an approximation. Token counting generates nothing.
 *   3. Measured ratio = total bytes / total tokens per extension. Compare with the ratio
 *      currently shipped and report the error of the current estimate.
 *
 * Samples are the corpus's 2 KB heads, trimmed to whole lines. That is a sample of the
 * file, not the whole file, which is fine for a ratio: tokens per byte do not depend on
 * where in a file you look, give or take a license header.
 *
 * Gate: every extension with enough samples must be within ±10% (exit code 1 otherwise).
 *
 * Usage:
 *   node bench/tokens.mjs                  # 20 samples per extension
 *   node bench/tokens.mjs --n 5            # quick smoke test
 *   node bench/tokens.mjs --holdout        # validate on different files than calibration used
 *   node bench/tokens.mjs --model claude-opus-5
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { ratioFor } from "../dist/lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const PER_EXT = Number(args.n ?? 20);
/**
 * Calibration takes each repo's first 3 files per extension; --holdout skips those and
 * takes the next 3. Re-checking ratios on the files they were fitted to would pass by
 * construction, so the pass that counts is the holdout one.
 */
const HOLDOUT = "holdout" in args;
const MODEL = args.model || "claude-opus-5"; // same tokenizer as the Opus/Fable models Claude Code runs
const CONCURRENCY = 4;
const GATE = 0.1;
/** Below this many samples an extension is reported but not gated: too noisy to judge. */
const MIN_GATED = Math.min(10, PER_EXT);

/**
 * The extensions the estimator has a ratio for, plus the common corpus extensions that
 * currently fall back to the default. `(none)` is files with no extension (Makefile,
 * LICENSE, ...); `lock` and `sum` are lockfiles keyed by extension (yarn.lock, go.sum).
 */
const EXTENSIONS = [
  "json", "lock", "csv", "svg", "yaml", "yml", "ts", "tsx", "js", "jsx", "py", "go", "rs",
  "java", "rb", "c", "h", "cpp", "sql", "html", "css", "md", "txt",
  "kt", "cs", "php", "swift", "sh", "toml", "xml", "rst", "sum", "(none)",
];

const CORPUS_DIR = new URL("./corpus/", import.meta.url);

function extOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m?.[1]?.toLowerCase() ?? "(none)";
}

/** Whole lines of valid UTF-8 text from a head, or null if it isn't text worth sampling. */
function textSample(headB64) {
  const buf = Buffer.from(headB64, "base64");
  if (buf.length < 512 || buf.includes(0)) return null;
  let text = buf.toString("utf8");
  const cut = text.lastIndexOf("\n");
  if (cut > 0) text = text.slice(0, cut + 1); // drop a partial last line and any split UTF-8 char
  if (text.includes("�")) return null;
  return text;
}

/** Up to PER_EXT samples per extension, round-robin across repos so one repo can't dominate. */
function sample() {
  const byExt = new Map(EXTENSIONS.map((e) => [e, new Map()]));
  for (const slug of readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"))) {
    const corpus = JSON.parse(readFileSync(new URL(slug, CORPUS_DIR), "utf8"));
    for (const f of corpus.files) {
      const perRepo = byExt.get(extOf(f.path));
      if (!perRepo || f.headB64 == null) continue;
      const repo = `${corpus.owner}/${corpus.repo}`;
      const list = perRepo.get(repo) ?? [];
      if (list.length < 6) list.push({ repo, path: f.path, headB64: f.headB64 });
      perRepo.set(repo, list);
    }
  }
  const out = [];
  for (const [ext, perRepo] of byExt) {
    const queues = [...perRepo.values()].map((q) => (HOLDOUT ? q.slice(3) : q.slice(0, 3)));
    const picked = [];
    for (let round = 0; picked.length < PER_EXT && queues.some((q) => q.length > 0); round++) {
      for (const q of queues) {
        if (picked.length >= PER_EXT) break;
        const f = q.shift();
        if (!f) continue;
        const text = textSample(f.headB64);
        if (text) picked.push({ ext, repo: f.repo, path: f.path, text, bytes: Buffer.byteLength(text) });
      }
    }
    out.push(...picked);
  }
  return out;
}

const client = new Anthropic({ maxRetries: 6 });

async function count(text) {
  const r = await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: text }] });
  return r.input_tokens;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const samples = sample();
  console.error(`Sampled ${samples.length} ${HOLDOUT ? "holdout " : ""}files across ${EXTENSIONS.length} extensions. Counting with ${MODEL}...`);

  // The request wraps the text in a message, which costs a few tokens of its own. Measure
  // that once and subtract it from every sample: a one-character message is 1 token of text.
  let overhead;
  try {
    overhead = (await count("a")) - 1;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err.message)) {
      throw new Error(`Anthropic auth failed: ${err.message}\nSet ANTHROPIC_API_KEY and re-run.`);
    }
    throw err;
  }

  let done = 0;
  const counted = await pool(samples, CONCURRENCY, async (s) => {
    let tokens = null;
    let error;
    try {
      tokens = (await count(s.text)) - overhead;
    } catch (err) {
      error = `${err.status ?? ""} ${err.message}`.trim().slice(0, 200);
    }
    done += 1;
    process.stderr.write(`\r${done}/${samples.length}`);
    return { ...s, text: undefined, tokens, error };
  });
  process.stderr.write("\n");

  const rows = [];
  for (const ext of EXTENSIONS) {
    const ok = counted.filter((c) => c.ext === ext && c.tokens > 0);
    if (ok.length === 0) continue;
    const bytes = ok.reduce((a, c) => a + c.bytes, 0);
    const tokens = ok.reduce((a, c) => a + c.tokens, 0);
    const measured = bytes / tokens;
    const current = ratioFor(ext === "(none)" ? "Makefile" : `x.${ext}`);
    // What the shipped estimate reports relative to the real count: +20% means over-reporting.
    const error = measured / current - 1;
    const perFile = ok.map((c) => c.bytes / c.tokens).sort((a, b) => a - b);
    rows.push({
      ext,
      n: ok.length,
      measured: Number(measured.toFixed(2)),
      current,
      error: Number(error.toFixed(3)),
      p10: Number(perFile[Math.floor(perFile.length * 0.1)].toFixed(2)),
      p90: Number(perFile[Math.min(perFile.length - 1, Math.floor(perFile.length * 0.9))].toFixed(2)),
      gated: ok.length >= MIN_GATED,
    });
  }

  const outDir = new URL("./tokens/", import.meta.url);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = new URL(`./ratios-${Date.now()}.json`, outDir);
  const errors = counted.filter((c) => c.error);
  writeFileSync(outFile, JSON.stringify({ model: MODEL, measuredAt: new Date().toISOString(), overhead, rows, errors }, null, 2));

  const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
  console.log(`\nBytes per token, ${MODEL}. Full results: ${outFile.pathname}\n`);
  console.log("  ext        n   measured   current   estimate is   per-file p10–p90");
  for (const r of rows) {
    const flag = !r.gated ? "  (few samples)" : Math.abs(r.error) > GATE ? "  ✗" : "";
    console.log(
      `  ${r.ext.padEnd(8)} ${String(r.n).padStart(3)} ${r.measured.toFixed(2).padStart(10)} ${r.current.toFixed(2).padStart(9)} ${pct(r.error).padStart(13)}   ${r.p10.toFixed(2)}–${r.p90.toFixed(2)}${flag}`,
    );
  }
  if (errors.length > 0) console.log(`\n  ${errors.length} sample(s) failed to count; see the results file.`);

  const failing = rows.filter((r) => r.gated && Math.abs(r.error) > GATE);
  console.log("");
  if (failing.length === 0) {
    console.log(`PASS: every extension with ≥${MIN_GATED} samples is within ±${GATE * 100}%.`);
  } else {
    console.log(`FAIL: ${failing.length} extension(s) off by more than ±${GATE * 100}%: ${failing.map((r) => r.ext).join(", ")}.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
