#!/usr/bin/env node
/**
 * Memory recall, scored offline: no agent, no model, no subscription use.
 *
 * For each SWE-bench Verified task the map was scored on (bench/ab-results/mapeval-heldout-*.json),
 * memory is what the team had done before the issue was filed: one card per commit on the default
 * branch dated before the issue's created_at (the latest HISTORY of them), with its subject, body
 * and files. Recall is queried with the issue text alone, exactly as the hook would be. A hit is a
 * file the real fix edited (the gold patch) among the recalled files. Commit cards carry less than
 * session cards (no task text, outcome or test command), so this measures the floor of what recall
 * finds, on public history anyone can rerun.
 *
 *   node bench/recalleval.mjs                 # all 485 tasks, paired with the map's rows
 *   node bench/recalleval.mjs --limit 50      # the first 50, for a quick look
 *
 * Reported per ranker (accN = every gold file in the top N files, as in mapeval; anyN = at least one):
 *   recall   files of the recalled cards, ranked by the summed score of the cards that touched them
 *   map      the repo map's row for the same task (from the mapeval file)
 *   fused    reciprocal-rank fusion of recall and map
 * and for the hook as shipped: how often it fires (passes its floor), and when it fires, how often
 * the 3-card brief names a gold file (precision of firing).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { recall, terms } = await import(process.env.MAP_LIB || "../dist/lib.mjs");

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const WIN = process.platform === "win32";
const SWE_PY = process.env.SWE_PY || (WIN ? join(REPO, ".snout/heldout/venv3/Scripts/python.exe") : join(process.env.HOME ?? "", "opt/anaconda3/envs/swebench/bin/python"));
const PRELUDE = WIN ? "import sys, types\nsys.modules.setdefault('resource', types.ModuleType('resource'))\n" : "";
const CLONES = process.env.CLONES || join(tmpdir(), "snout-recall-clones");
const HISTORY = 3000;
const KS = [1, 3, 5, 10];
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const LIMIT = Number(arg("--limit") ?? Infinity);
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, ...o });

const resultsDir = join(REPO, "bench/ab-results");
const mapFile = readdirSync(resultsDir).filter((f) => /^mapeval-heldout-\d+\.json$/.test(f)).sort().pop();
const mapRows = new Map(JSON.parse(readFileSync(join(resultsDir, mapFile), "utf8")).rows.map((r) => [r.task, r]));

const dump = JSON.parse(sh(SWE_PY, ["-c", `${PRELUDE}
import json, re
from swebench.harness.utils import load_swebench_dataset
ds = load_swebench_dataset("SWE-bench/SWE-bench_Verified", "test")
print(json.dumps([{"instance_id": d["instance_id"], "repo": d["repo"], "base_commit": d["base_commit"], "created_at": d["created_at"], "problem_statement": d["problem_statement"], "gold": sorted(set(re.findall(r"^diff --git a/(\\S+) b/", d["patch"], re.M)))} for d in ds]))
`]).stdout);
const tasks = dump.filter((d) => mapRows.has(d.instance_id)).sort((a, b) => a.repo.localeCompare(b.repo) || a.created_at.localeCompare(b.created_at)).slice(0, LIMIT);

/** Every commit reachable from the default branch, oldest first, with its files. */
function history(repo) {
  const dir = join(CLONES, repo.replace("/", "__"));
  if (!existsSync(dir)) {
    mkdirSync(CLONES, { recursive: true });
    console.error(`cloning ${repo} (history only)...`);
    const c = sh("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `https://github.com/${repo}.git`, dir], { timeout: 3600_000 });
    if (c.status !== 0) throw new Error(`clone ${repo}: ${c.stderr}`);
  }
  const out = sh("git", ["log", "--no-merges", "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f", "--name-only", "HEAD"], { cwd: dir }).stdout;
  const commits = [];
  for (const rec of out.split("\x1e")) {
    const [sha, ts, subject, body, rest] = rec.split("\x1f");
    if (!sha || !ts) continue;
    commits.push({ sha: sha.trim(), ts, t: Date.parse(ts), subject: subject ?? "", body: (body ?? "").replace(/\s+/g, " ").trim().slice(0, 300), files: (rest ?? "").split("\n").map((l) => l.trim()).filter(Boolean) });
  }
  return { dir, commits: commits.sort((a, b) => a.t - b.t) };
}

const cardOf = (c) => ({
  v: 1, id: c.sha, session: c.sha, agent: "claude", started: c.ts, updated: c.ts,
  task: c.body ? `${c.subject} ${c.body}` : c.subject, changed: [], rules: [],
  commits: [{ sha: c.sha, subject: c.subject, ts: c.ts, files: c.files }],
});

function rankFiles(hits, exists) {
  const score = new Map();
  for (const h of hits) {
    const files = h.card.commits.flatMap((k) => k.files).filter(exists);
    for (const f of files) score.set(f, (score.get(f) ?? 0) + h.score / Math.sqrt(files.length));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

const fuse = (...lists) => {
  const s = new Map();
  for (const l of lists) l.forEach((f, i) => s.set(f, (s.get(f) ?? 0) + 1 / (60 + i)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
};

const at = (ranked, gold) => Object.fromEntries(KS.flatMap((k) => {
  const top = new Set(ranked.slice(0, k));
  return [[`acc${k}`, gold.every((g) => top.has(g)) ? 1 : 0], [`any${k}`, gold.some((g) => top.has(g)) ? 1 : 0]];
}));

// --embed: also rank cards by a local embedding model (EMBED = a folder with @huggingface/transformers
// installed and the model under models/). Not a dependency of Snout: the eval decides whether it earns one.
const MODEL = process.env.EMBED_MODEL || "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX = MODEL.includes("bge") ? "Represent this sentence for searching relevant passages: " : "";
let embed = null;
if (process.argv.includes("--embed")) {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const base = process.env.EMBED;
  if (!base) throw new Error("--embed needs EMBED=<folder with @huggingface/transformers and models/>");
  const mod = await import(pathToFileURL(createRequire(join(base, "package.json")).resolve("@huggingface/transformers")).href);
  const m = mod.env ? mod : mod.default;
  m.env.localModelPath = join(base, "models") + "/";
  m.env.allowRemoteModels = false;
  const pipe = await m.pipeline("feature-extraction", MODEL, { dtype: "q8" });
  embed = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 64) {
      const o = await pipe(texts.slice(i, i + 64), { pooling: MODEL.includes("bge") ? "cls" : "mean", normalize: true });
      const d = o.dims[1];
      for (let j = 0; j < o.dims[0]; j++) out.push(o.data.slice(j * d, (j + 1) * d));
    }
    return out;
  };
}
const vecs = new Map();
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const rrf = (...lists) => {
  const s = new Map();
  for (const l of lists) l.forEach((c, i) => s.set(c.id, { card: c, score: (s.get(c.id)?.score ?? 0) + 1 / (60 + i) }));
  return [...s.values()].sort((a, b) => b.score - a.score);
};

/** What a ranking of cards gives the agent: the 3-card brief, and the files ranked for scoring. */
function judge(hits, t, exists, mapTop) {
  const ranked = rankFiles(hits.slice(0, 10), exists);
  const brief = [...new Set(hits.slice(0, 3).flatMap((h) => h.card.commits.flatMap((k) => k.files).filter(exists).slice(0, 8)))];
  return {
    briefHit: t.gold.some((g) => brief.includes(g)), agree: brief.some((f) => mapTop.includes(f)),
    top: hits[0]?.score ?? 0, acc: at(ranked, t.gold), fused: at(fuse(ranked, mapTop), t.gold),
    newHit: t.gold.some((g) => brief.includes(g) && !mapTop.includes(g)),
  };
}

const histories = new Map();
const rows = [];
for (const t of tasks) {
  if (!histories.has(t.repo)) histories.set(t.repo, history(t.repo));
  const { dir, commits } = histories.get(t.repo);
  const cutoff = Date.parse(t.created_at);
  let hi = commits.findIndex((c) => c.t >= cutoff);
  if (hi < 0) hi = commits.length;
  const window = commits.slice(Math.max(0, hi - HISTORY), hi);
  const cards = window.map(cardOf);
  const atBase = new Set(sh("git", ["ls-tree", "-r", "--name-only", t.base_commit], { cwd: dir }).stdout.split("\n").filter(Boolean));
  const exists = (f) => atBase.has(f);
  const m = mapRows.get(t.instance_id);
  const mapTop = m.top3 ?? [];
  const t0 = Date.now();
  const words = recall(cards, t.problem_statement, { asOf: t.created_at, limit: 50 });
  const ms = Date.now() - t0;
  const row = {
    task: t.instance_id, repo: t.repo, gold: t.gold, cards: cards.length, ms, queryTerms: new Set(terms(t.problem_statement)).size,
    mapTop, map: Object.fromEntries(KS.map((k) => [`acc${k}`, m.map[`acc${k}`]])),
    words: judge(words, t, exists, mapTop),
  };
  if (embed) {
    const missing = window.filter((c) => !vecs.has(c.sha));
    const got = await embed(missing.map((c) => `${c.subject} ${c.body}`.slice(0, 600)));
    missing.forEach((c, i) => vecs.set(c.sha, got[i]));
    const e0 = Date.now();
    const [q] = await embed([QUERY_PREFIX + t.problem_statement.slice(0, 2000)]);
    const meaning = cards.map((c) => ({ card: c, score: dot(q, vecs.get(c.id)) })).sort((a, b) => b.score - a.score).slice(0, 50);
    row.embedMs = Date.now() - e0;
    row.meaning = judge(meaning, t, exists, mapTop);
    row.hybrid = judge(rrf(words.map((h) => h.card), meaning.map((h) => h.card)), t, exists, mapTop);
  }
  rows.push(row);
  if (rows.length % 25 === 0) console.error(`${rows.length}/${tasks.length}`);
}

const pct = (xs) => `${(100 * xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(1)}%`;
const n = rows.length;
const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\nMemory recall, offline, ${n} SWE-bench Verified tasks (commit history before each issue, ${HISTORY} commits max)`);
console.log(`median query time: words ${med(rows.map((r) => r.ms))} ms${embed ? `, meaning ${med(rows.map((r) => r.embedMs))} ms (${MODEL})` : ""}\n`);
const rankers = ["words", ...(embed ? ["meaning", "hybrid"] : [])];
console.log("  ranker    brief-hit | gated by map: fires  precision  hits kept  new | acc1   acc5   acc10 | +map acc5");
for (const k of rankers) {
  const all = rows.map((r) => r[k]);
  const on = all.filter((x) => x.agree);
  const hits = all.filter((x) => x.briefHit).length;
  console.log(`  ${k.padEnd(9)} ${pct(all.map((x) => +x.briefHit)).padStart(8)} | ${pct(all.map((x) => +x.agree)).padStart(18)} ${pct(on.map((x) => +x.briefHit)).padStart(10)} ${(100 * on.filter((x) => x.briefHit).length / Math.max(1, hits)).toFixed(1).padStart(9)}% ${String(on.filter((x) => x.newHit).length).padStart(4)} | ${pct(all.map((x) => x.acc.acc1)).padStart(5)} ${pct(all.map((x) => x.acc.acc5)).padStart(6)} ${pct(all.map((x) => x.acc.acc10)).padStart(6)} | ${pct(all.map((x) => x.fused.acc5)).padStart(8)}`);
}
console.log(`  map                                                                     | ${pct(rows.map((r) => r.map.acc1)).padStart(5)} ${pct(rows.map((r) => r.map.acc5)).padStart(6)} ${pct(rows.map((r) => r.map.acc10)).padStart(6)} |`);
// Does the top score know when the brief is right? Precision by quintile of the top score, gated.
for (const k of rankers) {
  const on = rows.map((r) => r[k]).filter((x) => x.agree).sort((a, b) => a.top - b.top);
  const q = (i) => on.slice(Math.floor(i * on.length / 5), Math.floor((i + 1) * on.length / 5));
  console.log(`  ${k} gated, precision by top-score fifth (low → high): ${[0, 1, 2, 3, 4].map((i) => pct(q(i).map((x) => +x.briefHit))).join("  ")}`);
}
const file = join(resultsDir, `recalleval-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ measuredAt: new Date().toISOString(), history: HISTORY, mapFile, model: embed ? MODEL : null, rows }, null, 1));
console.log(`\n  rows: ${file}`);
