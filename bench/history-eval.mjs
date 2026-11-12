#!/usr/bin/env node
/**
 * History search on new projects, frozen before any run (2026-11-09). Per project:
 *   tasks      40 commits, frozen as in bench/import-asof.mjs (rules v2): a task's question is its
 *              subject without issue references, its cut the commit time minus 1 s, its gold the
 *              source files it changed. "Known files" for the file-assisted mode: the question's
 *              terms searched with git grep in the tree just before the task (its parent), top 3
 *              source files; they never come from the task's own change. File overlap is a proxy.
 *   checked    15 questions, each for one commit drawn at random (seeded) and read; the answer is
 *              that commit or a backport with the same subject. Written and checked by the model,
 *              not by a person: bench/history-eval/<project>/review.md lists them for a person.
 *   negatives  15 questions in the project's own domain about things its history doesn't hold
 *              (each checked against git log), and 10 unrelated controls. Any history line shown is wrong.
 * Modes: words (the default, no model), meaning (memorySemantic with the local model), and, for the
 * tasks, meaning with known files. Search runs in process through the shipped functions
 * (prepareHistorySearch, memorySearch, rankSearch); a few searches also run through the CLI for
 * cold-start latency. The pass bar is in each freeze.json and is not changed after a run.
 *
 *   node bench/history-eval.mjs --freeze --project NAME --repo <clone> --ref <ref>   (questions from bench/history-eval/questions.json)
 *   SNOUT_MODEL_DIR=<model> node bench/history-eval.mjs --run --project NAME [--label NAME]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const PROJECT = opt("--project");
const OUT = join(ROOT, "bench", "history-eval", PROJECT ?? "_");
const FREEZE = join(OUT, "freeze.json");
const SEED = "snout-history-eval-2026-11-09";
const home = (p) => p.replace(/^~(?=\/|$)/, homedir());
const git = (cwd, a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0 && !a.includes("grep")) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout ?? "";
};
const rank = (s) => createHash("sha256").update(`${SEED}:${s}`).digest("hex");
const isDoc = (f) => /(^|\/)docs?\//.test(f) || /\.(md|rst|txt)$/i.test(f);
const isTest = (f) => /(^|\/)(tests?|__tests__|benches)\//.test(f) || /(^|\/)test_[^/]*$|_tests?\.[a-z]+$|\.(spec|test)\.[cm]?[jt]sx?$/.test(f);
const source = (f) => !isDoc(f) && !isTest(f) && !/^\.github\//.test(f) && !/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|Cargo\.lock|CHANGELOG\.md|AUTHORS)$/.test(f);
const RELEASE = /\b(deps?|dependenc(y|ies)|bump|release|publish|changelog)\b|^v?\d+\.\d+/i;
const query = (subject) => subject.replace(/^(?:fixed|refs|closes|fixes)\b[^-]*?--\s*/i, "").replace(/\s*\(#\d+\)|#\d+/g, " ").replace(/\s+/g, " ").trim();

const CRITERIA = {
  negatives: { minSilentShare: { words: 0.9, meaning: 0.9 } },
  checked: { minCorrectShare: { words: 0.35, meaning: 0.5 }, maxWrongOnlyShare: { words: 0.2, meaning: 0.2 } },
  tasks: { minAnsweredRightShare: { words: 0.25, meaning: 0.4 }, minRankedTop5Share: { "meaning+files": 0.6 } },
  budget: { medianTokens: 250, maxTokens: 600 },
  performance: { warmP95Ms: 250, coldCliMeaningMs: 3000, rssMbMeaning: 450 },
};

/** Files an agent would know before implementing: the question's terms, git grep in the tree just before the task. */
function knownFiles(repo, sha, text, lib) {
  const parent = `${sha}^`;
  const all = git(repo, ["ls-tree", "-r", "--name-only", parent]).split("\n").filter((f) => f && source(f));
  const terms = [...new Set([...lib.identsIn(text), ...lib.terms(text).filter((w) => w.length >= 4)])].slice(0, 10);
  const score = new Map();
  for (const term of terms) {
    const out = git(repo, ["grep", "-l", "-i", "-F", ...(/^\w+$/.test(term) ? ["-w"] : []), term, parent]).split("\n").map((l) => l.slice(parent.length + 1)).filter((f) => f && source(f));
    if (!out.length || out.length > 200) continue;
    const w = Math.log(1 + all.length / out.length);
    for (const f of out) score.set(f, (score.get(f) ?? 0) + w);
  }
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
}

async function freeze() {
  if (existsSync(FREEZE)) throw new Error(`${PROJECT} is already frozen`);
  const lib = await import(pathToFileURL(join(ROOT, "dist", "lib.mjs")).href);
  const repoArg = opt("--repo"), ref = opt("--ref");
  const repo = home(repoArg);
  const head = git(repo, ["log", "-1", ref, "--format=%H%x1f%cI"]).trim().split("\x1f");
  const end = new Date(head[1]), start = new Date(end.getTime() - 92 * 86_400_000);
  const log = git(repo, ["log", ref, "--no-merges", `--since=${start.toISOString()}`, `--until=${end.toISOString()}`, "--format=%x1e%H%x1f%cI%x1f%s", "--name-only", "--no-renames"]);
  const pool = log.split("\x1e").map((c) => { const [sha, at, rest] = c.split("\x1f"); if (!sha?.trim() || !rest) return null; const [subject, ...files] = rest.split("\n"); return { sha: sha.trim(), at, subject: subject.trim(), files: files.map((f) => f.trim()).filter(Boolean) }; })
    .filter((c) => c && c.files.length >= 1 && c.files.length <= 5 && c.files.some(source) && !RELEASE.test(c.subject));
  const tasks = pool.sort((a, b) => rank(a.sha).localeCompare(rank(b.sha))).slice(0, 40).map((c) => {
    const q = query(c.subject);
    return { sha: c.sha, subject: c.subject, query: q, gold: c.files.filter(source), cut: new Date(Date.parse(c.at) - 1000).toISOString(), known: knownFiles(repo, c.sha, q, lib) };
  });
  const qs = JSON.parse(readFileSync(join(ROOT, "bench", "history-eval", "questions.json"), "utf8"))[PROJECT];
  const checked = qs.checked.map((c) => { const full = git(repo, ["rev-parse", c.sha]).trim(); return { ...c, sha: full, subject: git(repo, ["log", "-1", "--format=%s", full]).trim() }; });
  const used = new Set(["vite", "django"].flatMap((s) => { const p = join(ROOT, "bench", "import-asof", s, "freeze.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).controls.map((c) => c.from) : []; }));
  for (const p of ["astropy", "tokio"]) { const f = join(ROOT, "bench", "history-eval", p, "freeze.json"); if (p !== PROJECT && existsSync(f)) for (const c of JSON.parse(readFileSync(f, "utf8")).controls) used.add(c.from); }
  const other = git(ROOT, ["log", "--no-merges", "--format=%H%x1f%s", "-300", "origin/main"]).trim().split("\n").map((l) => l.split("\x1f"));
  const controls = other.sort((a, b) => rank(a[0]).localeCompare(rank(b[0]))).filter(([sha]) => !used.has(`snout-context ${sha.slice(0, 10)}`)).slice(0, 10).map(([sha, s]) => ({ from: `snout-context ${sha.slice(0, 10)}`, query: query(s) }));
  const frozen = { project: PROJECT, frozenAt: new Date().toISOString(), seed: SEED, repo: { path: repoArg, ref, head: head[0], headAt: head[1] }, import: "--since 9m --no-gh --no-sessions", criteria: CRITERIA, tasks, checked, negatives: qs.negatives, controls };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FREEZE, `${JSON.stringify(frozen, null, 1)}\n`);
  const review = [`# ${PROJECT}: questions for a person to check`, "", "Written and checked by the model on 2026-11-09, before any run. Each answerable question names the commit that answers it; each unanswerable one was checked against git log for the window.", "", "## Answerable", ...checked.map((c, i) => `${i + 1}. ${c.question}\n   Answer: ${c.sha.slice(0, 10)} "${c.subject}"`), "", "## Unanswerable in this history", ...qs.negatives.map((n, i) => `${i + 1}. ${n.question}${n.note ? ` (${n.note})` : ""}`), ""].join("\n");
  writeFileSync(join(OUT, "review.md"), review);
  console.log(`Froze ${PROJECT}: ${tasks.length} tasks (pool ${pool.length}), ${checked.length} checked, ${qs.negatives.length} negatives, ${controls.length} controls`);
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

async function run() {
  const f = JSON.parse(readFileSync(FREEZE, "utf8"));
  const repo = home(f.repo.path);
  if (git(repo, ["rev-parse", f.repo.ref]).trim() !== f.repo.head) throw new Error(`${f.repo.ref} moved since the freeze`);
  const work = mkdtempSync(join(tmpdir(), `snout-eval-${PROJECT}-`));
  const cfgDir = join(work, "config");
  const dirs = { words: join(work, "snout-words"), meaning: join(work, "snout-meaning") };
  for (const [m, d] of Object.entries(dirs)) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "config.json"), JSON.stringify(m === "meaning" ? { memorySemantic: true } : {})); }
  const SNOUT = join(ROOT, "dist", "snout.mjs");
  const cli = (mode, a) => { const t0 = Date.now(); const r = spawnSync(process.execPath, [SNOUT, ...a], { cwd: repo, env: { ...process.env, SNOUT_DIR: dirs[mode], SNOUT_CONFIG_DIR: cfgDir, SNOUT_IMPORT: "off", CI: "", SNOUT_TOKEN: "" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }); return { out: r.stdout + r.stderr, ms: Date.now() - t0, status: r.status }; };
  // The import, with meaning on so it embeds every record (as a user's import would).
  const imp = cli("meaning", ["import", ...f.import.split(" ")]);
  if (imp.status !== 0) throw new Error(`import failed: ${imp.out}`);
  process.env.SNOUT_CONFIG_DIR = cfgDir;
  const lib = await import(pathToFileURL(join(ROOT, "dist", "lib.mjs")).href);
  const stores = lib.storesFor(repo, dirs.meaning, cfgDir);
  const viewer = lib.sessionViewer(repo, stores.project);
  const ctxAt = (mode, asOf) => ({ stores: lib.storesFor(repo, dirs[mode], cfgDir), snoutDir: dirs[mode], projectDir: repo, viewer, user: null, agent: "bench", ...(asOf ? { asOf } : {}) });
  const records = lib.readHistory(stores.historyDir, stores.indexFile).filter((r) => r.kind === "commit");
  const bySha10 = new Map(records.map((r) => [r.sha.slice(0, 10), r]));
  const files = new Map();
  for (const chunk of git(repo, ["log", "--all", "--no-merges", "--since=10 months ago", "--format=%x1e%H", "--name-only", "--no-renames"]).split("\x1e")) { const [sha, ...fs] = chunk.trim().split("\n"); if (sha) files.set(sha.trim(), fs.map((x) => x.trim()).filter(Boolean)); }
  const shownIn = (out) => [...out.matchAll(/^- commit:([0-9a-f]{10})/gm)].map((m) => bySha10.get(m[1])).filter(Boolean);
  const tokens = (out) => Math.ceil(Buffer.byteLength(out) / 4);
  const timings = { words: [], meaning: [] };
  const search = async (mode, text, asOf, filesKnown) => {
    const ctx = ctxAt(mode, asOf);
    const t0 = performance.now();
    if (mode === "meaning") await lib.prepareHistorySearch(ctx, text, true);
    const out = lib.memorySearch(ctx, text, 5, filesKnown);
    timings[mode].push(performance.now() - t0);
    return out;
  };
  const lib0 = await import(pathToFileURL(join(ROOT, "bench", "stamp.mjs")).href);
  const result = { project: PROJECT, label: opt("--label", "run"), measuredAt: new Date().toISOString(), freezeSha256: createHash("sha256").update(readFileSync(FREEZE)).digest("hex"), ...lib0.stamp(), import: imp.out.split("\n")[0], modes: {} };
  let peakRss = 0;
  for (const mode of ["words", "meaning"]) {
    const m = { checked: [], negatives: [], tasks: [], tokens: [] };
    for (const c of f.checked) {
      const out = await search(mode, c.question);
      const shown = shownIn(out);
      const right = shown.some((r) => r.sha === c.sha || r.title === c.subject);
      m.checked.push({ question: c.question, shown: shown.length, right, wrongOnly: shown.length > 0 && !right });
      m.tokens.push(tokens(out));
    }
    for (const n of [...f.negatives.map((x) => ({ ...x, kind: "realistic" })), ...f.controls.map((x) => ({ question: x.query, kind: "control" }))]) {
      const out = await search(mode, n.question);
      m.negatives.push({ kind: n.kind, question: n.question, shown: shownIn(out).length });
      m.tokens.push(tokens(out));
    }
    for (const t of f.tasks) {
      const touches = (r) => (files.get(r.sha) ?? r.files).some((x) => t.gold.includes(x));
      const out = await search(mode, t.query, t.cut);
      const shown = shownIn(out).filter((r) => r.sha !== t.sha);
      m.tasks.push({ sha: t.sha.slice(0, 10), shown: shown.length, right: shown.some(touches), wrongOnly: shown.length > 0 && !shown.some(touches) });
      m.tokens.push(tokens(out));
    }
    result.modes[mode] = m;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  // Ranking with meaning and known files: is a commit touching a gold file among the first five history records ranked?
  const ranked = [];
  for (const t of f.tasks) {
    const touches = (r) => (files.get(r.sha) ?? r.files).some((x) => t.gold.includes(x));
    const ctx = ctxAt("meaning", t.cut);
    await lib.prepareHistorySearch(ctx, t.query, true);
    const { all } = lib.rankSearch(ctx, t.query, { limit: 5, files: t.known });
    const hist = all.filter((h) => h.id.startsWith("commit:")).map((h) => bySha10.get(h.id.slice(7))).filter((r) => r && r.sha !== t.sha);
    ranked.push(hist.slice(0, 5).some(touches));
  }
  result.rankedTop5MeaningFiles = ranked.filter(Boolean).length / ranked.length;
  result.knownHasGold = f.tasks.filter((t) => t.known.some((k) => t.gold.includes(k))).length;
  // Cold start through the CLI: a new process per search, as an agent's first search would be.
  const cold = { words: [], meaning: [] };
  for (const mode of ["words", "meaning"]) for (const c of f.checked.slice(0, 5)) cold[mode].push(cli(mode, ["memory", "search", c.question]).ms);
  const share = (list, k) => list.filter((x) => x[k]).length / list.length;
  const all = Object.values(result.modes).flatMap((m) => m.tokens);
  const C = f.criteria;
  const checks = [];
  for (const mode of ["words", "meaning"]) {
    const m = result.modes[mode];
    const silent = m.negatives.filter((n) => !n.shown).length / m.negatives.length;
    checks.push([`${mode}: unanswerable questions answered with nothing`, silent >= C.negatives.minSilentShare[mode], `${(silent * 100).toFixed(0)}% (bar ${C.negatives.minSilentShare[mode] * 100}%)`]);
    checks.push([`${mode}: checked questions answered with the right commit`, share(m.checked, "right") >= C.checked.minCorrectShare[mode], `${(share(m.checked, "right") * 100).toFixed(0)}% (bar ${C.checked.minCorrectShare[mode] * 100}%)`]);
    checks.push([`${mode}: checked questions answered only wrongly`, share(m.checked, "wrongOnly") <= C.checked.maxWrongOnlyShare[mode], `${(share(m.checked, "wrongOnly") * 100).toFixed(0)}% (bar <= ${C.checked.maxWrongOnlyShare[mode] * 100}%)`]);
    checks.push([`${mode}: tasks answered with a commit touching a gold file`, share(m.tasks, "right") >= C.tasks.minAnsweredRightShare[mode], `${(share(m.tasks, "right") * 100).toFixed(0)}% (bar ${C.tasks.minAnsweredRightShare[mode] * 100}%)`]);
  }
  checks.push(["meaning+files: a gold-touching commit ranked in the first five", result.rankedTop5MeaningFiles >= C.tasks.minRankedTop5Share["meaning+files"], `${(result.rankedTop5MeaningFiles * 100).toFixed(0)}% (bar ${C.tasks.minRankedTop5Share["meaning+files"] * 100}%)`]);
  checks.push(["output tokens (median, max)", q(all, 0.5) <= C.budget.medianTokens && Math.max(...all) <= C.budget.maxTokens, `${q(all, 0.5)} and ${Math.max(...all)} (bars ${C.budget.medianTokens}, ${C.budget.maxTokens})`]);
  const warm = q(timings.meaning.slice(5), 0.95);
  checks.push(["warm search p95, meaning (in process)", warm <= C.performance.warmP95Ms, `${warm.toFixed(0)} ms (words p95 ${q(timings.words.slice(5), 0.95).toFixed(0)} ms; bar ${C.performance.warmP95Ms})`]);
  const coldM = q(cold.meaning, 0.5);
  checks.push(["cold CLI search, meaning (median of 5)", coldM <= C.performance.coldCliMeaningMs, `${coldM} ms (words ${q(cold.words, 0.5)} ms; bar ${C.performance.coldCliMeaningMs})`]);
  checks.push(["peak memory with the model loaded", peakRss / 1e6 <= C.performance.rssMbMeaning, `${(peakRss / 1e6).toFixed(0)} MB (bar ${C.performance.rssMbMeaning})`]);
  result.checks = checks.map(([name, ok, detail]) => ({ name, ok, detail }));
  result.pass = checks.every(([, ok]) => ok);
  result.timings = { warmMs: { words: q(timings.words.slice(5), 0.5), meaning: q(timings.meaning.slice(5), 0.5) }, coldCliMs: cold };
  writeFileSync(join(OUT, `results-${result.label}.json`), `${JSON.stringify(result, null, 1)}\n`);
  console.log(result.import);
  for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  console.log(`known files include a gold file on ${result.knownHasGold}/${f.tasks.length} tasks`);
  console.log(`${result.pass ? "PASS" : "FAIL"}: bench/history-eval/${PROJECT}/results-${result.label}.json`);
}

if (args.includes("--freeze")) await freeze();
else if (args.includes("--run")) await run();
else console.log("usage: node bench/history-eval.mjs --freeze --project NAME --repo <clone> --ref <ref> | --run --project NAME [--label NAME]");
