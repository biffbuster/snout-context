#!/usr/bin/env node
/**
 * Long-session A/B: a chain of SWE-bench Verified issues worked one after another in ONE Claude Code
 * session, each in its own checkout and container, so the context grows the way real sessions do
 * (SWE-bench and PointFive tasks are 4–20 turns; real sessions run ~200 calls and 100k–1M tokens).
 * Each issue is graded by the official harness; cost is priced per call from the transcript,
 * including the long-prompt tier, because a compaction cap changes which calls cross it.
 *
 * Arms:
 *   off        Snout observe-only (records, changes nothing): the baseline
 *   snout      Snout as shipped when on (enforce). Until 2026-10-09 this arm also set a context
 *              budget (removed from Snout after the confirmation run; see the protocol)
 *   rtk        RTK v0.51.0 (the competitor arm PointFive used), installed by its own `rtk init -g`;
 *              Snout observe-only. Needs bench/frozen/rtk_v0510 (+ rtkpath/rtk on PATH)
 *   default    observe-only, Claude Code's own auto-compact window (pilot arm)
 *   c<N>k      observe-only, CLAUDE_CODE_AUTO_COMPACT_WINDOW=N*1000 (pilot arm, e.g. c100k)
 *   snout-c<N>k Snout on (enforce, incl. the post-compaction memory restore) under the same window:
 *              against c<N>k it isolates what Snout's memory does when compaction is frequent
 *
 * Usage:
 *   node bench/swelong.mjs --arms default,c100k --n 2 --model claude-haiku-5-5 --api
 *   node bench/swelong.mjs --chains django --arms default --n 1 --api      # smoke
 *   node bench/swelong.mjs --append <file> --chains djangoB --arms snout --reps 1 --n <same n> --api   # rerun one chain-run
 *   options: --max-spend 50 (stop once the run has cost $50) · --keep · --no-grade
 *   node bench/swelong.mjs --summarize bench/ab-results/swelong-<ts>.json
 *   node bench/swelong.mjs --merge out.json a.json b.json c.json   # parallel runners → one file
 *   node bench/swelong.mjs --refacts bench/ab-results/swelong-<ts>.json   # recompute costs from transcripts
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// SNOUT_BIN: a frozen build, so edits to dist/ during a run can't change the arm under test.
import { sh, ensureImage, prepareCheckout, writeShims, armSettings, preflight, leftovers, removeContainers, dockerHealthy, grade, REPO, SNOUT_BIN } from "./swe.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const N = Number(args.n ?? 1);
const MODEL = typeof args.model === "string" ? args.model : "claude-haiku-5-5";
const ARMS = (typeof args.arms === "string" ? args.arms : "default,c100k").split(",");
const BUDGET = String(args.budget ?? "3.00");
const API_KEY = args.api ? (readFileSync(join(REPO, ".env.local"), "utf8").split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY=")) ?? "").slice("ANTHROPIC_API_KEY=".length).trim() : null;
if (args.api && !API_KEY) throw new Error("--api: no ANTHROPIC_API_KEY in .env.local");

/** Chains, in a fixed order; every task's image is one the SWE pilot already pulled. */
const CHAINS = {
  django: ["django__django-11099", "django__django-11999", "django__django-15022", "django__django-15280", "django__django-15916", "django__django-16612"],
  sympy: ["sympy__sympy-14711", "sympy__sympy-15875", "sympy__sympy-18763", "sympy__sympy-19954"],
  pytest: ["pytest-dev__pytest-5809", "pytest-dev__pytest-7571", "pytest-dev__pytest-10356"],
};
/**
 * Long chains, drawn once with a fixed seed: `django20` is 20 django issues (fixes under an hour),
 * long enough for the context to pass 100k–300k as real sessions do (3 issues reach ~50k).
 */
