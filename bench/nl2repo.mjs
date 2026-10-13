#!/usr/bin/env node
/**
 * Build-from-spec A/B: NL2Repo-Bench (ICML 2026). Each task is a real Python library reduced to a
 * written spec (start.md) and an empty folder; a headless Claude Code builds the whole library in
 * ONE session, with and without Snout. The library's own pytest suite grades the result: the score
 * is passed tests / the task's test count, capped at 1, as the benchmark computes it.
 *
 * Data: a clone of github.com/multimodal-art-projection/NL2RepoBench (NL2REPO_DIR, or --data).
 * Grading images ghcr.io/multimodal-art-projection/nl2repobench/<task>:1.0 hold only the hidden
 * tests and the project's packaging (no source); the agent never sees them. Grading follows the
 * benchmark's post_processor: drop the agent's packaging files and its copies of the test paths,
 * lay the workspace over the image's /workspace, run the task's test commands, count "N passed".
 *
 * The agent works on a host folder. `python`, `python3`, `pip`, `pip3` and `pytest` run in its own
 * python:3.12.4 container (the grading images' Python) through swe.mjs's shims: files the agent
 * wrote are copied in before each command, and files a command writes are copied back after it.
 *
 * Arms: default (plain Claude Code) · snout-c<N>k (Snout enforcing, CLAUDE_CODE_AUTO_COMPACT_WINDOW=N*1000)
 *
 * Usage:
 *   node bench/nl2repo.mjs --list                                   # tasks by spec size
 *   node bench/nl2repo.mjs --tasks boltons,deepdiff --arms default --n 1 --model claude-sonnet-5-5 --api
 *   options: --jobs 3 · --budget 15 (per session) · --minutes 120 · --max-spend 60 · --keep · --no-grade · --reps 0,1
 *   node bench/nl2repo.mjs --grade bench/ab-results/nl2repo-<ts>.json
 *   node bench/nl2repo.mjs --summarize bench/ab-results/nl2repo-<ts>.json
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sh, ensureImage, writeShims, armSettings, startContainer, leftovers, removeContainers, dockerHealthy, REPO, SNOUT_BIN } from "./swe.mjs";
import { transcriptFacts } from "./swelong.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const DATA = typeof args.data === "string" ? args.data : process.env.NL2REPO_DIR;
const N = Number(args.n ?? 1);
const MODEL = typeof args.model === "string" ? args.model : "claude-sonnet-5-5";
const ARMS = (typeof args.arms === "string" ? args.arms : "default,snout-c300k").split(",");
const BUDGET = String(args.budget ?? "15");
const MINUTES = Number(args.minutes ?? 120);
const JOBS = Number(args.jobs ?? 3);
const AGENT_IMAGE = "python:3.12.4";
const GRADE_IMAGE = (task) => `ghcr.io/multimodal-art-projection/nl2repobench/${task}:1.0`;
const API_KEY = args.api ? (readFileSync(join(REPO, ".env.local"), "utf8").split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY=")) ?? "").slice("ANTHROPIC_API_KEY=".length).trim() : null;
if (args.api && !API_KEY) throw new Error("--api: no ANTHROPIC_API_KEY in .env.local");

/** The benchmark's own instruction, verbatim, plus one line on where commands run. */
const PROMPT = `According to the start.md in the workspace, implement the entire project as per the requirements specified in the document, ensuring that the final product can be directly run in the current directory. The running requirements should comply with the <API Usage Guide> section of the document. Please complete this task step by step.

\`python\`, \`pip\` and \`pytest\` run in this folder's Python 3.12 environment.`;

