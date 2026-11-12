#!/usr/bin/env node
/**
 * Where history search loses the right answer, stage by stage, on the import as-of sets (development
 * use only; their frozen verdicts stay in bench/import-asof/<set>/results-*.json):
 *
 *   imported   a commit that touched a gold file before the cut is among the imported records
 *   candidate  search considered it (rankSearch's `all`, after the as-of cut)
 *   rank       where the best such candidate stands among all history candidates by raw score
 *   admitted   admission let it through (rankSearch's `hits`)
 *   top5       it is among the first five shown
 *
 * and, for the unrelated controls, what admitted each record shown. No model, no network.
 *
 *   node bench/history-diagnose.mjs [--sets vite,django] [--out FILE]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SETS = opt("--sets", "vite,django").split(",");
const WORK = join(tmpdir(), "snout-hist");
const home = (p) => p.replace(/^~(?=\/|$)/, homedir());
const git = (cwd, a) => spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true }).stdout;

/** One shared import per set, reused across runs: the records do not depend on the search code. */
function imported(set, repo) {
  const dir = join(WORK, set);
  const env = { ...process.env, SNOUT_DIR: join(dir, "snout"), SNOUT_CONFIG_DIR: join(dir, "config"), SNOUT_IMPORT: "off", CI: "", SNOUT_TOKEN: "" };
  if (!existsSync(join(dir, "config", "history"))) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync(process.execPath, [join(ROOT, "dist", "snout.mjs"), "import", "--since", "9m", "--no-gh", "--no-sessions"], { cwd: repo, env, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  }
  return { dir, env };
}

const lib = await import(pathToFileURL(join(ROOT, "dist", "lib.mjs")).href);
const report = {};
for (const set of SETS) {
  const freeze = JSON.parse(readFileSync(join(ROOT, "bench", "import-asof", set, "freeze.json"), "utf8"));
  const repo = home(freeze.repo.path);
  const { dir } = imported(set, repo);
  const stores = lib.storesFor(repo, join(dir, "snout"), join(dir, "config"));
  const viewer = lib.sessionViewer(repo, stores.project);
  const ctxAt = (asOf) => ({ stores, snoutDir: join(dir, "snout"), projectDir: repo, viewer, user: null, agent: "bench", ...(asOf ? { asOf } : {}) });
  const records = lib.readHistory(stores.historyDir, stores.indexFile).filter((r) => r.kind === "commit");
  const byShort = new Map(records.map((r) => [r.sha.slice(0, 10), r]));
  // Files per commit from git itself, not the record's capped list.
  const files = new Map();
  for (const chunk of git(repo, ["log", "--all", "--no-merges", "--since=10 months ago", "--format=%x1e%H", "--name-only", "--no-renames"]).split("\x1e")) {
    const [sha, ...fs] = chunk.trim().split("\n"); if (sha) files.set(sha.trim(), fs.map((f) => f.trim()).filter(Boolean));
  }
  const touches = (sha, gold) => (files.get(sha) ?? []).some((f) => gold.includes(f));
  const rows = [];
  for (const t of freeze.tasks) {
    const gitAnswer = [...files.keys()].filter((sha) => touches(sha, t.gold)).length > 0; // any time; refined below by the records' own dates
    const goldRecords = records.filter((r) => r.at <= t.cut && r.sha !== t.sha && touches(r.sha, t.gold));
    const { hits, judged } = lib.rankSearch(ctxAt(t.cut), t.query);
    const hist = judged.filter((j) => j.id.startsWith("commit:"));
    const isGold = (id) => { const r = byShort.get(id.slice(7)); return !!r && touches(r.sha, t.gold); };
    const raw = (j) => j.e.words + (j.e.path || j.e.ident ? 0.5 : 0);
    const order = [...hist].sort((a, b) => raw(b) - raw(a) || b.at.localeCompare(a.at));
    const rank = order.findIndex((j) => isGold(j.id));
    const shown = hits.filter((h) => h.id.startsWith("commit:"));
    const pos = shown.findIndex((h) => isGold(h.id));
    const goldJudged = hist.filter((j) => isGold(j.id));
    const best = goldJudged.sort((a, b) => raw(b) - raw(a))[0];
    rows.push({
      sha: t.sha.slice(0, 10), query: t.query, answerable: goldRecords.length > 0, gitTouchedEver: gitAnswer,
      imported: goldRecords.length, candidates: hist.length, goldCandidates: goldJudged.length, rawRank: rank, admittedGold: goldJudged.filter((j) => j.admitted).length,
      shownPos: pos, top5: pos >= 0 && pos < 5, bestGoldEvidence: best ? { words: best.e.words, path: best.e.path, ident: best.e.ident, named: best.e.named, admitted: best.admitted } : null,
    });
  }
  const controls = freeze.controls.map((c) => {
    const { hits, judged } = lib.rankSearch(ctxAt(undefined), c.query);
    const shown = hits.filter((h) => /^(commit|pr|run):/.test(h.id)).slice(0, 5);
    const why = shown.map((h) => { const j = judged.find((x) => x.id === h.id); return { id: h.id, words: j.e.words, path: j.e.path, ident: j.e.ident, named: j.e.named, line: h.line.slice(0, 110) }; });
    return { query: c.query, shown: shown.length, why };
  });
  const n = rows.length, count = (f) => rows.filter(f).length;
  const summary = {
    tasks: n, answerable: count((r) => r.answerable), candidate: count((r) => r.goldCandidates > 0), admitted: count((r) => r.admittedGold > 0), top5: count((r) => r.top5),
    rawRankTop5: count((r) => r.rawRank >= 0 && r.rawRank < 5), rawRankTop20: count((r) => r.rawRank >= 0 && r.rawRank < 20),
    medianCandidates: rows.map((r) => r.candidates).sort((a, b) => a - b)[Math.floor(n / 2)], historyRecords: records.length,
    controlsSilent: controls.filter((c) => !c.shown).length,
  };
  report[set] = { summary, rows, controls };
  console.log(`\n== ${set}: ${records.length} commit records`);
  console.log(`  answerable ${summary.answerable}/${n} -> gold among candidates ${summary.candidate} -> gold admitted ${summary.admitted} -> gold in top 5 shown ${summary.top5}`);
  console.log(`  raw-score rank of best gold candidate: top 5 ${summary.rawRankTop5}, top 20 ${summary.rawRankTop20}; median history candidates per search ${summary.medianCandidates}`);
  console.log(`  controls silent ${summary.controlsSilent}/${controls.length}`);
}
const out = opt("--out", join(WORK, "diagnose.json"));
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\n${out}`);