const DRAWN = {
  django20: { repo: "django/django", count: 20, seed: 20261008 }, // pilot: the budget values were chosen on it
  // Held-out chains for the confirmation run: disjoint from the pilot chain and the SWE pilot's 15 tasks.
  djangoB: { repo: "django/django", count: 20, seed: 20261009, heldOut: true },
  sympy20: { repo: "sympy/sympy", count: 20, seed: 20261009, heldOut: true },
  sphinx20: { repo: "sphinx-doc/sphinx", count: 20, seed: 20261009, heldOut: true },
  // Fresh chains for the memory run (2026-10-09): disjoint from every chain above.
  djangoC: { repo: "django/django", count: 20, seed: 20261010, heldOut: true },
  sympyB: { repo: "sympy/sympy", count: 20, seed: 20261010, heldOut: true },
  sphinxB: { repo: "sphinx-doc/sphinx", count: 19, seed: 20261010, heldOut: true },
};

/** $/M tokens: [input, cache read, cache write 5m, output], and the prompt size above which all four scale. */
// List prices checked 2026-10-08 (Anthropic docs). Only Haiku 5.5 has a long-prompt step; the 1M
// models bill flat (Opus 5.5's $8/$40 is fast mode, not a context tier). Cache writes are 1.25× input.
const PRICES = {
  "claude-haiku-5-5": { p: [0.1, 0.01, 0.125, 0.5], tierAt: 100_000, tierX: 5 },
  "claude-sonnet-5-5": { p: [2, 0.2, 2.5, 10], tierAt: Infinity, tierX: 1 },
  "claude-opus-5-5": { p: [4, 0.2, 5, 20], tierAt: Infinity, tierX: 1 },
  "claude-fable-5-1": { p: [10, 0.25, 12.5, 50], tierAt: Infinity, tierX: 1 },
};

function callCost(model, u) {
  const pr = PRICES[String(model ?? "").replace(/-\d{8}$/, "")];
  if (!pr) return null;
  const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const x = prompt > pr.tierAt ? pr.tierX : 1;
  const [i, r, w, o] = pr.p;
  return (x * ((u.input_tokens ?? 0) * i + (u.cache_read_input_tokens ?? 0) * r + (u.cache_creation_input_tokens ?? 0) * w + (u.output_tokens ?? 0) * o)) / 1e6;
}

/** Final usage per message (a message is streamed as several entries; the last one carries output tokens). */
function usages(file) {
  const last = new Map();
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type === "assistant" && o.message?.usage) last.set(o.message.id, { u: o.message.usage, model: o.message.model });
  }
  return [...last.values()];
}

/**
 * Per-call facts from the session transcript: cost with each serving model's prices (and Haiku's
 * long-prompt step), peak prompt, compactions. Subagent transcripts (<session>/subagents/*.jsonl)
 * are billed too and counted in the cost; peak and compactions are the main conversation's.
 */
function transcriptFacts(sessionId) {
  const root = join(homedir(), ".claude/projects");
  const r = sh("find", [root, "-name", `${sessionId}.jsonl`]);
  const f = r.stdout.trim().split("\n")[0];
  if (!f || !existsSync(f)) return null;
  const subDir = join(f.replace(/\.jsonl$/, ""), "subagents");
  const subs = existsSync(subDir) ? sh("find", [subDir, "-name", "*.jsonl"]).stdout.trim().split("\n").filter(Boolean) : [];
  let subCost = 0, subCalls = 0;
  for (const s of subs) for (const { u, model } of usages(s)) { subCost += callCost(model ?? MODEL, u) ?? 0; subCalls++; }
  let calls = 0, peak = 0, over = 0, cost = 0;
  const compactions = readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"compact_boundary"')).length;
  for (const { u, model } of usages(f)) {
    const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    cost += callCost(model ?? MODEL, u) ?? 0; calls++; peak = Math.max(peak, prompt);
    if (PRICES[MODEL] && prompt > PRICES[MODEL].tierAt) over++;
  }
  return { transcript: f, costUsd: cost + subCost, mainCostUsd: cost, subagentCostUsd: subCost, subagentCalls: subCalls, calls, peak, callsOverTier: over, compactions };
}

