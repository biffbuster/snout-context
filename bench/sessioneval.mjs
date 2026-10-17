#!/usr/bin/env node
/**
 * Memory recall on real agent sessions, scored offline: no agent run, no API call.
 *
 * Memory is the public trajectories one agent left on SWE-bench Verified (the swe-bench-submissions
 * bucket, one long session per task). For each task the map was scored on, the cards are the sessions
 * on earlier issues of the same repository (created before this issue), each written the way Snout
 * writes a card at Stop: the request, how the session ended in the agent's last words, and the files
 * its patch changed. The task's own session is never among them. Recall is queried with the issue
 * text, and a hit is a file the real fix edited among the files the brief names.
 *
 *   node bench/sessioneval.mjs                 # all paired tasks, words only
 *   node bench/sessioneval.mjs --embed         # also meaning and hybrid (needs the memory model)
 *   SUB=<submission> node bench/sessioneval.mjs --limit 50
 *
 * The model is read from EMBED, or from where `snout memory model install` put it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { recall, hybridRecall, embedText, HYBRID_CUT } = await import(process.env.MAP_LIB || "../dist/lib.mjs");

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const WIN = process.platform === "win32";
const SWE_PY = process.env.SWE_PY || (WIN ? join(REPO, ".snout/heldout/venv3/Scripts/python.exe") : join(process.env.HOME ?? "", "opt/anaconda3/envs/swebench/bin/python"));
const PRELUDE = WIN ? "import sys, types\nsys.modules.setdefault('resource', types.ModuleType('resource'))\n" : "";
const SUB = process.env.SUB || "bash-only/20260217_mini-v2.0.0_claude-4-5-sonnet-high";
const BUCKET = "https://swe-bench-submissions.s3.amazonaws.com";
const CACHE = join(process.env.TRAJS || join(tmpdir(), "snout-session-trajs"), SUB.replace(/\//g, "__"));
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
print(json.dumps([{"instance_id": d["instance_id"], "repo": d["repo"], "created_at": d["created_at"], "problem_statement": d["problem_statement"], "gold": sorted(set(re.findall(r"^diff --git a/(\\S+) b/", d["patch"], re.M)))} for d in ds]))
`]).stdout);

// ---------- The sessions: one trajectory per task, downloaded once ----------

mkdirSync(CACHE, { recursive: true });
const want = dump.map((d) => d.instance_id).filter((id) => !existsSync(join(CACHE, `${id}.json`)));
if (want.length) console.error(`downloading ${want.length} trajectories of ${SUB} to ${CACHE} ...`);
for (let i = 0; i < want.length; i += 16) {
  // curl, several at a time: Node's fetch stalls on some networks (IPv6).
  const batch = want.slice(i, i + 16);
  const args = ["-sS", "--parallel", "--max-time", "120", ...batch.flatMap((id) => ["-o", join(CACHE, `${id}.json`), `${BUCKET}/${SUB}/trajs/${id}/${id}.traj.json`])];
  sh("curl", args, { timeout: 600_000 });
  if ((i / 16) % 5 === 4) console.error(`  ${Math.min(i + 16, want.length)}/${want.length}`);
}

const diffFiles = (patch) => [...new Set([...(patch ?? "").matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]))];

/** A trajectory as the card Snout would have written at the session's Stop. */
function sessionCard(d) {
  let t;
  try { t = JSON.parse(readFileSync(join(CACHE, `${d.instance_id}.json`), "utf8")); } catch { return null; }
  const msgs = t.messages ?? [];
  const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join(" ") : "");
  const patch = text(msgs.findLast((m) => m.role === "exit") ?? {}) || t.info?.submission || "";
  const last = msgs.filter((m) => m.role === "assistant").map(text).map((s) => s.replace(/```[\s\S]*?```/g, " ").trim()).findLast((s) => s.length >= 20);
  const changed = diffFiles(patch).filter((f) => !/^(reproduce|test_|debug)[^/]*\.py$/.test(f)).slice(0, 20);
  if (!changed.length && !last) return null;
  return {
    v: 1, id: d.instance_id, session: d.instance_id, agent: "claude", started: d.created_at, updated: d.created_at,
    task: d.problem_statement.replace(/\s+/g, " ").trim().slice(0, 300), outcome: last?.replace(/\s+/g, " ").slice(0, 600),
    changed, rules: [], commits: [],
  };
}

const cards = new Map(dump.map((d) => [d.instance_id, sessionCard(d)]).filter(([, c]) => c));
const repoOf = new Map(dump.map((d) => [d.instance_id, d.repo]));
console.error(`${cards.size}/${dump.length} trajectories made a card`);

const tasks = dump.filter((d) => mapRows.has(d.instance_id)).sort((a, b) => a.repo.localeCompare(b.repo) || a.created_at.localeCompare(b.created_at)).slice(0, LIMIT);

// ---------- Optional: the memory model ----------

let embed = null;
if (process.argv.includes("--embed")) {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const base = process.env.EMBED || join(process.env.SNOUT_CONFIG_DIR || (WIN ? join(process.env.APPDATA ?? "", "snout") : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "snout")), "model");
  const mod = await import(pathToFileURL(createRequire(join(base, "package.json")).resolve("@huggingface/transformers")).href);
  const m = mod.env ? mod : mod.default;
  m.env.localModelPath = join(base, "models") + "/";
  m.env.allowRemoteModels = false;
  const pipe = await m.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
  embed = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const o = await pipe(texts.slice(i, i + 32), { pooling: "cls", normalize: true });
      for (let j = 0; j < o.dims[0]; j++) out.push(o.data.slice(j * o.dims[1], (j + 1) * o.dims[1]));
    }
    return out;
  };
}
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const vecs = new Map();
if (embed) {
  const all = [...cards.values()];
  const got = await embed(all.map(embedText));
  all.forEach((c, i) => vecs.set(c.id, got[i]));
}

