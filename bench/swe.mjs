#!/usr/bin/env node
/**
 * Public-task A/B: SWE-bench Verified issues, run by a real headless Claude Code with Snout off
 * and with Snout enforcing, graded by the official SWE-bench harness. Protocol, fixed before any
 * run: docs/benchmark-protocol.md.
 *
 * The agent works on a host copy of the task image's /testbed; `python` and `pytest` on its
 * PATH run inside the same image with that copy mounted. After every session its diff is saved
 * as a prediction; `--grade` hands each arm's predictions to `swebench.harness.run_evaluation`.
 * Snout plays no part in grading.
 *
 * Needs Docker and a Python 3.11 env with `swebench` (SWE_PY, default ~/opt/anaconda3/envs/swebench/bin/python).
 *
 * Usage:
 *   node bench/swe.mjs --select                     # seeded draw → bench/swe-tasks.json
 *   node bench/swe.mjs --n 2 --model haiku          # run every task × arm × n, then grade
 *   node bench/swe.mjs --n 1 --tasks django__django-11099 --arms enforce   # smoke
 *   node bench/swe.mjs --grade bench/ab-results/swe-<ts>.json
 *   node bench/swe.mjs --summarize bench/ab-results/swe-<ts>.json
 *   node bench/swe.mjs --n 1 --arms off,enforce,map --tasks a,b   # repo map on its own (arm "map")
 *   node bench/swe.mjs --resume bench/ab-results/swe-<ts>.json --n 2 --arms off,map   # rerun infra rows, finish the plan
 *   options: --jobs 2  --budget 2.00  --keep  --api (bill ANTHROPIC_API_KEY from .env.local)  --min-mem-gb 5.5
 *
 * Docker is checked before the run and after every session: a starved Docker VM (2 GB) wedges
 * the engine, so `python` hangs and sessions measure the hang instead of the agent.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gateEntries, squeezeEntries } from "../dist/lib.mjs";
import { bootstrap } from "./long.mjs";
import { reliabilityLines, costLines, ledgerFacts, peakContext, mapFacts } from "./stats.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const N = Number(args.n ?? 1);
const MODEL = typeof args.model === "string" ? args.model : "haiku";
/** --api: bill ANTHROPIC_API_KEY from .env.local instead of the Claude login (real billed cost, no plan usage). */
const API_KEY = args.api ? (readFileSync(join(new URL("..", import.meta.url).pathname, ".env.local"), "utf8").split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY=")) ?? "").slice("ANTHROPIC_API_KEY=".length).trim() : null;
if (args.api && !API_KEY) throw new Error("--api: no ANTHROPIC_API_KEY in .env.local");
const ARMS = (typeof args.arms === "string" ? args.arms : "off,enforce").split(",");
const BUDGET = String(args.budget ?? "2.00");
const JOBS = Number(args.jobs ?? 2);
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SNOUT_BIN = process.env.SNOUT_BIN || join(REPO, "dist/snout.mjs");
const SWE_PY = process.env.SWE_PY || join(homedir(), "opt/anaconda3/envs/swebench/bin/python");
const DATASET = "SWE-bench/SWE-bench_Verified";
const MIN_MEM_GB = Number(args["min-mem-gb"] ?? 5.5);
const SESSION_LIMIT_MS = 30 * 60_000;
const TASKS_FILE = join(REPO, "bench/swe-tasks.json");

// ------------------------------------------------------------------ selection (protocol: seed, eligibility, cap)

const SEED = 20261006;
const COUNT = 15;
const PER_REPO = 5;
const ELIGIBLE = new Set(["django/django", "sympy/sympy", "sphinx-doc/sphinx", "pydata/xarray", "pytest-dev/pytest", "pylint-dev/pylint", "psf/requests", "mwaskom/seaborn", "pallets/flask"]);

function rng(seed) {
  let s = seed % 2147483647;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function select() {
  const dump = spawnSync(SWE_PY, ["-c", `
import json
from swebench.harness.utils import load_swebench_dataset
ds = load_swebench_dataset(${JSON.stringify(DATASET)}, "test")
keep = ("instance_id", "repo", "base_commit", "problem_statement", "difficulty", "image")
print(json.dumps([{k: d[k] for k in keep} for d in ds]))
`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error(dump.stderr.slice(-2000));
  const all = JSON.parse(dump.stdout).sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const pool = all.filter((t) => ELIGIBLE.has(t.repo) && t.difficulty !== ">4 hours");
  const rand = rng(SEED);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const perRepo = {};
  const picked = [];
  for (const t of pool) {
    if (picked.length === COUNT) break;
    if ((perRepo[t.repo] ?? 0) >= PER_REPO) continue;
    perRepo[t.repo] = (perRepo[t.repo] ?? 0) + 1;
    picked.push(t);
  }
  writeFileSync(TASKS_FILE, JSON.stringify({ dataset: DATASET, seed: SEED, eligible: pool.length, tasks: picked }, null, 2) + "\n");
  console.log(`${picked.length} of ${pool.length} eligible (seed ${SEED}) → ${TASKS_FILE}`);
  for (const t of picked) console.log(`  ${t.instance_id.padEnd(34)} ${t.difficulty}`);
}

// ------------------------------------------------------------------ docker health

/** Benchmark containers left behind: stuck in Created or still running after their session ended. */
function leftovers(label = "snout-swe") {
  const r = sh("docker", ["ps", "-aq", "--filter", `label=${label}`], { timeout: 60_000 });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function removeContainers(ids) {
  if (ids.length) sh("docker", ["rm", "-f", ...ids], { timeout: 120_000 });
}

/** A container must start, run and exit within a minute; a wedged engine accepts commands and never runs them. */
function dockerHealthy(image) {
  const r = sh("docker", ["run", "--rm", "--label", "snout-swe=probe", image, "true"], { timeout: 60_000 });
  return r.status === 0;
}

function preflight(images) {
  const info = sh("docker", ["info", "--format", "{{.MemTotal}}"], { timeout: 30_000 });
  if (info.status !== 0) throw new Error(`docker not responding: ${(info.stderr || "timed out").trim()}`);
  const gb = Number(info.stdout.trim()) / 1024 ** 3;
  if (gb < MIN_MEM_GB) throw new Error(`Docker VM has ${gb.toFixed(1)} GB RAM; SWE sessions need ≥ ${MIN_MEM_GB} GB or the engine wedges (Docker Desktop → Settings → Resources; or --min-mem-gb)`);
  // SWE_SHARED_DOCKER=1: other runners share this Docker, so their live containers are not leftovers.
  if (!process.env.SWE_SHARED_DOCKER) {
    const stale = leftovers();
    if (stale.length) { console.error(`removing ${stale.length} leftover benchmark container(s)`); removeContainers(stale); }
    if (leftovers().length) throw new Error("leftover benchmark containers could not be removed: the Docker engine is wedged; restart Docker Desktop");
  }
  if (!dockerHealthy(images[0])) throw new Error("a test container did not run within 60 s: restart Docker Desktop");
}

// ------------------------------------------------------------------ workspace

const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function ensureImage(image) {
  if (sh("docker", ["image", "inspect", image]).status === 0) return;
  // Registry hiccups (TLS handshake timeouts) are common over a long pull list: retry with a pause.
  let r;
  for (let i = 0; i < 4; i++) {
    r = sh("docker", ["pull", "-q", image], { timeout: 30 * 60_000 });
    if (r.status === 0) return;
    sh("sleep", [String(15 * (i + 1))]);
  }
  throw new Error(`pull ${image}: ${r.stderr}`);
}

/**
 * `python`, `python3` and `pytest` for the agent: each runs in the session's own container of the
 * task image, in the matching directory, so the agent types ordinary commands. Nothing is
 * bind-mounted: Docker Desktop's macOS file sharing hangs under this load (reads from the mount
 * never return, `python` freezes at 0% CPU), so before every call the files the agent changed,
 * added or deleted since the baseline are copied into the container's own /testbed.
 * Scripts outside the repo (\`python /tmp/repro.py\`, or a scratch folder the agent cd'd into) are
 * copied to the same path in the container too. Files a command writes inside the container do
 * not come back to the host.
 */
const SHIM = (entry) => `#!/bin/sh
here="$(pwd -P)"
# The task checkout: the nearest folder up from here with a .swe-task file (it names the container),
# else the one .current points to (a chain of tasks in one session), else the folder above .bin.
d="$here"; while [ "$d" != / ] && [ ! -f "$d/.swe-task" ]; do d="$(dirname "$d")"; done
top="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ -f "$d/.swe-task" ]; then root="$d"; elif [ -f "$top/.current" ]; then root="$(cat "$top/.current")"; else root="$top"; fi
c="$(cat "$root/.swe-task")"
# Copy a host file or small folder outside the repo to the same path in the container.
put() { [ -e "$1" ] || return 0; d="$(dirname "$1")"; b="$(basename "$1")"; [ "$(du -sk "$1" | cut -f1)" -le 20000 ] || return 1
  COPYFILE_DISABLE=1 tar --no-mac-metadata -cf - -C "$d" "$b" | docker exec -i "$c" sh -c 'mkdir -p "$1" && tar -xf - -C "$1" --warning=no-unknown-keyword' _ "$d"; }
case "$here" in
  "$root"|"$root"/*) wd="/testbed\${here#"$root"}" ;;
  *) case "$root" in
       "$here"/*) wd="$here" ;; # a folder above the checkout (a chain's root): linked in the container too
       *) if put "$PWD"; then wd="$PWD"; else wd=/testbed; fi ;;
     esac ;;
esac
for a in "$@"; do case "$a" in -*) ;; *) [ -f "$a" ] || continue; f="$(cd "$(dirname "$a")" && pwd -P)/$(basename "$a")"
  case "$f" in "$root"/*) ;; *) case "$a" in /*) put "$a" ;; *) put "$PWD/$a" ;; esac ;; esac ;; esac; done
(
  cd "$root" || exit 1
  list=.swe-synced
  { cat "$list" 2>/dev/null; git -c core.quotepath=off diff --name-only --no-renames HEAD; git -c core.quotepath=off ls-files --others --exclude-standard; } | sort -u > "$list.$$" && mv "$list.$$" "$list"
  present="$(mktemp)"; gone="$(mktemp)"
  while IFS= read -r f; do if [ -e "$f" ]; then printf '%s\\n' "$f" >> "$present"; else printf '%s\\n' "$f" >> "$gone"; fi; done < "$list"
  [ -s "$present" ] && COPYFILE_DISABLE=1 tar --no-mac-metadata -cf - -T "$present" | docker exec -i "$c" tar -xf - -C /testbed --warning=no-unknown-keyword
  [ -s "$gone" ] && tr '\\n' '\\0' < "$gone" | docker exec -i "$c" sh -c 'cd /testbed && xargs -0 rm -rf --'
  rm -f "$present" "$gone"
)
exec docker exec -i -w "$wd" "$c" bash -c 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && exec ${entry} "$@"' ${entry} "$@"
`;

/** The session's container: the image's own /testbed, with the host workspace paths linked to it so absolute paths work. */
function startContainer(image, dir, label = dir.split("/").pop()) {
  const name = `snout-swe-${dir.split("/").slice(-2).join("-").replace(/[^\w.-]/g, "_")}`;
  const r = sh("docker", ["run", "-d", "--name", name, "--label", `snout-swe=${label}`, "--entrypoint", "sleep", image, "infinity"], { timeout: 120_000 });
  if (r.status !== 0) throw new Error(`start container: ${r.stderr}`);
  const real = sh("realpath", [dir]).stdout.trim();
  const links = [...new Set([dir, real])].map((p) => `mkdir -p "${p.replace(/\/[^/]+$/, "")}" && ln -s /testbed "${p}"`).join(" && ");
  const l = sh("docker", ["exec", name, "sh", "-c", links], { timeout: 60_000 });
  if (l.status !== 0) throw new Error(`link workspace paths: ${l.stderr}`);
  writeFileSync(join(dir, ".swe-task"), name);
}

/**
 * A host copy of the task image's /testbed at base_commit, committed as "baseline" so the saved diff
 * is the agent's alone, plus the task's own container. `label` groups containers for cleanup.
 */
export function prepareCheckout(task, dir, label) {
  ensureImage(task.image);
  mkdirSync(dir, { recursive: true });
  const cid = sh("docker", ["create", task.image]).stdout.trim();
  const cp = sh("docker", ["cp", `${cid}:/testbed/.`, dir]);
  sh("docker", ["rm", cid]);
  if (cp.status !== 0) throw new Error(`copy /testbed: ${cp.stderr}`);
  const git = (...a) => sh("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", ...a], { cwd: dir });
  // The images add one empty "SWE-bench" commit on top of base_commit.
  if (![git("rev-parse", "HEAD").stdout.trim(), git("rev-parse", "HEAD^").stdout.trim()].includes(task.base_commit)) throw new Error(`${task.instance_id}: /testbed is not at base_commit`);
  appendFileSync(join(dir, ".git/info/exclude"), "\n/.bin/\n/.claude/\n/.snout/\n/.mcp.json\n/.swe-task\n/.swe-synced*\n__pycache__/\n*.pyc\n.pytest_cache/\n");
  // Anything the image left uncommitted becomes the baseline, so the saved diff is the agent's alone.
  git("add", "-A");
  git("commit", "-q", "--no-verify", "--allow-empty", "-m", "baseline");
  startContainer(task.image, dir, label);
}

/** `python`, `python3` and `pytest` shims for the agent, in `dir`/.bin. */
export function writeShims(dir) {
  mkdirSync(join(dir, ".bin"), { recursive: true });
  for (const [name, entry] of [["python", "python"], ["python3", "python"], ["pytest", "pytest"]]) {
    writeFileSync(join(dir, ".bin", name), SHIM(entry));
    chmodSync(join(dir, ".bin", name), 0o755);
  }
}

/** Claude Code hooks and Snout config for an arm, in `dir` (the agent's working directory). */
export function armSettings(dir, arm) {
  const post = { type: "command", command: `node "${SNOUT_BIN}" post-tool`, timeout: 10, async: true };
  const hooks = { PostToolUse: [{ matcher: "Read|NotebookRead|Bash|Grep|Glob|WebFetch|WebSearch|mcp__.*", hooks: [post] }] };
  if (arm === "enforce" || arm === "map") {
    hooks.SessionStart = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" session-start`, timeout: 10 }] }];
    hooks.PreToolUse = gateEntries(SNOUT_BIN);
    hooks.PostToolUse.push(...squeezeEntries(SNOUT_BIN));
    hooks.PreCompact = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" pre-compact`, timeout: 10 }] }];
  }
  // "map" is enforce plus repo-map suggestions on the prompt, to measure the map on its own.
  if (arm === "map") hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" prompt-submit`, timeout: 10 }] }];
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  mkdirSync(join(dir, ".snout"), { recursive: true });
  writeFileSync(join(dir, ".snout/config.json"), JSON.stringify({ mode: arm === "off" ? "observe" : "enforce", ...(arm === "map" ? { repoMap: true } : {}) }) + "\n");
}

function makeWorkspace(task, arm) {
  const dir = mkdtempSync(join(tmpdir(), "snout-swe-"));
  prepareCheckout(task, dir);
  writeShims(dir);
  armSettings(dir, arm);
  return dir;
}

const prompt = (task) => `Resolve the GitHub issue below in the repository in the current directory, by editing its source code.

The project's environment is set up: \`python\` and \`pytest\` run inside it${task.repo === "django/django" ? " (Django's own tests run with `python tests/runtests.py app_label`)" : ""}. Do not modify the existing tests.

<issue>
${task.problem_statement}
</issue>`;

// ------------------------------------------------------------------ run

function runClaude(dir, text) {
  return new Promise((resolve) => {
    const argv = [
      "-p", text,
      "--output-format", "json",
      "--model", MODEL,
      "--setting-sources", "project",
      "--strict-mcp-config",
      "--mcp-config", join(dir, ".mcp.json"),
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "Bash(python:*)", "Bash(python3:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)",
      "--max-budget-usd", BUDGET,
    ];
    const child = spawn("claude", argv, { cwd: dir, env: { ...process.env, SNOUT_MODE: "", PATH: `${join(dir, ".bin")}:${process.env.PATH}`, ...(API_KEY ? { ANTHROPIC_API_KEY: API_KEY } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, SESSION_LIMIT_MS);
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
  });
}

async function runOne(task, arm, rep) {
  const started = Date.now();
  let dir;
  try { dir = makeWorkspace(task, arm); } catch (e) { return { task: task.instance_id, arm, rep, infra: String(e.message).slice(0, 300) }; }
  const r = await runClaude(dir, prompt(task));
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
  const u = out.usage ?? {};
  const facts = ledgerFacts(join(dir, ".snout/ledger.jsonl"));
  const peak = peakContext(out.session_id);
  const mf = mapFacts(join(dir, ".snout"));
  sh("git", ["add", "-A"], { cwd: dir });
  const patch = sh("git", ["diff", "--cached", "HEAD"], { cwd: dir }).stdout;
  const row = {
    task: task.instance_id, arm, rep,
    error: out.is_error ? String(out.result ?? out.subtype ?? "error").slice(0, 200) : undefined,
    uncached: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    turns: out.num_turns ?? 0,
    costUsd: (out.total_cost_usd ?? 0) + facts.jevUsd,
    withheld: facts.withheld, byRule: facts.byRule,
    followUps: facts.followUps, followUpTokens: facts.followUpTokens, jevUsd: facts.jevUsd,
    peak: peak?.peak,
    ...(arm === "map" ? { map: mf } : {}),
    patch,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  const left = leftovers(`snout-swe=${dir.split("/").pop()}`);
  removeContainers(left);
  if (r.timedOut) row.infra = `session hit the ${SESSION_LIMIT_MS / 60_000}-minute limit`;
  else if (leftovers(`snout-swe=${dir.split("/").pop()}`).length) row.infra = "session container could not be removed (Docker hang)";
  if (!dockerHealthy(task.image)) { row.infra = `Docker unhealthy after the session${row.infra ? `; ${row.infra}` : ""}`; row.dockerDown = true; }
  if (!args.keep) rmSync(dir, { recursive: true, force: true });
  else row.dir = dir;
  return row;
}

// ------------------------------------------------------------------ grade (official harness)

function grade(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const work = join(REPO, "bench/ab-results", `${saved.runId}-grading`);
  mkdirSync(work, { recursive: true });
  const groups = {};
  for (const r of saved.rows) if (!r.infra) (groups[`${r.arm}-${r.rep}`] ??= []).push(r);
  for (const [key, rows] of Object.entries(groups)) {
    const model = `snout-${key}`;
    const preds = join(work, `${model}.jsonl`);
    writeFileSync(preds, rows.map((r) => JSON.stringify({ instance_id: r.task, model_name_or_path: model, model_patch: r.patch })).join("\n") + "\n");
    const ids = rows.filter((r) => r.patch.trim()).map((r) => r.task);
    if (ids.length) {
      console.error(`grading ${model}: ${ids.length} patch(es)`);
      const g = sh(SWE_PY, ["-m", "swebench.harness.run_evaluation", "-d", DATASET, "-p", preds, "-i", ...ids, "--max_workers", String(JOBS), "-id", saved.runId, "--report_dir", work], { cwd: work, stdio: ["ignore", "inherit", "inherit"], timeout: 4 * 3600_000 });
      if (g.status !== 0) throw new Error(`grader exited ${g.status} for ${model}`);
    }
    const reportFile = join(work, `${model}.${saved.runId}.json`);
    const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : { resolved_ids: [] };
    const resolved = new Set(report.resolved_ids ?? []);
    for (const r of rows) r.resolved = resolved.has(r.task);
  }
  saved.graded = { at: new Date().toISOString(), dataset: DATASET, swebench: sh(SWE_PY, ["-c", "import swebench;print(swebench.__version__)"]).stdout.trim() };
  writeFileSync(file, JSON.stringify(saved, null, 2));
}

// ------------------------------------------------------------------ summary

function summarize(saved) {
  const rows = saved.rows.filter((r) => !r.infra);
  const sum = (rs, k) => rs.reduce((x, r) => x + (r[k] ?? 0), 0);
  const pct = (a, b) => (b > 0 ? `${a <= b ? "−" : "+"}${Math.abs((1 - a / b) * 100).toFixed(1)}%` : "n/a");
  const tasks = [...new Set(rows.map((r) => r.task))];
  console.log(`\nSWE-bench Verified A/B, claude ${saved.model}, n=${saved.n}, ${tasks.length} tasks\n`);
  console.log("  task                                arm       resolved   input tok   output   turns     cost   kept out");
  for (const t of tasks) for (const a of ["off", "enforce", "map"]) {
    const rs = rows.filter((r) => r.task === t && r.arm === a);
    if (!rs.length) continue;
    const avg = (k) => sum(rs, k) / rs.length;
    const res = rs.some((r) => r.resolved !== undefined) ? `${rs.filter((r) => r.resolved).length}/${rs.length}` : "?";
    console.log(`  ${t.padEnd(35)} ${a.padEnd(9)} ${res.padStart(8)} ${String(Math.round(avg("inputTokens"))).padStart(11)} ${String(Math.round(avg("outputTokens"))).padStart(8)} ${avg("turns").toFixed(1).padStart(7)}   $${avg("costUsd").toFixed(3)} ${String(Math.round(avg("withheld"))).padStart(9)}`);
  }
  for (const [base, arm] of [["off", "enforce"], ["off", "map"], ["enforce", "map"]]) compareArms(rows, tasks, base, arm, sum, pct);
  const infra = saved.rows.filter((r) => r.infra);
  if (infra.length) console.log(`  infrastructure failures (excluded): ${infra.map((r) => `${r.task}/${r.arm}/${r.rep}`).join(", ")}`);
}

function compareArms(rows, tasks, base, arm, sum, pct) {
  const paired = tasks.filter((t) => [base, arm].every((a) => rows.some((r) => r.task === t && r.arm === a)));
  const off = rows.filter((r) => r.arm === base && paired.includes(r.task));
  const on = rows.filter((r) => r.arm === arm && paired.includes(r.task));
  if (!off.length || !on.length) return;
  console.log(`\n  ${arm} vs ${base} (${paired.length} tasks run in both)\n`);
  console.log(`  cost            ${pct(sum(on, "costUsd"), sum(off, "costUsd"))}   ($${sum(off, "costUsd").toFixed(2)} → $${sum(on, "costUsd").toFixed(2)})`);
  const ci = bootstrap(off, on, "costUsd");
  if (ci) console.log(`  cost 95% CI     ${ci}   (bootstrap over tasks, then runs within each task)`);
  console.log(`  input tokens    ${pct(sum(on, "inputTokens"), sum(off, "inputTokens"))}`);
  const ciIn = bootstrap(off, on, "inputTokens");
  if (ciIn) console.log(`  input 95% CI    ${ciIn}`);
  console.log(`  output tokens   ${pct(sum(on, "outputTokens"), sum(off, "outputTokens"))}`);
  console.log(`  turns           ${pct(sum(on, "turns"), sum(off, "turns"))}`);
  for (const l of costLines(off, on, sum)) console.log(l);
  if (rows.some((r) => r.resolved !== undefined)) {
    for (const l of reliabilityLines(off, on, (r) => r.resolved, [base, arm])) console.log(l);
    console.log(`  resolved        ${base} ${off.filter((r) => r.resolved).length}/${off.length} · ${arm} ${on.filter((r) => r.resolved).length}/${on.length}   (official SWE-bench harness)`);
    const lost = paired.filter((t) => off.filter((r) => r.task === t).every((r) => r.resolved) && !on.some((r) => r.task === t && r.resolved));
    const gained = paired.filter((t) => on.filter((r) => r.task === t).every((r) => r.resolved) && !off.some((r) => r.task === t && r.resolved));
    if (lost.length) console.log(`  resolved in every ${base} run, no ${arm} run: ${lost.join(", ")}`);
    if (gained.length) console.log(`  resolved in every ${arm} run, no ${base} run: ${gained.join(", ")}`);
  }
  const m = on.filter((r) => r.map);
  if (m.length) {
    const t = (k) => m.reduce((x, r) => x + r.map[k], 0);
    console.log(`  repo map        ${t("suggestions")} suggestion(s), ~${Math.round(t("suggestedTokens") / 1000)}k tokens; agent opened ${t("opened")} of ${t("suggested")} suggested files`);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  if (args.select) return select();
  if (typeof args.grade === "string") { grade(args.grade); return summarize(JSON.parse(readFileSync(args.grade, "utf8"))); }
  if (typeof args.summarize === "string") return summarize(JSON.parse(readFileSync(args.summarize, "utf8")));
  if (!existsSync(TASKS_FILE)) throw new Error("no bench/swe-tasks.json: run --select first");
  const all = JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks;
  const only = typeof args.tasks === "string" ? new Set(args.tasks.split(",")) : null;
  const tasks = only ? all.filter((t) => only.has(t.instance_id)) : all;
  // --resume: infra rows move to `excluded` (kept for the record) and are run again with whatever the plan still lacks.
  const resumed = typeof args.resume === "string" ? JSON.parse(readFileSync(args.resume, "utf8")) : null;
  if (resumed && (resumed.model !== MODEL || resumed.n !== N)) throw new Error(`--resume: file is model ${resumed.model} n ${resumed.n}; pass the same --model and --n`);
  const excluded = [...(resumed?.excluded ?? []), ...(resumed?.rows ?? []).filter((r) => r.infra)];
  const rows = (resumed?.rows ?? []).filter((r) => !r.infra);
  const have = new Set(rows.map((r) => `${r.task}|${r.arm}|${r.rep}`));
  const plan = [];
  for (let rep = 0; rep < N; rep++) for (const t of tasks) for (const a of ARMS) if (!have.has(`${t.instance_id}|${a}|${rep}`)) plan.push([t, a, rep]);
  const runId = resumed?.runId ?? `swe-${Date.now()}`;
  const outFile = resumed ? args.resume : join(REPO, "bench/ab-results", `${runId}.json`);
  mkdirSync(join(REPO, "bench/ab-results"), { recursive: true });
  const frozen = {
    snoutCommit: sh("git", ["rev-parse", "HEAD"], { cwd: REPO }).stdout.trim(),
    snoutDirty: sh("git", ["status", "--porcelain", "src", "dist"], { cwd: REPO }).stdout.trim() !== "",
    snoutDistSha256: createHash("sha256").update(readFileSync(SNOUT_BIN)).digest("hex"),
    claudeCode: sh("claude", ["--version"]).stdout.trim(),
  };
  if (resumed && resumed.frozen.snoutDistSha256 !== frozen.snoutDistSha256) throw new Error("--resume: dist/snout.mjs changed since this run started; the arms would not be the same Snout");
  const save = () => writeFileSync(outFile, JSON.stringify({ runId, model: MODEL, n: N, measuredAt: resumed?.measuredAt ?? new Date().toISOString(), ...(resumed ? { resumedAt: [...(resumed.resumedAt ?? []), new Date().toISOString()] } : {}), frozen, rows, ...(excluded.length ? { excluded } : {}) }, null, 2));
  console.error(`${plan.length} session(s): ${tasks.length} task(s) × ${ARMS.length} arm(s) × ${N}, model ${MODEL}, cap $${BUDGET}, ${JOBS} at a time → ${outFile}`);
  let next = 0, done = 0, halted = null;
  const worker = async () => {
    while (next < plan.length && !halted) {
      const [t, a, rep] = plan[next++];
      let row = await runOne(t, a, rep);
      if (row.infra && !row.dockerDown) row = { ...(await runOne(t, a, rep)), retried: true }; // protocol: one rerun
      if (row.dockerDown) halted = `Docker became unhealthy after ${t.instance_id} · ${a} · rep ${rep}; restart Docker Desktop, then --resume ${outFile}`;
      rows.push(row);
      save(); // after every session, so an interrupted run keeps what it measured
      done++;
      process.stderr.write(`[${done}/${plan.length}] ${t.instance_id} · ${a} · rep ${rep}: ${row.infra ? `INFRA ${row.infra}` : `${Math.round(row.inputTokens / 1000)}k in · ${row.turns} turns · $${row.costUsd.toFixed(3)}${row.withheld ? ` · ~${Math.round(row.withheld / 1000)}k kept out` : ""}${row.patch.trim() ? "" : " · NO PATCH"}${row.error ? ` · ${row.error}` : ""}`}\n`);
    }
  };
  // Pull every image first, so pulls don't count against session time.
  for (const t of tasks) ensureImage(t.image);
  preflight(tasks.map((t) => t.image));
  await Promise.all(Array.from({ length: JOBS }, worker));
  console.log(`\nSessions: ${outFile}`);
  if (halted) { console.error(halted); process.exit(2); }
  if (!args["no-grade"]) grade(outFile);
  summarize(JSON.parse(readFileSync(outFile, "utf8")));
}

export { sh, ensureImage, preflight, leftovers, removeContainers, dockerHealthy, grade, SWE_PY, DATASET, SNOUT_BIN, REPO };

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
