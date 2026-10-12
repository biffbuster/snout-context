#!/usr/bin/env node
/**
 * Repo map, scored offline: no agent, no model, no subscription use.
 *
 * For each SWE-bench Verified task, the map is built over the repository at the task's base
 * commit and queried with the issue text alone. A hit is a file the real fix edited (from the
 * dataset's gold patch) appearing among the candidates. This is CorpusMap's document recall
 * (Jeong et al., 2026) for code. Baselines get the same issue text:
 *   bm25    BM25 over each file's identifiers (the "raw corpus with candidates" baseline)
 *   grep    files ranked by how many distinct issue identifiers they contain
 *
 *   node bench/mapeval.mjs                  # the tasks in bench/swe-tasks.json
 *   node bench/mapeval.mjs --keep           # keep the extracted repositories
 *   node bench/mapeval.mjs --heldout        # every other Verified task, from git clones (no Docker)
 *   node bench/mapeval.mjs --confirm        # SWE-bench full test split minus all of Verified
 *   node bench/mapeval.mjs --lite           # SWE-bench Lite, scored like LocAgent's Table 4
 *
 * Two more rankers are scored on every run: bm25full, BM25 over each file's full text with
 * code-aware tokens (camelCase and snake_case split, term counts kept), the strong sparse
 * baseline published leaderboards use; and fusion, reciprocal-rank fusion of map and bm25full.
 * accN = every file the fix edited is in the top N (Agentless/LocAgent's Acc@k); rN = recall.
 *
 * --heldout scores all Verified tasks except the 15 in bench/swe-tasks.json (the development
 * set the map was first checked on). Each repository is cloned once into CLONES (default: the
 * system temp dir) and checked out at each task's base commit; tasks run in repository and date
 * order, so each rebuild reuses the entries of files the checkout left unchanged.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// MAP_LIB=<path to a lib.mjs> scores another build (before/after a change) on the same tasks.
const { buildMap, candidates, renderCandidates, requestNames, decide, DEFAULTS, shouldSuggest: libShouldSuggest } = await import(process.env.MAP_LIB || "../dist/lib.mjs");
/** The hook's firing rule; builds before it moved into the library used this copy. */
const shouldSuggest = libShouldSuggest ?? ((cs, prompt) => cs.some((c) => c.defines.some((name) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[$]/g, "\\$")}($|[^A-Za-z0-9_])`).test(prompt) && (/[A-Z_0-9]/.test(name.slice(1)) || name.length >= 8 || (/^[A-Z]/.test(name) && name.length >= 6)))));
const SUGGESTED = 4; // what the hook shows the agent

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SWE_PY = process.env.SWE_PY || join(homedir(), "opt/anaconda3/envs/swebench/bin/python");
const KS = [1, 3, 5, 10, 15];
const keep = process.argv.includes("--keep");
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...o });

const CONFIRM = process.argv.includes("--confirm");
const LITE = process.argv.includes("--lite");
const HELDOUT = process.argv.includes("--heldout") || CONFIRM || LITE;
const devTasks = JSON.parse(readFileSync(join(REPO, "bench/swe-tasks.json"), "utf8")).tasks;
const dumpOf = (dataset) => JSON.parse(sh(SWE_PY, ["-c", `
import json, re, sys
from swebench.harness.utils import load_swebench_dataset
ds = load_swebench_dataset(${JSON.stringify(dataset)}, "test")
print(json.dumps([{"instance_id": d["instance_id"], "repo": d["repo"], "base_commit": d["base_commit"], "created_at": d["created_at"], "image": d.get("image"), "problem_statement": d["problem_statement"], "gold": sorted(set(re.findall(r"^diff --git a/(\\S+) b/", d["patch"], re.M)))} for d in ds]))
`]).stdout);
const verified = dumpOf("SWE-bench/SWE-bench_Verified");
// --confirm: tasks neither map version was scored on. Every Verified task is excluded.
const dump = LITE ? dumpOf("SWE-bench/SWE-bench_Lite") : CONFIRM ? (() => { const v = new Set(verified.map((d) => d.instance_id)); return dumpOf("SWE-bench/SWE-bench").filter((d) => !v.has(d.instance_id)); })() : verified;
const gold = Object.fromEntries(dump.map((d) => [d.instance_id, d.gold]));
const dev = new Set(devTasks.map((t) => t.instance_id));
const tasks = HELDOUT
  ? dump.filter((d) => CONFIRM || LITE || !dev.has(d.instance_id)).sort((a, b) => a.repo.localeCompare(b.repo) || a.created_at.localeCompare(b.created_at))
  : devTasks;
const CLONES = process.env.CLONES || join(tmpdir(), "snout-mapeval-clones");

function bm25Rank(map, query, k) {
  const paths = Object.keys(map.files);
  const N = paths.length;
  const terms = [...new Set([...query.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,63}/g)].map((m) => m[0].toLowerCase()))];
  const sets = paths.map((p) => new Set(map.files[p].words.map((w) => w.toLowerCase())));
  const avg = sets.reduce((s, x) => s + x.size, 0) / N;
  const df = new Map(terms.map((t) => [t, sets.filter((s) => s.has(t)).length]));
  const k1 = 1.2, b = 0.75;
  return paths
    .map((p, i) => {
      let score = 0, hits = 0;
      for (const t of terms) {
        if (!sets[i].has(t)) continue;
        hits++;
        const n = df.get(t);
        score += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((k1 + 1) / (1 + k1 * (1 - b + (b * sets[i].size) / avg)));
      }
      return { path: p, score, hits };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.path);
}

/** Code-aware tokens: whole identifiers plus their camelCase and snake_case parts, lowercased. */
function codeTokens(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{1,63}/g)) {
    const w = m[0];
    out.push(w.toLowerCase());
    const parts = w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\s]+/).filter((p) => p.length > 1);
    if (parts.length > 1) for (const p of parts) out.push(p.toLowerCase());
  }
  return out;
}

/** BM25 over full file text (path included), with term counts. */
function bm25FullRank(dir, map, query, k) {
  const paths = Object.keys(map.files);
  const docs = paths.map((p) => {
    let text = "";
    try { text = readFileSync(join(dir, p), "utf8"); } catch { /* unreadable */ }
    const tf = new Map();
    const toks = codeTokens(p.replace(/[\/.]/g, " ") + " " + text);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, len: toks.length };
  });
  const N = docs.length, avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, N);
  const terms = [...new Set(codeTokens(query))];
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]));
  const k1 = 1.2, b = 0.75;
  return paths
    .map((p, i) => {
      let score = 0;
      for (const t of terms) {
        const f = docs[i].tf.get(t);
        if (!f) continue;
        const n = df.get(t);
        score += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].len) / avg)));
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.p);
}

/** Reciprocal-rank fusion of two rankings (k = 60, the usual constant). */
function fuse(a, b, k) {
  const score = new Map();
  for (const list of [a, b]) list.forEach((p, i) => score.set(p, (score.get(p) ?? 0) + 1 / (60 + i + 1)));
  return [...score.entries()].sort((x, y) => y[1] - x[1]).slice(0, k).map(([p]) => p);
}

function grepRank(map, query, k) {
  const names = requestNames(query);
  return Object.entries(map.files)
    .map(([p, f]) => ({ p, n: f.words.filter((w) => names.has(w)).length }))
    .filter((x) => x.n)
    .sort((a, b) => b.n - a.n || a.p.localeCompare(b.p))
    .slice(0, k)
    .map((x) => x.p);
}

const recall = (ranked, g, k) => g.filter((f) => ranked.slice(0, k).includes(f)).length / g.length;
const firstRank = (ranked, g) => { const i = ranked.findIndex((p) => g.includes(p)); return i < 0 ? null : i + 1; };

/** A working tree at the task's base commit: a reused git clone (--heldout) or the task image's /testbed. */
function checkout(t) {
  if (!HELDOUT) {
    const dir = mkdtempSync(join(tmpdir(), "snout-mapeval-"));
    const cid = sh("docker", ["create", t.image]).stdout.trim();
    sh("docker", ["cp", `${cid}:/testbed/.`, dir]);
    sh("docker", ["rm", cid]);
    return dir;
  }
  const dir = join(CLONES, t.repo.replace("/", "__"));
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(CLONES, { recursive: true });
    console.error(`cloning ${t.repo}...`);
    const c = sh("git", ["clone", "-q", `https://github.com/${t.repo}.git`, dir], { timeout: 3600_000 });
    if (c.status !== 0) throw new Error(`clone ${t.repo}: ${c.stderr}`);
  }
  const co = sh("git", ["checkout", "-q", "-f", t.base_commit], { cwd: dir });
  if (co.status !== 0) throw new Error(`checkout ${t.instance_id}: ${co.stderr}`);
  sh("git", ["clean", "-qfdx"], { cwd: dir });
  return dir;
}