const firstPrompt = (n) => `You'll work through ${n} GitHub issues in this session, one at a time. Each issue has its own folder here, a separate checkout of its repository; the next issue comes after you finish the current one.

In every folder \`python\` and \`pytest\` run inside that project's environment. Do not modify the existing tests.`;

const issuePrompt = (t, i, n, first) => `${first ? firstPrompt(n) + "\n\n" : ""}Issue ${i + 1} of ${n}: resolve it in the folder \`task${i + 1}/\` (${t.repo}) by editing its source code${t.repo === "django/django" ? " (Django's own tests run with `python tests/runtests.py app_label` from that folder)" : ""}.

<issue>
${t.problem_statement}
</issue>`;

const RTK = join(REPO, "bench/frozen/rtk_v0510");

/** RTK's own Claude Code hooks (from `rtk init -g` in a scratch HOME), merged into the arm's settings. */
function addRtk(dir) {
  if (!existsSync(RTK)) throw new Error(`rtk arm: no ${RTK}`);
  const home = mkdtempSync(join(tmpdir(), "rtk-home-"));
  sh(RTK, ["init", "-g", "--auto-patch"], { cwd: home, env: { ...process.env, HOME: home } });
  const installed = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  rmSync(home, { recursive: true, force: true });
  const hooks = JSON.parse(JSON.stringify(installed.hooks ?? {}).replaceAll('"rtk hook claude"', JSON.stringify(`${RTK} hook claude`)));
  if (!Object.keys(hooks).length) throw new Error("rtk arm: rtk init wrote no hooks");
  const file = join(dir, ".claude/settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  for (const [event, entries] of Object.entries(hooks)) settings.hooks[event] = [...(settings.hooks[event] ?? []), ...entries];
  writeFileSync(file, JSON.stringify(settings, null, 2));
}

function runClaude(dir, text, resume, arm) {
  const window = /(?:^|-)c(\d+)k$/.exec(arm);
  return new Promise((resolve) => {
    const argv = [
      "-p", text, "--output-format", "json", "--model", MODEL,
      "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", join(dir, ".mcp.json"),
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "Bash(python:*)", "Bash(python3:*)", "Bash(pytest:*)", "Bash(cd:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)", ...(arm === "rtk" ? ["Bash(rtk:*)"] : []),
      "--max-budget-usd", BUDGET,
      ...(resume ? ["--resume", resume] : []),
    ];
    const env = { ...process.env, SNOUT_MODE: "", PATH: `${join(dir, ".bin")}:${arm === "rtk" ? `${join(REPO, "bench/frozen/rtkpath")}:` : ""}${process.env.PATH}`, ...(API_KEY ? { ANTHROPIC_API_KEY: API_KEY } : {}) };
    if (window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Number(window[1]) * 1000);
    else delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const child = spawn("claude", argv, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 30 * 60_000);
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
  });
}

async function runChain(chain, tasks, arm, rep) {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "snout-long-"));
  const label = dir.split("/").pop();
  const row = { chain, arm, rep, tasks: [], steps: [] };
  try {
    tasks.forEach((t, i) => prepareCheckout(t, join(dir, `task${i + 1}`), label));
    writeShims(dir);
    armSettings(dir, arm === "snout" || arm.startsWith("snout-") ? "enforce" : "off");
    if (arm === "rtk") addRtk(dir);
    let session = null;
    for (let i = 0; i < tasks.length; i++) {
      writeFileSync(join(dir, ".current"), join(sh("realpath", [dir]).stdout.trim(), `task${i + 1}`));
      const r = await runClaude(dir, issuePrompt(tasks[i], i, tasks.length, i === 0), session, arm);
      let out = {};
      try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
      session = out.session_id ?? session;
      row.steps.push({ task: tasks[i].instance_id, cliCumulativeUsd: out.total_cost_usd ?? 0, turns: out.num_turns ?? 0, error: out.is_error ? String(out.result ?? out.subtype ?? "error").slice(0, 200) : undefined, timedOut: r.timedOut || undefined });
      if (r.timedOut) { row.infra = `issue ${i + 1} hit the 30-minute limit`; break; }
      if (!session) { row.infra = `issue ${i + 1}: no session id (${row.steps.at(-1).error ?? "?"})`; break; }
    }
    for (let i = 0; i < tasks.length; i++) {
      const d = join(dir, `task${i + 1}`);
      sh("git", ["add", "-A"], { cwd: d });
      row.tasks.push({ task: tasks[i].instance_id, patch: sh("git", ["diff", "--cached", "HEAD"], { cwd: d }).stdout });
    }
    row.session = session;
    Object.assign(row, session ? transcriptFacts(session) ?? {} : {});
  } catch (e) {
    row.infra = String(e.message).slice(0, 300);
  } finally {
    removeContainers(leftovers(`snout-swe=${label}`));
    if (!args.keep) rmSync(dir, { recursive: true, force: true }); else row.dir = dir;
  }
  row.seconds = Math.round((Date.now() - started) / 1000);
  return row;
}