/** Files the benchmark deletes from the agent's work before grading, so the image's packaging is used. */
const PACKAGE_FILES = new Set(["setup.py", "pyproject.toml", "setup.cfg", "requirements.txt", "requirements-dev.txt", "requirements-test.txt", "tox.ini", "pytest.ini", "poetry.lock", "Pipfile", "Pipfile.lock", "environment.yml", "conda-env.yaml", "manifest.in", "MANIFEST.in"]);
/** Never copied back from the container or kept in the archive: build output and caches. */
const JUNK = ["__pycache__", ".pytest_cache", "*.egg-info", "build", "dist", ".eggs", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv"];

export function loadTasks(dir = DATA) {
  if (!dir || !existsSync(join(dir, "test_files"))) throw new Error("set NL2REPO_DIR (or --data) to a clone of NL2RepoBench");
  return readdirSync(join(dir, "test_files")).filter((t) => existsSync(join(dir, "test_files", t, "start.md"))).map((t) => {
    const f = (x) => join(dir, "test_files", t, x);
    return {
      task: t,
      spec: f("start.md"),
      specTokens: Math.round(readFileSync(f("start.md"), "utf8").length / 4),
      testCount: Number(readFileSync(f("test_case_count.txt"), "utf8").trim()),
      commands: JSON.parse(readFileSync(f("test_commands.json"), "utf8")),
      testPaths: JSON.parse(readFileSync(f("test_files.json"), "utf8")),
    };
  });
}

// Checksums before a command; afterwards the files that are new or differ are the ones it wrote
// (content, not times: the Docker VM's clock can drift from the host's).
const FILES = `find . ${JUNK.map((j) => `-name "${j}" -prune -o`).join(" ")} -name .git -prune -o -type f`;
const BEFORE = `docker exec "$c" sh -c 'cd /testbed && ${FILES} -print0 | xargs -0 -r md5sum > /tmp/.swe-sums'\n`;
const CHANGED = `docker exec "$c" sh -c 'cd /testbed && ${FILES} -size -5M -print0 | xargs -0 -r md5sum | grep -vxFf /tmp/.swe-sums | cut -c35-'`;
const TOOLS = [["python", "python"], ["python3", "python"], ["pytest", "pytest"], ["pip", "pip"], ["pip3", "pip"]];

/** An empty workspace with the spec, committed as the baseline, and the session's own container. */
function prepareWorkspace(t, arm, label) {
  const dir = mkdtempSync(join(tmpdir(), "snout-nl2repo-"));
  copyFileSync(t.spec, join(dir, "start.md"));
  const git = (...a) => sh("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", ...a], { cwd: dir });
  git("init", "-q");
  writeFileSync(join(dir, ".git/info/exclude"), ["/.bin/", "/.claude/", "/.snout/", "/.mcp.json", "/.swe-task", "/.swe-synced*", "*.pyc", ...JUNK.map((j) => `${j}/`)].join("\n") + "\n");
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", "baseline");
  startContainer(AGENT_IMAGE, dir, label);
  const name = readFileSync(join(dir, ".swe-task"), "utf8").trim();
  // pytest as in the grading images; anything else the agent installs itself, as in the benchmark.
  const setup = sh("docker", ["exec", name, "sh", "-c", "mkdir -p /testbed && pip install -q --root-user-action=ignore --disable-pip-version-check pytest==8.3.4"], { timeout: 300_000 });
  if (setup.status !== 0) throw new Error(`container setup: ${setup.stderr.slice(-300)}`);
  sh("docker", ["cp", t.spec, `${name}:/testbed/start.md`]);
  writeShims(dir, TOOLS, { activate: "", before: BEFORE, changed: CHANGED });
  armSettings(dir, arm.startsWith("snout") ? "enforce" : "off");
  return dir;
}

