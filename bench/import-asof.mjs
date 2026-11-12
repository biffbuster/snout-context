#!/usr/bin/env node
/**
 * Import as-of check (free, offline, no model). When a task starts, does searching the imported
 * history, as it stood just before the task, return a past commit that touched the files the task
 * ends up changing, more often than simple baselines? A retrieval check, not a cost result.
 * Each set is frozen, with its pass bar, in bench/import-asof/<set>/freeze.json before any run.
 *
 *   node bench/import-asof.mjs --freeze --set NAME --repo <clone> [--ref origin/main]
 *   node bench/import-asof.mjs --run --set NAME [--label NAME]    results in <set>/results-<label>.json
 *
 * Snout runs with its own record and config folders in a temp directory, so nothing touches the
 * clone or the user's real memory. Sets:
 *   vite    (2026-11-09) rules v1: files all under packages/, gold = every changed file
 *   django  (2026-11-09) rules v2: any repository, gold = the changed source files (not tests or docs)
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stamp } from "./stamp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SNOUT = join(ROOT, "dist", "snout.mjs");
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const SET = opt("--set", "vite");
const OUT = join(ROOT, "bench", "import-asof", SET);
const FREEZE = join(OUT, "freeze.json");

const SEED = "snout-import-asof-2026-11-09";
const TASKS = 40, CONTROLS = 10, TOP = 5;
const STOP = new Set("the and for with from that this into when not are was were has have does its use add fix make set get new can all any but via why how what more less only also".split(" "));
const home = (p) => p.replace(/^~(?=\/|$)/, homedir());

const git = (cwd, a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
/** The request a task stands for: its subject without issue or PR references, which only the task's own commit carries. */
const queryV1 = (subject) => subject.replace(/\s*\(#\d+\)\s*$/, "").trim();
const queryV2 = (subject) => subject.replace(/^(?:fixed|refs|closes|fixes)\b[^-]*?--\s*/i, "").replace(/\s*\(#\d+\)|#\d+/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
const rank = (s) => createHash("sha256").update(`${SEED}:${s}`).digest("hex");
const filesOf = (repo, sha) => git(repo, ["show", "--no-renames", "--name-only", "--format=", sha]).split("\n").map((l) => l.trim()).filter(Boolean);
const isDoc = (f) => /(^|\/)docs?\//.test(f) || /\.(md|rst|txt)$/i.test(f);
const isTest = (f) => /(^|\/)(tests?|__tests__)\//.test(f) || /(^|\/)test_[^/]*$|_tests?\.[a-z]+$|\.(spec|test)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)playground\//.test(f);
const RELEASE = /\b(deps?|dependenc(y|ies)|bump|release|publish|changelog)\b|^v?\d+\.\d+/i;

function commits(repo, ref, since, until) {
  const out = git(repo, ["log", ref, "--no-merges", `--since=${since}`, `--until=${until}`, "--format=%x1e%H%x1f%cI%x1f%s", "--name-only"]);
  return out.split("\x1e").map((c) => {
    const [sha, at, rest] = c.split("\x1f");
    if (!sha?.trim() || !rest) return null;
    const [subject, ...files] = rest.split("\n");
    return { sha: sha.trim(), at, subject: subject.trim(), files: files.map((f) => f.trim()).filter(Boolean) };
  }).filter(Boolean);
}

/** v1 (vite): 1 to 5 files, all under packages/, not dependency, release, docs-only or test-only work. */
function eligibleV1(c) {
  if (c.files.length < 1 || c.files.length > 5 || !c.files.every((f) => f.startsWith("packages/"))) return false;
  if (RELEASE.test(c.subject)) return false;
  if (c.files.every((f) => /(^|\/)(package\.json|pnpm-lock\.yaml|CHANGELOG\.md)$/.test(f))) return false;
  if (c.files.every((f) => f.endsWith(".md"))) return false;
  if (c.files.every((f) => /__tests__|\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)playground\//.test(f))) return false;
  return true;
}
/** v2 (any repository): 1 to 5 files, at least one source file (not docs, tests, CI or package metadata), not dependency or release work. */
const source = (f) => !isDoc(f) && !isTest(f) && !/^\.github\//.test(f) && !/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|CHANGELOG\.md|AUTHORS)$/.test(f);
const eligibleV2 = (c) => c.files.length >= 1 && c.files.length <= 5 && c.files.some(source) && !RELEASE.test(c.subject);

function freeze() {
  const repoArg = opt("--repo", "~/.snout-bench/clones/vite");
  const repo = home(repoArg);
  const ref = opt("--ref", "HEAD");
  const v2 = SET !== "vite";
  const head = git(repo, ["log", "-1", ref, "--format=%H%x1f%cI"]).trim().split("\x1f");
  const end = new Date(head[1]);
  const start = new Date(end.getTime() - 92 * 86_400_000);
  const pool = commits(repo, ref, start.toISOString(), end.toISOString()).filter(v2 ? eligibleV2 : eligibleV1);
  const tasks = pool.sort((a, b) => rank(a.sha).localeCompare(rank(b.sha))).slice(0, TASKS)
    .map((c) => ({ sha: c.sha, subject: c.subject, query: (v2 ? queryV2 : queryV1)(c.subject), gold: v2 ? c.files.filter(source) : c.files, cut: new Date(Date.parse(c.at) - 1000).toISOString() }));
  // Controls: requests from another project (this one), none used by an earlier set. Nothing in the clone's history answers them.
  const used = new Set();
  for (const s of ["vite", "django"]) { const p = join(ROOT, "bench", "import-asof", s, "freeze.json"); if (s !== SET && existsSync(p)) for (const c of JSON.parse(readFileSync(p, "utf8")).controls) used.add(c.from); }
  const other = git(ROOT, ["log", "--no-merges", "--format=%H%x1f%s", "-200", "origin/main"]).trim().split("\n").map((l) => l.split("\x1f"));
  const controls = other.sort((a, b) => rank(a[0]).localeCompare(rank(b[0]))).filter(([sha]) => !used.has(`snout-context ${sha.slice(0, 10)}`)).slice(0, CONTROLS)
    .map(([sha, s]) => ({ from: `snout-context ${sha.slice(0, 10)}`, query: (v2 ? queryV2 : queryV1)(s) }));
  const frozen = {
    set: SET, rules: v2 ? "v2" : "v1", frozenAt: new Date().toISOString(), seed: SEED, repo: { path: repoArg, ref, head: head[0], headAt: head[1] },
    window: { tasks: [start.toISOString(), end.toISOString()], import: "--since 9m --no-gh --no-sessions" },
    selection: v2 ? "non-merge commits on the ref in the task window changing 1-5 files with at least one source file (not docs, tests, CI or package metadata); not dependency or release work; ranked by sha256(seed:sha); first 40"
      : "non-merge commits in the task window changing 1-5 files, all under packages/; not dependency, release, docs-only or test-only; ranked by sha256(seed:sha); first 40",
    query: v2 ? "commit subject without issue or PR references (#N anywhere, a leading 'Fixed/Refs #N --')" : "commit subject without its trailing PR number",
    cut: "commit time minus 1 s", hit: `a top-${TOP} history record is a commit that touched at least one gold file`, gold: v2 ? "the task's changed source files" : "every file the task changed",
    baselines: { recent: `the ${TOP} most recent non-merge commits on the ref before the cut`, words: `the ${TOP} most recent non-merge commits on the ref before the cut, in the import window, whose subject shares a word (3+ letters, not a stopword) with the query` },
    pass: { hitRate: 0.5, marginOverBestBaseline: 0.15, silentControls: 8 },
    policy: "No tuning against these tasks. A fix needs a new frozen set. Misses are reported as ranked 6-20 or not in the first 20 shown; the candidate stage is measured by bench/history-diagnose.mjs.",
    tasks, controls,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FREEZE, `${JSON.stringify(frozen, null, 1)}\n`);
  console.log(`Froze ${SET}: ${tasks.length} tasks (pool ${pool.length}) and ${controls.length} controls: ${FREEZE}`);
}

function run() {
  const f = JSON.parse(readFileSync(FREEZE, "utf8"));
  const repo = home(f.repo.path);
  const ref = f.repo.ref ?? "HEAD";
  if (git(repo, ["rev-parse", ref]).trim() !== f.repo.head) throw new Error(`${ref} in the clone moved since the freeze`);
  const work = mkdtempSync(join(tmpdir(), "snout-asof-"));
  const env = { ...process.env, SNOUT_DIR: join(work, "snout"), SNOUT_CONFIG_DIR: join(work, "config"), SNOUT_IMPORT: "off", CI: "", SNOUT_TOKEN: "" };
  const snout = (a) => spawnSync(process.execPath, [SNOUT, ...a], { cwd: repo, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const imp = snout(["import", ...f.window.import.split(" ")]);
  if (imp.status !== 0) throw new Error(`import failed: ${imp.stdout}${imp.stderr}`);
  const filesCache = new Map();
  const touched = (sha) => { if (!filesCache.has(sha)) filesCache.set(sha, filesOf(repo, sha)); return filesCache.get(sha); };
  const hits = (shas, gold) => shas.some((s) => touched(s).some((x) => gold.includes(x)));
  const shasIn = (out) => [...out.matchAll(/^- commit:([0-9a-f]{7,40})/gm)].map((m) => git(repo, ["rev-parse", m[1]]).trim());
  const rows = [];
  for (const t of f.tasks) {
    const full = shasIn(snout(["memory", "search", t.query, "--as-of", t.cut, "--limit", String(TOP)]).stdout).slice(0, TOP);
    const recent = git(repo, ["log", ref, "--no-merges", `-${TOP}`, `--before=${t.cut}`, "--format=%H"]).trim().split("\n").filter(Boolean);
    const q = words(t.query);
    const wordy = git(repo, ["log", ref, "--no-merges", `--before=${t.cut}`, "--since=9 months ago", "--format=%H%x1f%s", "-5000"]).trim().split("\n")
      .map((l) => l.split("\x1f")).filter(([, s]) => [...words(s ?? "")].some((w) => q.has(w))).slice(0, TOP).map(([h]) => h);
    const hit = hits(full, t.gold);
    // For a miss: is a gold-touching commit before the cut among a deeper search's candidates at all?
    const reason = hit ? null : hits(shasIn(snout(["memory", "search", t.query, "--as-of", t.cut, "--limit", "20"]).stdout), t.gold) ? "ranked 6th to 20th" : "not among the first 20 shown (candidate stage unknown; see bench/history-diagnose.mjs)";
    rows.push({ sha: t.sha.slice(0, 10), query: t.query, found: full.map((s) => s.slice(0, 10)), hit, recent: hits(recent, t.gold), words: hits(wordy, t.gold), ...(reason ? { reason } : {}) });
  }
  const controls = f.controls.map((c) => ({ query: c.query, silent: !/^- commit:/m.test(snout(["memory", "search", c.query, "--limit", String(TOP)]).stdout) }));
  const rate = (k) => rows.filter((r) => r[k]).length / rows.length;
  const score = { snout: rate("hit"), recent: rate("recent"), words: rate("words"), silentControls: controls.filter((c) => c.silent).length };
  const best = Math.max(score.recent, score.words);
  const pass = score.snout >= f.pass.hitRate && score.snout - best >= f.pass.marginOverBestBaseline && score.silentControls >= f.pass.silentControls;
  const result = { set: SET, label: opt("--label", "run"), measuredAt: new Date().toISOString(), ...stamp(), import: imp.stdout.split("\n")[0], score, pass, rows, controls };
  writeFileSync(join(OUT, `results-${result.label}.json`), `${JSON.stringify(result, null, 1)}\n`);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* left behind */ }
  console.log(result.import);
  console.log(`hit@${TOP}: Snout ${(score.snout * 100).toFixed(0)}% · recent ${(score.recent * 100).toFixed(0)}% · shared-word ${(score.words * 100).toFixed(0)}% · silent controls ${score.silentControls}/${controls.length}`);
  const misses = rows.filter((r) => !r.hit);
  console.log(`misses ${misses.length}: ranked 6-20: ${misses.filter((r) => r.reason === "ranked 6th to 20th").length}, not in the first 20: ${misses.filter((r) => r.reason !== "ranked 6th to 20th").length}`);
  console.log(`${pass ? "PASS" : "FAIL"}: bench/import-asof/${SET}/results-${result.label}.json`);
}

if (args.includes("--freeze")) {
  if (existsSync(FREEZE) && !args.includes("--force")) throw new Error(`${SET} is already frozen; a new set needs a new name`);
  freeze();
} else if (args.includes("--run")) run();
else console.log("usage: node bench/import-asof.mjs --freeze --set NAME --repo <clone> [--ref REF] | --run --set NAME [--label NAME]");