/** Grade each chain's patches with the official harness, through swe.mjs's grader (rows: task, arm, rep, patch). */
function gradeChains(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const flat = { runId: saved.runId, rows: [] };
  // Only chain-runs not graded yet, so an appended rerun doesn't regrade the whole file.
  // Timed-out chain-runs are graded too (their finished issues have patches), for the strict view.
  for (const c of saved.rows) if (c.tasks?.length && c.tasks.some((t) => t.resolved === undefined)) for (const t of c.tasks) flat.rows.push({ task: t.task, arm: `${c.chain}.${c.arm}`, rep: c.rep, patch: t.patch });
  const tmp = file.replace(/\.json$/, ".flat.json");
  writeFileSync(tmp, JSON.stringify(flat, null, 2));
  grade(tmp);
  const graded = JSON.parse(readFileSync(tmp, "utf8")).rows;
  for (const c of saved.rows) for (const t of c.tasks ?? []) if (t.resolved === undefined) t.resolved = graded.find((g) => g.task === t.task && g.arm === `${c.chain}.${c.arm}` && g.rep === c.rep)?.resolved;
  saved.graded = new Date().toISOString();
  writeFileSync(file, JSON.stringify(saved, null, 2));
}

/**
 * Default view: as pre-registered, chain-runs that failed for infrastructure reasons are left out
 * (and rerun once). `--strict` keeps them, with every issue they didn't finish counted unresolved:
 * the honest view when a failure may come from the arm itself (e.g. an agent that loses its way
 * after a compaction and waits past the time limit).
 */