const rows = [];
const prevMaps = new Map();
for (const t of tasks) {
  let dir;
  try { dir = checkout(t); } catch (e) { console.error(String(e.message).slice(0, 200)); continue; }
  const lowValue = (rel) => { try { return decide({ absPath: join(dir, rel), projectDir: dir, cfg: DEFAULTS }).value === 0; } catch { return false; } };
  const t0 = Date.now();
  const { map, read, reused } = buildMap(dir, prevMaps.get(t.repo) ?? null, lowValue);
  if (HELDOUT) prevMaps.set(t.repo, map);
  const buildMs = Date.now() - t0;
  const t1 = Date.now();
  const mapC = candidates(map, t.problem_statement, 50).map((c) => c.path);
  const queryMs = Date.now() - t1;
  const line = renderCandidates(candidates(map, t.problem_statement, 15));
  const g = gold[t.instance_id].filter((f) => map.files[f]); // gold files the map could index
  const full = bm25FullRank(dir, map, t.problem_statement, 50);
  const ranks = { map: mapC.slice(0, 15), bm25: bm25Rank(map, t.problem_statement, 15), grep: grepRank(map, t.problem_statement, 15), bm25full: full.slice(0, 15), fusion: fuse(mapC, full, 15) };
  // What the agent would actually see: the hook's top 4, only when its firing rule passes.
  const shown = candidates(map, t.problem_statement, SUGGESTED);
  const fired = shouldSuggest(shown, t.problem_statement);
  const shownHit = fired && shown.some((c) => gold[t.instance_id].includes(c.path));
  const row = { task: t.instance_id, repo: t.repo, fired, shownHit, files: read + reused, reread: read, gold: gold[t.instance_id], indexedGold: g.length, buildMs, queryMs, lineTokens: Math.round(line.length / 3.5) };
  for (const [name, r] of Object.entries(ranks)) {
    row[name] = { first: g.length ? firstRank(r, g) : null, ...Object.fromEntries(KS.map((k) => [`r${k}`, g.length ? recall(r, g, k) : null])), ...Object.fromEntries(KS.map((k) => [`acc${k}`, g.length ? Number(recall(r, g, k) === 1) : null])) };
  }
  rows.push(row);
  console.error(`${t.instance_id.padEnd(30)} ${String(read + reused).padStart(5)} files (${read} read)  build ${String(buildMs).padStart(5)} ms  gold ${g.length}/${row.gold.length}  first hit: map ${row.map.first ?? "-"} · bm25 ${row.bm25.first ?? "-"} · grep ${row.grep.first ?? "-"}`);
  if (!keep && !HELDOUT) rmSync(dir, { recursive: true, force: true });
}

