#!/usr/bin/env node
/**
 * Development only: compares ways to find and rank imported history records, and dumps the evidence
 * an admission rule would see, on the import as-of development sets (vite, django). Nothing here is
 * a verdict; the frozen results stay in bench/import-asof/<set>/.
 *
 *   SNOUT_MODEL_DIR=<model> node bench/history-retrieval-proto.mjs [--sets vite,django]
 *
 * Rankers: words (shared word count, as today), bm25 (rarity-weighted words, statistics from the
 * records visible at the cut only), meaning (local bge-small cosine over every visible record),
 * files (records touching files the agent would know), and fusions. "Known files": the question's
 * terms searched with git grep in the tree as it was just before the task (its parent), top 3
 * source files. They never come from the task's own change.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SETS = opt("--sets", "vite,django").split(",");
const WORK = join(tmpdir(), "snout-hist");
const home = (p) => p.replace(/^~(?=\/|$)/, homedir());
const git = (cwd, a) => spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true }).stdout ?? "";
const lib = await import(pathToFileURL(join(ROOT, "dist", "lib.mjs")).href);
const embed = await lib.loadEmbedder();

const isDoc = (f) => /(^|\/)docs?\//.test(f) || /\.(md|rst|txt)$/i.test(f);
const isTest = (f) => /(^|\/)(tests?|__tests__)\//.test(f) || /(^|\/)test_[^/]*$|_tests?\.[a-z]+$|\.(spec|test)\.[cm]?[jt]sx?$/.test(f);
const source = (f) => !isDoc(f) && !isTest(f) && !/^\.github\//.test(f);
const stem = (w) => w.replace(/ies$/, "y").replace(/(?<=\w{3})(es|s)$/, "").replace(/(?<=\w{4})(ed|ing)$/, "");
const toks = (text) => lib.terms(text).map((t) => stem(t.toLowerCase()));
const pathToks = (files) => files.flatMap((f) => f.toLowerCase().split(/[/._-]+/)).filter((p) => p.length >= 3).map(stem);
const pack = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const unpack = (s) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const embText = (r) => `${r.title}\n${r.body.slice(0, 600)}\n${r.files.slice(0, 8).join(" ")}`;

function loadSet(set) {
  const freeze = JSON.parse(readFileSync(join(ROOT, "bench", "import-asof", set, "freeze.json"), "utf8"));
  const repo = home(freeze.repo.path);
  const dir = join(WORK, set);
  if (!existsSync(join(dir, "config", "history"))) throw new Error(`run bench/history-diagnose.mjs first (no import for ${set})`);
  const stores = lib.storesFor(repo, join(dir, "snout"), join(dir, "config"));
  const records = lib.readHistory(stores.historyDir, stores.indexFile).filter((r) => r.kind === "commit");
  const files = new Map();
  for (const chunk of git(repo, ["log", "--all", "--no-merges", "--since=10 months ago", "--format=%x1e%H", "--name-only", "--no-renames"]).split("\x1e")) {
    const [sha, ...fs] = chunk.trim().split("\n"); if (sha) files.set(sha.trim(), fs.map((f) => f.trim()).filter(Boolean));
  }
  for (const r of records) { r.tok = toks(`${r.title} ${r.body}`).concat(pathToks(r.files)); r.tf = new Map(); for (const t of r.tok) r.tf.set(t, (r.tf.get(t) ?? 0) + 1); r.allFiles = files.get(r.sha) ?? r.files; }
  return { set, freeze, repo, dir, records };
}

async function vectors(S) {
  const file = join(S.dir, "vectors.json");
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const missing = S.records.filter((r) => !cache[r.sha]);
  for (let i = 0; i < missing.length; i += 64) { const vs = await embed(missing.slice(i, i + 64).map(embText)); vs.forEach((v, j) => { cache[missing[i + j].sha] = pack(v); }); }
  if (missing.length) writeFileSync(file, JSON.stringify(cache));
  for (const r of S.records) r.vec = unpack(cache[r.sha]);
}

/** Files an agent would know before implementing: the question's terms, git grep in the tree just before the task. */
function knownFiles(S, t) {
  const file = join(S.dir, "known.json");
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (cache[t.sha]) return cache[t.sha];
  const parent = `${t.sha}^`;
  const all = git(S.repo, ["ls-tree", "-r", "--name-only", parent]).split("\n").filter((f) => f && source(f));
  const terms = [...new Set([...lib.identsIn(t.query), ...lib.terms(t.query).filter((w) => w.length >= 4)])].slice(0, 10);
  const score = new Map();
  for (const term of terms) {
    const out = git(S.repo, ["grep", "-l", "-i", "-F", ...(/^\w+$/.test(term) ? ["-w"] : []), term, parent]).split("\n").map((l) => l.slice(parent.length + 1)).filter((f) => f && source(f));
    if (!out.length || out.length > 200) continue;
    const w = Math.log(1 + all.length / out.length);
    for (const f of out) score.set(f, (score.get(f) ?? 0) + w);
  }
  const known = [...score].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
  cache[t.sha] = known; writeFileSync(file, JSON.stringify(cache));
  return known;
}