function summarize(saved) {
  const rows = args.strict ? saved.rows.filter((r) => r.tasks?.length) : saved.rows.filter((r) => !r.infra);
  if (args.strict) console.log("\n  STRICT view: timed-out chain-runs included; their unfinished issues count as unresolved");
  console.log(`\nLong-session A/B, ${saved.model}, n=${saved.n}: chains of SWE-bench Verified issues in one session\n`);
  console.log("  chain    arm        resolved    cost (tiered)   calls   peak prompt   calls >tier   compactions");
  for (const ch of [...new Set(rows.map((r) => r.chain))]) for (const a of ARMS_OF(saved)) {
    const rs = rows.filter((r) => r.chain === ch && r.arm === a);
    if (!rs.length) continue;
    const avg = (k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0) / rs.length;
    const res = rs.flatMap((r) => r.tasks).filter((t) => t.resolved !== undefined);
    console.log(`  ${ch.padEnd(8)} ${a.padEnd(9)} ${(res.length ? `${res.filter((t) => t.resolved).length}/${res.length}` : "?").padStart(9)}   $${avg("costUsd").toFixed(3).padStart(8)}   ${avg("calls").toFixed(0).padStart(7)}   ${Math.round(avg("peak") / 1000).toString().padStart(9)}k   ${avg("callsOverTier").toFixed(0).padStart(11)}   ${avg("compactions").toFixed(1).padStart(11)}`);
  }
  const arms = ARMS_OF(saved);
  for (const a of arms.slice(1)) {
    const base = arms[0];
    const chains = [...new Set(rows.map((r) => r.chain))].filter((ch) => [base, a].every((x) => rows.some((r) => r.chain === ch && r.arm === x)));
    const sum = (x, k) => rows.filter((r) => r.arm === x && chains.includes(r.chain)).reduce((s, r) => s + (r[k] ?? 0), 0);
    const solved = (x) => rows.filter((r) => r.arm === x && chains.includes(r.chain)).flatMap((r) => r.tasks).filter((t) => t.resolved).length;
    const tot = (x) => rows.filter((r) => r.arm === x && chains.includes(r.chain)).flatMap((r) => r.tasks).length;
    const c0 = sum(base, "costUsd"), c1 = sum(a, "costUsd");
    console.log(`\n  ${a} vs ${base}: cost ${c1 <= c0 ? "−" : "+"}${Math.abs((1 - c1 / c0) * 100).toFixed(1)}% ($${c0.toFixed(2)} → $${c1.toFixed(2)}) · resolved ${solved(base)}/${tot(base)} → ${solved(a)}/${tot(a)} · cost per resolved $${(c0 / Math.max(1, solved(base))).toFixed(3)} → $${(c1 / Math.max(1, solved(a))).toFixed(3)}`);
  }
  // Pre-registered statistics (docs/benchmark-protocol.md, "Long sessions"): 95% bootstrap
  // intervals, resampling chain-runs for cost per resolved, and issues (paired by chain, run and
  // issue) for the change in resolved rate.
  if (arms.length >= 2) {
    const [base, arm] = [arms[0], arms[arms.length - 1]];
    const pairs = rows.filter((r) => r.arm === base).map((b) => [b, rows.find((r) => r.arm === arm && r.chain === b.chain && r.rep === b.rep)]).filter(([, o]) => o);
    if (pairs.length && pairs.every(([b, o]) => [...b.tasks, ...o.tasks].every((t) => t.resolved !== undefined))) {
      let x = 20261008;
      const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
      const solvedIn = (r) => r.tasks.filter((t) => t.resolved).length;
      const cpr = (ps) => {
        const c = (i) => ps.reduce((s, p) => s + p[i].costUsd, 0) / Math.max(1, ps.reduce((s, p) => s + solvedIn(p[i]), 0));
        return c(1) / c(0) - 1;
      };
      const issues = pairs.flatMap(([b, o]) => b.tasks.map((t, i) => (o.tasks[i]?.resolved ? 1 : 0) - (t.resolved ? 1 : 0)));
      const B = 4000, cs = [], ds = [];
      for (let k = 0; k < B; k++) {
        cs.push(cpr(pairs.map(() => pairs[Math.floor(rand() * pairs.length)])));
        let d = 0; for (let j = 0; j < issues.length; j++) d += issues[Math.floor(rand() * issues.length)];
        ds.push(d / issues.length);
      }
      cs.sort((a, b) => a - b); ds.sort((a, b) => a - b);
      const f = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;
      const meanD = issues.reduce((a, b) => a + b, 0) / issues.length;
      console.log(`\n  pre-registered: cost per resolved ${f(cpr(pairs))} (95% CI ${f(cs[100])} to ${f(cs[3899])}, ${pairs.length} paired chain-runs) → savings claim ${cs[3899] < 0 ? "MET" : "not met"}`);
      console.log(`  pre-registered: resolved rate ${f(meanD).replace("%", " pts")} (95% CI ${f(ds[100]).replace("%", "")} to ${f(ds[3899]).replace("%", "")} pts, ${issues.length} paired issues) → no-quality-loss claim ${ds[100] > -0.07 ? "MET" : "not met"} (floor −7 pts)`);
    }
  }
  const infra = saved.rows.filter((r) => r.infra);
  if (infra.length) console.log(`\n  infrastructure failures (excluded): ${infra.map((r) => `${r.chain}/${r.arm}/${r.rep}: ${r.infra}`).join("; ")}`);
}
const ARMS_OF = (saved) => saved.arms ?? ARMS;