// ---------- Scoring ----------

const filesOf = (c) => [...new Set([...c.changed, ...c.commits.flatMap((k) => k.files)])];
const fuse = (...lists) => {
  const s = new Map();
  for (const l of lists) l.forEach((f, i) => s.set(f, (s.get(f) ?? 0) + 1 / (60 + i)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
};
const at = (ranked, gold) => Object.fromEntries(KS.map((k) => [`acc${k}`, gold.every((g) => ranked.slice(0, k).includes(g)) ? 1 : 0]));
function rankFiles(hits) {
  const score = new Map();
  for (const h of hits) for (const f of filesOf(h.card)) score.set(f, (score.get(f) ?? 0) + h.score / Math.sqrt(filesOf(h.card).length));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}
function judge(hits, t, mapTop) {
  const brief = [...new Set(hits.slice(0, 3).flatMap((h) => filesOf(h.card).slice(0, 8)))];
  const ranked = rankFiles(hits.slice(0, 10));
  return {
    fires: hits.length > 0, top: hits[0]?.score ?? 0,
    briefHit: t.gold.some((g) => brief.includes(g)), agree: brief.some((f) => mapTop.includes(f)),
    newHit: t.gold.some((g) => brief.includes(g) && !mapTop.includes(g)),
    acc: at(ranked, t.gold), fused: at(fuse(ranked, mapTop), t.gold),
  };
}

const rows = [];
for (const t of tasks) {
  const earlier = [...cards.values()].filter((c) => c.id !== t.instance_id && repoOf.get(c.id) === t.repo && c.started < t.created_at);
  const m = mapRows.get(t.instance_id);
  const mapTop = m.top3 ?? [];
  const row = {
    task: t.instance_id, repo: t.repo, gold: t.gold, cards: earlier.length,
    ceiling: earlier.some((c) => t.gold.some((g) => filesOf(c).includes(g))),
    map: Object.fromEntries(KS.map((k) => [`acc${k}`, m.map[`acc${k}`]])),
  };
  const opts = { asOf: t.created_at, limit: 50 };
  row.words = judge(recall(earlier, t.problem_statement, opts), t, mapTop);
  if (embed) {
    const [q] = await embed([QUERY_PREFIX + t.problem_statement.slice(0, 2000)]);
    const v = { query: q, cards: new Map(earlier.map((c) => [c.id, vecs.get(c.id)])) };
    const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
    const meaning = earlier.map((c) => ({ card: c, score: dot(q, v.cards.get(c.id)) })).sort((a, b) => b.score - a.score).slice(0, 50);
    row.meaning = judge(meaning, t, mapTop);
    row.hybrid = judge(hybridRecall(earlier, t.problem_statement, v, { ...opts, limit: 50 }), t, mapTop);
  }
  rows.push(row);
  if (rows.length % 50 === 0) console.error(`${rows.length}/${tasks.length}`);
}

// ---------- Report ----------

const n = rows.length;
const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
const mean = (xs) => pct(xs.reduce((a, b) => a + b, 0), xs.length);
console.log(`\nMemory recall on real agent sessions, offline: ${n} SWE-bench Verified tasks, memory = ${SUB.split("/").pop()} sessions on earlier issues of the same repo`);
console.log(`median ${[...rows.map((r) => r.cards)].sort((a, b) => a - b)[n >> 1]} earlier sessions per task; an earlier session touched a needed file on ${mean(rows.map((r) => +r.ceiling))} of tasks (the ceiling)\n`);
console.log("  ranker    fires  brief-hit | map agrees: fires  precision  new | acc1   acc5  | +map acc5");
for (const k of ["words", ...(embed ? ["meaning", "hybrid"] : [])]) {
  const all = rows.map((r) => r[k]);
  const on = all.filter((x) => x.agree);
  console.log(`  ${k.padEnd(8)} ${mean(all.map((x) => +x.fires)).padStart(6)} ${mean(all.map((x) => +x.briefHit)).padStart(9)} | ${pct(on.length, n).padStart(16)} ${pct(on.filter((x) => x.briefHit).length, on.length).padStart(10)} ${String(on.filter((x) => x.newHit).length).padStart(4)} | ${mean(all.map((x) => x.acc.acc1)).padStart(5)} ${mean(all.map((x) => x.acc.acc5)).padStart(6)} | ${mean(all.map((x) => x.fused.acc5)).padStart(8)}`);
}
console.log(`  map                                                            | ${mean(rows.map((r) => r.map.acc1)).padStart(5)} ${mean(rows.map((r) => r.map.acc5)).padStart(6)} |`);
const ship = [["words, map agrees", (r) => r.words.agree && r.words.fires, "words"], ...(embed ? [[`hybrid >= ${HYBRID_CUT}, map agrees`, (r) => r.hybrid.agree && r.hybrid.top >= HYBRID_CUT, "hybrid"]] : [])];
console.log("\n  shipped gate                      fires   precision");
for (const [name, on, k] of ship) {
  const f = rows.filter(on);
  console.log(`  ${name.padEnd(32)} ${pct(f.length, n).padStart(6)}   ${pct(f.filter((r) => r[k].briefHit).length, f.length).padStart(8)}`);
}
const file = join(resultsDir, `sessioneval-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ measuredAt: new Date().toISOString(), submission: SUB, mapFile, model: embed ? "Xenova/bge-small-en-v1.5" : null, rows }, null, 1));
console.log(`\n  rows: ${file}`);