function runClaude(dir, arm) {
  const window = /(?:^|-)c(\d+)k$/.exec(arm);
  return new Promise((resolve) => {
    const argv = [
      "-p", PROMPT, "--output-format", "json", "--model", MODEL,
      "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", join(dir, ".mcp.json"),
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "Bash(python:*)", "Bash(python3:*)", "Bash(pytest:*)", "Bash(pip:*)", "Bash(pip3:*)", "Bash(mkdir:*)", "Bash(touch:*)", "Bash(cd:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(git diff:*)", "Bash(git status:*)",
      "--max-budget-usd", BUDGET,
    ];
    // The advisor tool stays off in every arm, as in swelong.mjs.
    const env = { ...process.env, SNOUT_MODE: "", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", PATH: `${join(dir, ".bin")}:${process.env.PATH}`, ...(API_KEY ? { ANTHROPIC_API_KEY: API_KEY } : {}) };
    if (window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Number(window[1]) * 1000);
    else delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const child = spawn("claude", argv, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, MINUTES * 60_000);
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
  });
}

/** The agent's files (everything but the harness's own and build output), as a .tgz for grading. */
function archive(dir, out) {
  const list = sh("sh", ["-c", "{ git ls-files; git ls-files --others --exclude-standard; } | sort -u"], { cwd: dir }).stdout.trim();
  writeFileSync(join(dir, ".archive-list"), list + "\n");
  const r = sh("tar", ["--no-mac-metadata", "-czf", out, "-T", ".archive-list"], { cwd: dir, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (r.status !== 0) throw new Error(`archive: ${r.stderr.slice(-300)}`);
  return list ? list.split("\n").length : 0;
}

async function runSession(t, arm, rep, outDir) {
  const started = Date.now();
  const label = `nl2repo-${t.task}-${arm}-${rep}-${started}`;
  const row = { task: t.task, arm, rep, specTokens: t.specTokens, testCount: t.testCount };
  let dir;
  try {
    dir = prepareWorkspace(t, arm, label);
    const r = await runClaude(dir, arm);
    let out = {};
    try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
    Object.assign(row, { session: out.session_id, turns: out.num_turns ?? 0, cliCostUsd: out.total_cost_usd ?? 0, stop: out.subtype, ...(out.is_error ? { error: String(out.result ?? out.subtype ?? "error").slice(0, 200) } : {}), ...(r.timedOut ? { timedOut: true } : {}) });
    row.archive = join(outDir, `${t.task}.${arm}.${rep}.tgz`);
    row.files = archive(dir, row.archive);
    if (row.session) Object.assign(row, transcriptFacts(row.session) ?? {});
    if (!row.session) row.infra = `no session id (${row.error ?? "?"})`;
  } catch (e) {
    row.infra = String(e.message).slice(0, 300);
  } finally {
    removeContainers(leftovers(`snout-swe=${label}`));
    if (dir && !args.keep) rmSync(dir, { recursive: true, force: true }); else if (dir) row.dir = dir;
  }
  row.seconds = Math.round((Date.now() - started) / 1000);
  return row;
}

/**
 * The benchmark's grading for one archive: the agent's packaging files and its copies of the test
 * paths are dropped, the rest laid over the image's /workspace, and the task's commands run in order.
 * passed = the sum of "N passed" over the pytest commands' output, as post_processor.py counts it.
 */
export function gradeArchive(t, tgz) {
  const work = mkdtempSync(join(tmpdir(), "snout-nl2repo-grade-"));
  const name = `snout-nl2repo-grade-${work.split("-").pop()}`;
  try {
    sh("tar", ["-xzf", tgz, "-C", work]);
    sh("find", [work, "-type", "f", "(", ...[...PACKAGE_FILES].flatMap((f, i) => (i ? ["-o", "-name", f] : ["-name", f])), ")", "-delete"]);
    for (const p of t.testPaths) rmSync(join(work, p), { recursive: true, force: true });
    ensureImage(GRADE_IMAGE(t.task));
    const pyPath = sh("docker", ["image", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", GRADE_IMAGE(t.task)]).stdout.split("\n").find((l) => l.startsWith("PYTHONPATH="))?.slice(11) ?? "";
    const run = sh("docker", ["run", "-d", "--name", name, "--label", "snout-nl2repo=grade", "-w", "/workspace", "-e", `PYTHONPATH=/workspace:${pyPath}`, "--entrypoint", "sleep", GRADE_IMAGE(t.task), "infinity"], { timeout: 120_000 });
    if (run.status !== 0) throw new Error(`grade container: ${run.stderr.slice(-300)}`);
    const copy = sh("sh", ["-c", `COPYFILE_DISABLE=1 tar --no-mac-metadata -cf - -C "${work}" . | docker exec -i ${name} tar -xf - -C /workspace --warning=no-unknown-keyword`], { timeout: 300_000 });
    if (copy.status !== 0) throw new Error(`copy into grade container: ${copy.stderr.slice(-300)}`);
    let passed = 0, failed = 0, errors = 0;
    const log = [];
    for (const cmd of t.commands) {
      const r = sh("docker", ["exec", "-w", "/workspace", name, "sh", "-c", cmd], { timeout: 30 * 60_000 });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      log.push({ cmd, status: r.status, tail: output.slice(-600) });
      if (!/pytest/i.test(cmd)) continue;
      for (const line of output.split("\n")) {
        passed += Number(/(\d+) passed/.exec(line)?.[1] ?? 0);
        failed += Number(/(\d+) failed/.exec(line)?.[1] ?? 0);
        errors += Number(/(\d+) error/.exec(line)?.[1] ?? 0);
      }
    }
    return { passed, failed, errors, score: t.testCount > 0 ? Math.min(passed / t.testCount, 1) : 0, log };
  } finally {
    sh("docker", ["rm", "-f", name], { timeout: 120_000 });
    rmSync(work, { recursive: true, force: true });
  }
}

/** Grades every session not graded yet, one at a time (parallel grading has wedged Docker before). */
function gradeFile(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const tasks = new Map(loadTasks().map((t) => [t.task, t]));
  for (const r of saved.rows) {
    if (r.score !== undefined || !r.archive || !existsSync(r.archive)) continue;
    process.stderr.write(`grading ${r.task} · ${r.arm} · rep ${r.rep} … `);
    try { Object.assign(r, gradeArchive(tasks.get(r.task), r.archive)); } catch (e) { r.gradeError = String(e.message).slice(0, 300); }
    process.stderr.write(r.gradeError ? `ERROR ${r.gradeError}\n` : `${r.passed}/${r.testCount} (${(100 * r.score).toFixed(1)}%)\n`);
    writeFileSync(file, JSON.stringify(saved, null, 2));
  }
  saved.graded = new Date().toISOString();
  writeFileSync(file, JSON.stringify(saved, null, 2));
}

function summarize(saved) {
  console.log(`\nNL2Repo build-from-spec A/B, ${saved.model}, Claude Code ${saved.claudeCode}, Snout ${saved.snout?.sha256?.slice(0, 12)}\n`);
  const k = (x) => (x == null ? "    –" : `${Math.round(x / 1000)}k`.padStart(5));
  console.log("  task                 arm            rep   score     cost   calls   peak  compactions   min   stop");
  for (const r of saved.rows) console.log(`  ${r.task.padEnd(20)} ${r.arm.padEnd(14)} ${String(r.rep).padStart(3)}  ${r.score == null ? "   –  " : `${(100 * r.score).toFixed(1).padStart(5)}%`}  $${(r.costUsd ?? 0).toFixed(2).padStart(6)}  ${String(r.calls ?? "–").padStart(6)}  ${k(r.peak)}  ${String(r.compactions ?? "–").padStart(11)}  ${String(Math.round((r.seconds ?? 0) / 60)).padStart(4)}   ${r.infra ? `INFRA ${r.infra}` : r.timedOut ? "time limit" : r.stop ?? ""}`);
  for (const a of saved.arms) {
    const rs = saved.rows.filter((r) => r.arm === a && !r.infra);
    const graded = rs.filter((r) => r.score != null);
    const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    console.log(`\n  ${a}: ${rs.length} session(s), $${cost.toFixed(2)} total, $${(cost / Math.max(rs.length, 1)).toFixed(2)} per build${graded.length ? `, mean score ${(100 * graded.reduce((s, r) => s + r.score, 0) / graded.length).toFixed(1)}%` : ""}, peak ${k(Math.max(0, ...rs.map((r) => r.peak ?? 0)))}`);
  }
}

async function main() {
  if (args.list) {
    for (const t of loadTasks().sort((a, b) => b.specTokens - a.specTokens)) console.log(`${String(t.specTokens).padStart(7)} spec tokens  ${String(t.testCount).padStart(5)} tests  ${t.task}`);
    return;
  }
  if (typeof args.summarize === "string") return summarize(JSON.parse(readFileSync(args.summarize, "utf8")));
  if (typeof args.grade === "string") { gradeFile(args.grade); return summarize(JSON.parse(readFileSync(args.grade, "utf8"))); }
  if (typeof args.tasks !== "string") throw new Error("--tasks a,b,c (see --list)");
  const all = new Map(loadTasks().map((t) => [t.task, t]));
  const tasks = args.tasks.split(",").map((n) => all.get(n) ?? (() => { throw new Error(`unknown task ${n}`); })());
  const reps = typeof args.reps === "string" ? args.reps.split(",").map(Number) : [...Array(N).keys()];
  const plan = [];
  for (const rep of reps) for (const t of tasks) for (const a of ARMS) plan.push([t, a, rep]);
  ensureImage(AGENT_IMAGE);
  for (const t of tasks) ensureImage(GRADE_IMAGE(t.task)); // pulled before any session, so pulls don't count against one
  if (!dockerHealthy(AGENT_IMAGE)) throw new Error("a test container did not run within 60 s: restart Docker Desktop");
  const runId = `nl2repo-${Date.now()}`;
  const outFile = join(REPO, "bench/ab-results", `${runId}.json`);
  const outDir = join(REPO, "bench/ab-results", runId);
  mkdirSync(outDir, { recursive: true });
  const snout = { bin: SNOUT_BIN, sha256: createHash("sha256").update(readFileSync(SNOUT_BIN)).digest("hex") };
  const rows = [];
  const save = () => writeFileSync(outFile, JSON.stringify({ runId, benchmark: "NL2Repo-Bench", model: MODEL, arms: ARMS, budgetUsd: Number(BUDGET), minutes: MINUTES, measuredAt: new Date(Number(runId.split("-")[1])).toISOString(), claudeCode: sh("claude", ["--version"]).stdout.trim(), snout, rows }, null, 2));
  console.error(`${plan.length} build session(s): ${tasks.map((t) => t.task).join(", ")} × ${ARMS.join(", ")} × reps ${reps.join(",")}, ${JOBS} at a time, model ${MODEL} → ${outFile}`);
  let next = 0, stop = false;
  const worker = async () => {
    while (!stop && next < plan.length) {
      const [t, a, rep] = plan[next++];
      const row = await runSession(t, a, rep, outDir);
      rows.push(row); save();
      process.stderr.write(`[${rows.length}/${plan.length}] ${t.task} · ${a} · rep ${rep}: ${row.infra ? `INFRA ${row.infra}` : `${row.calls ?? "–"} calls · peak ${Math.round((row.peak ?? 0) / 1000)}k · ${row.compactions ?? "–"} compaction(s) · $${(row.costUsd ?? 0).toFixed(2)} · ${row.files} files · ${Math.round(row.seconds / 60)} min${row.timedOut ? " · TIME LIMIT" : ""}`}\n`);
      const spent = rows.reduce((x, r) => x + (r.costUsd ?? 0), 0);
      if (args["max-spend"] && spent >= Number(args["max-spend"])) { stop = true; console.error(`spent $${spent.toFixed(2)} ≥ --max-spend $${args["max-spend"]}; no new sessions`); }
      if (!dockerHealthy(AGENT_IMAGE)) { stop = true; console.error("Docker unhealthy; no new sessions"); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, plan.length) }, worker));
  console.log(`\nSessions: ${outFile}`);
  if (!args["no-grade"]) gradeFile(outFile);
  summarize(JSON.parse(readFileSync(outFile, "utf8")));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(1); });