function rankAll(S, q, cut, exclude, known) {
  const visible = S.records.filter((r) => (!cut || r.at <= cut) && r.sha !== exclude);
  const N = visible.length; const avg = visible.reduce((s, r) => s + r.tok.length, 0) / N;
  const qt = [...new Set(toks(q.query))];
  const df = new Map(qt.map((t) => [t, visible.filter((r) => r.tf.has(t)).length]));
  const idf = (t) => Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
  const idfSum = qt.reduce((s, t) => s + idf(t), 0) || 1;
  const qv = q.vec;
  const rows = visible.map((r) => {
    let bm = 0, cover = 0, words = 0;
    for (const t of qt) { const f = r.tf.get(t) ?? 0; if (!f) continue; words++; cover += idf(t); bm += idf(t) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * r.tok.length / avg)); }
    const fileHit = known.length ? known.filter((k) => r.allFiles.includes(k)).length : 0;
    return { r, words, bm, cover: cover / idfSum, cos: dot(qv, r.vec), fileHit };
  });
  const mean = rows.reduce((s, x) => s + x.cos, 0) / N; const sd = Math.sqrt(rows.reduce((s, x) => s + (x.cos - mean) ** 2, 0) / N) || 1;
  for (const x of rows) x.z = (x.cos - mean) / sd;
  const order = (key) => [...rows].sort((a, b) => b[key] - a[key] || b.r.at.localeCompare(a.r.at));
  const rr = (list) => new Map(list.map((x, i) => [x.r.sha, i]));
  const ranks = { words: order("words"), bm25: order("bm"), meaning: order("cos"), files: order("fileHit") };
  const rk = Object.fromEntries(Object.entries(ranks).map(([k, l]) => [k, rr(l)]));
  const fuse = (keys) => [...rows].map((x) => ({ x, s: keys.reduce((s, k) => s + (k === "files" && !x.fileHit ? 0 : 1 / (60 + rk[k].get(x.r.sha))), 0) })).sort((a, b) => b.s - a.s || b.x.r.at.localeCompare(a.x.r.at)).map((y) => y.x);
  ranks["bm25+meaning"] = fuse(["bm25", "meaning"]);
  if (known.length) { ranks["bm25+files"] = fuse(["bm25", "files"]); ranks["bm25+meaning+files"] = fuse(["bm25", "meaning", "files"]); }
  return { ranks, N };
}

const report = {};
const loaded = [];
for (const set of SETS) { const S = loadSet(set); await vectors(S); loaded.push(S); }
for (const S of loaded) {
  const tasks = S.freeze.tasks;
  const qv = await embed(tasks.map((t) => lib.QUERY_PREFIX + t.query));
  tasks.forEach((t, i) => { t.vec = qv[i]; });
  const out = { tasks: [], negatives: [] };
  for (const t of tasks) {
    const known = knownFiles(S, t);
    const touchesGold = (x) => x.r.allFiles.some((f) => t.gold.includes(f));
    const answerable = S.records.some((r) => r.at <= t.cut && r.sha !== t.sha && r.allFiles.some((f) => t.gold.includes(f)));
    const res = { sha: t.sha.slice(0, 10), answerable, knownHasGold: known.some((k) => t.gold.includes(k)), known, byRanker: {} };
    for (const mode of ["text", "files"]) {
      const { ranks } = rankAll(S, t, t.cut, t.sha, mode === "files" ? known : []);
      for (const [name, list] of Object.entries(ranks)) {
        if (mode === "text" && name.includes("files")) continue;
        if (mode === "files" && !name.includes("files")) continue;
        const pos = list.findIndex(touchesGold);
        res.byRanker[name] = { pos, top: list.slice(0, 5).map((x) => ({ gold: touchesGold(x), cos: +x.cos.toFixed(3), z: +x.z.toFixed(2), cover: +x.cover.toFixed(2), words: x.words, fileHit: x.fileHit, bm: +x.bm.toFixed(2) })) };
      }
    }
    out.tasks.push(res);
  }
  // Negatives: the unrelated controls, and the other development set's questions, asked of this history now.
  const other = loaded.find((o) => o !== S);
  const negQ = [...S.freeze.controls.map((c) => ({ query: c.query, kind: "control" })), ...(other ? other.freeze.tasks.map((t) => ({ query: t.query, kind: `cross:${other.set}` })) : [])];
  const nv = await embed(negQ.map((n) => lib.QUERY_PREFIX + n.query));
  negQ.forEach((n, i) => { n.vec = nv[i]; });
  for (const n of negQ) {
    const { ranks } = rankAll(S, n, null, null, []);
    out.negatives.push({ kind: n.kind, query: n.query.slice(0, 80), byRanker: Object.fromEntries(Object.entries(ranks).map(([k, l]) => [k, l.slice(0, 5).map((x) => ({ cos: +x.cos.toFixed(3), z: +x.z.toFixed(2), cover: +x.cover.toFixed(2), words: x.words, bm: +x.bm.toFixed(2) }))])) });
  }
  report[S.set] = out;
  const ans = out.tasks.filter((x) => x.answerable);
  console.log(`\n== ${S.set}: ${S.records.length} records, ${ans.length} answerable tasks; known files include a gold file on ${ans.filter((x) => x.knownHasGold).length}/${ans.length}`);
  for (const name of Object.keys(ans[0].byRanker)) {
    const p = ans.map((x) => x.byRanker[name].pos);
    const at = (k) => p.filter((v) => v >= 0 && v < k).length;
    const mrr = p.reduce((s, v) => s + (v >= 0 ? 1 / (v + 1) : 0), 0) / p.length;
    console.log(`  ${name.padEnd(20)} hit@1 ${String(at(1)).padStart(2)}  hit@5 ${String(at(5)).padStart(2)}  hit@20 ${String(at(20)).padStart(2)}  MRR ${mrr.toFixed(2)}`);
  }
}
writeFileSync(join(WORK, "proto.json"), JSON.stringify(report, null, 1));
console.log(`\n${join(WORK, "proto.json")}`);