async function main() {
  if (typeof args.summarize === "string") return summarize(JSON.parse(readFileSync(args.summarize, "utf8")));
  // --merge <out> <in...>: one results file from runners that ran in parallel (one per run index).
  if (typeof args.merge === "string") {
    const ins = process.argv.slice(process.argv.indexOf(args.merge) + 1).filter((x) => x.endsWith(".json"));
    const parts = ins.map((f) => JSON.parse(readFileSync(f, "utf8")));
    if (new Set(parts.map((p) => `${p.model}|${p.n}|${p.snout?.sha256}|${(p.arms ?? []).join(",")}`)).size !== 1) throw new Error("--merge: inputs differ in model, n, arms or Snout build");
    const merged = { ...parts[0], runId: `merged-${parts.map((p) => p.runId).join("+")}`, mergedFrom: ins, rows: parts.flatMap((p) => p.rows), excluded: parts.flatMap((p) => p.excluded ?? []) };
    writeFileSync(args.merge, JSON.stringify(merged, null, 2));
    return summarize(merged);
  }
  // --refacts: recompute cost and context facts from the transcripts (e.g. after a pricing fix).
  if (typeof args.refacts === "string") {
    const saved = JSON.parse(readFileSync(args.refacts, "utf8"));
    for (const r of saved.rows) if (r.session) Object.assign(r, transcriptFacts(r.session) ?? {});
    writeFileSync(args.refacts, JSON.stringify(saved, null, 2));
    return summarize(saved);
  }
  if (typeof args.grade === "string") { gradeChains(args.grade); return summarize(JSON.parse(readFileSync(args.grade, "utf8"))); }
  if (!PRICES[MODEL]) throw new Error(`no tiered prices for ${MODEL}; add them to PRICES`);
  const all = JSON.parse(readFileSync(join(REPO, "bench/swe-tasks.json"), "utf8")).tasks;
  // Tasks outside the pilot's 15 (django-11099) come from the dataset via swe.mjs's selection dump.
  const dump = sh(process.env.SWE_PY || join(homedir(), "opt/anaconda3/envs/swebench/bin/python"), ["-c", `
import json
from swebench.harness.utils import load_swebench_dataset
print(json.dumps([{k: d[k] for k in ("instance_id","repo","base_commit","problem_statement","image","difficulty")} for d in load_swebench_dataset("SWE-bench/SWE-bench_Verified","test")]))
`]);
  if (dump.status !== 0) throw new Error(dump.stderr.slice(-1000));
  const extra = JSON.parse(dump.stdout);
  const used = new Set(all.map((t) => t.instance_id)); // the SWE pilot's tasks are development data
  for (const [name, d] of Object.entries(DRAWN)) {
    const pool = extra.filter((t) => t.repo === d.repo && (!d.heldOut || !used.has(t.instance_id)) && ["<15 min fix", "15 min - 1 hour"].includes(t.difficulty)).sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    let x = d.seed % 2147483647;
    const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    CHAINS[name] = pool.slice(0, d.count).map((t) => t.instance_id);
    for (const id of CHAINS[name]) used.add(id);
  }
  const byId = new Map([...extra, ...all].map((t) => [t.instance_id, t]));
  const names = typeof args.chains === "string" ? args.chains.split(",") : ["django20"];
  const plan = [];
  const reps = typeof args.reps === "string" ? args.reps.split(",").map(Number) : [...Array(N).keys()];
  for (const rep of reps) for (const ch of names) for (const a of ARMS) plan.push([ch, CHAINS[ch].map((id) => byId.get(id)), a, rep]);
  for (const [, ts] of plan) if (ts.some((t) => !t)) throw new Error("a chain task is missing from the dataset");
  const images = [...new Set(plan.flatMap(([, ts]) => ts.map((t) => t.image)))];
  for (const im of images) ensureImage(im); // pull before any session, so pulls don't count against it
  preflight(images);
  // --append: add (re)runs to an existing results file; a chain-run it replaces moves to `excluded`.
  const prior = typeof args.append === "string" ? JSON.parse(readFileSync(args.append, "utf8")) : null;
  if (prior && (prior.model !== MODEL || prior.n !== N)) throw new Error(`--append: file is model ${prior.model} n ${prior.n}; pass the same --model and --n`);
  const runId = prior?.runId ?? `swelong-${Date.now()}`;
  const outFile = prior ? args.append : join(REPO, "bench/ab-results", `${runId}.json`);
  mkdirSync(join(REPO, "bench/ab-results"), { recursive: true });
  const replaced = (r) => plan.some(([ch, , a, rep]) => r.chain === ch && r.arm === a && r.rep === rep);
  const excluded = [...(prior?.excluded ?? []), ...(prior?.rows ?? []).filter(replaced)];
  const rows = (prior?.rows ?? []).filter((r) => !replaced(r));
    if (prior && prior.snout?.sha256 && prior.snout.sha256 !== createHash("sha256").update(readFileSync(SNOUT_BIN)).digest("hex")) throw new Error("--append: the Snout build differs from the one this file was measured with (set SNOUT_BIN to it)");
  const snout = { bin: SNOUT_BIN, sha256: createHash("sha256").update(readFileSync(SNOUT_BIN)).digest("hex") };
  const save = () => writeFileSync(outFile, JSON.stringify({ runId, model: MODEL, n: N, arms: prior?.arms ?? ARMS, measuredAt: prior?.measuredAt ?? new Date().toISOString(), ...(prior ? { appendedAt: [...(prior.appendedAt ?? []), new Date().toISOString()] } : {}), claudeCode: sh("claude", ["--version"]).stdout.trim(), snout, rows, ...(excluded.length ? { excluded } : {}) }, null, 2));
  console.error(`${plan.length} chain session(s): ${names.join(", ")} × ${ARMS.join(", ")} × ${N}, model ${MODEL} → ${outFile}`);
  let done = 0;
  for (const [ch, ts, a, rep] of plan) { // one at a time: a chain runs several containers
    const row = await runChain(ch, ts, a, rep);
    rows.push(row); save(); done++;
    process.stderr.write(`[${done}/${plan.length}] ${ch} · ${a} · rep ${rep}: ${row.infra ? `INFRA ${row.infra}` : `${row.calls} calls · peak ${Math.round(row.peak / 1000)}k · ${row.compactions} compaction(s) · $${row.costUsd.toFixed(3)} · ${row.tasks.filter((t) => t.patch.trim()).length}/${row.tasks.length} patched`}\n`);
    if (!dockerHealthy(ts[0].image)) { console.error("Docker unhealthy; stopping"); break; }
    // --max-spend: stop before the next session once the run has cost this much (priced from transcripts).
    const spent = rows.reduce((x, r) => x + (r.costUsd ?? 0), 0);
    if (args["max-spend"] && spent >= Number(args["max-spend"])) { console.error(`spent $${spent.toFixed(2)} ≥ --max-spend $${args["max-spend"]}; stopping`); break; }
  }
  console.log(`\nSessions: ${outFile}`);
  if (!args["no-grade"]) gradeChains(outFile);
  summarize(JSON.parse(readFileSync(outFile, "utf8")));
}

main().catch((e) => { console.error(e); process.exit(1); });