const usable = rows.filter((r) => r.indexedGold);
console.log(`\nRepo map vs baselines on ${usable.length} ${LITE ? "SWE-bench Lite" : CONFIRM ? "SWE-bench (full test split, no Verified)" : "SWE-bench Verified"} tasks (gold = files the real fix edited)\n`);
console.log("  ranker   recall@5  recall@10  recall@15   tasks with a hit in top 15   mean rank of first hit");
for (const name of ["map", "bm25", "grep", "bm25full", "fusion"]) {
  const avg = (k) => (usable.reduce((s, r) => s + r[name][`r${k}`], 0) / usable.length * 100).toFixed(0) + "%";
  const hits = usable.filter((r) => r[name].first);
  const meanRank = hits.length ? (hits.reduce((s, r) => s + r[name].first, 0) / hits.length).toFixed(1) : "-";
  console.log(`  ${name.padEnd(8)} ${avg(5).padStart(8)} ${avg(10).padStart(10)} ${avg(15).padStart(10)}   ${`${hits.length}/${usable.length}`.padStart(26)}   ${meanRank.padStart(22)}`);
}
// Paired comparison, map vs each baseline: bootstrap over tasks for recall@5 and @10, and an
// exact sign test on tasks where exactly one ranker has a fix file in its top 10.
const { signTest } = await import("./stats.mjs");
function rng(seed) { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); }
for (const base of ["bm25", "grep"]) {
  for (const k of [5, 10]) {
    const d = usable.map((r) => r.map[`r${k}`] - r[base][`r${k}`]);
    const rand = rng(7), boots = [];
    for (let i = 0; i < 4000; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(rand() * d.length)]; boots.push(s / d.length); }
    boots.sort((a, b) => a - b);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const f = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}`;
    console.log(`  map − ${base} recall@${k}: ${f(mean)} pts (95% CI ${f(boots[100])} to ${f(boots[3899])})`);
  }
  const hit = (r, n) => (r[n].first ?? 99) <= 10;
  const w = usable.filter((r) => hit(r, "map") && !hit(r, base)).length, l = usable.filter((r) => !hit(r, "map") && hit(r, base)).length;
  console.log(`  map vs ${base}, fix file in top 10: map only ${w} tasks, ${base} only ${l}; sign test p = ${signTest(w, l).toExponential(1)}`);
}
if (HELDOUT) {
  console.log("\n  by repository        tasks   map r@10   bm25 r@10");
  for (const repo of [...new Set(usable.map((r) => r.repo))]) {
    const rs = usable.filter((r) => r.repo === repo);
    const a = (n) => `${Math.round((rs.reduce((s, r) => s + r[n].r10, 0) / rs.length) * 100)}%`;
    console.log(`  ${repo.padEnd(22)} ${String(rs.length).padStart(5)} ${a("map").padStart(10)} ${a("bm25").padStart(11)}`);
  }
}
console.log("\n  Acc@k (every edited file in the top k; Agentless/LocAgent metric)\n  ranker      Acc@1   Acc@3   Acc@5   Acc@10");
for (const name of ["map", "bm25full", "fusion", "bm25", "grep"]) {
  const a = (k) => `${((usable.reduce((s, r) => s + r[name][`acc${k}`], 0) / usable.length) * 100).toFixed(1)}%`;
  console.log(`  ${name.padEnd(10)} ${a(1).padStart(6)} ${a(3).padStart(7)} ${a(5).padStart(7)} ${a(10).padStart(8)}`);
}
for (const base of ["bm25full"]) {
  const d = usable.map((r) => r.fusion.acc5 - r[base].acc5);
  const w = usable.filter((r) => r.fusion.acc5 && !r[base].acc5).length, l = usable.filter((r) => !r.fusion.acc5 && r[base].acc5).length;
  console.log(`  fusion vs ${base} Acc@5: ${(d.reduce((x, y) => x + y, 0) / d.length * 100).toFixed(1)} pts; fusion only ${w}, ${base} only ${l}; sign test p = ${signTest(w, l).toExponential(1)}`);
  const w2 = usable.filter((r) => r.map.acc5 && !r[base].acc5).length, l2 = usable.filter((r) => !r.map.acc5 && r[base].acc5).length;
  console.log(`  map vs ${base} Acc@5: map only ${w2}, ${base} only ${l2}; sign test p = ${signTest(w2, l2).toExponential(1)}`);
}
const fired = usable.filter((r) => r.fired), junk = fired.filter((r) => !r.shownHit);
console.log(`\n  hook (top ${SUGGESTED}, firing rule): fires on ${fired.length}/${usable.length} tasks (${(100 * fired.length / usable.length).toFixed(0)}%) · a fix file among those shown ${fired.length - junk.length}/${fired.length} (${fired.length ? (100 * (fired.length - junk.length) / fired.length).toFixed(0) : 0}%) · fires with no fix file ${junk.length} (${(100 * junk.length / usable.length).toFixed(0)}% of tasks)`);
const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\n  map build: median ${med(rows.map((r) => r.buildMs))} ms over a median ${med(rows.map((r) => r.files))} files, rereading a median ${med(rows.map((r) => r.reread))} · query ${med(rows.map((r) => r.queryMs))} ms · candidate line ~${med(rows.map((r) => r.lineTokens))} tokens`);
mkdirSync(join(REPO, "bench/ab-results"), { recursive: true });
const out = join(REPO, "bench/ab-results", `mapeval-${LITE ? "lite-" : CONFIRM ? "confirm-" : HELDOUT ? "heldout-" : ""}${Date.now()}.json`);
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2));
console.log(`  rows: ${out}`);
