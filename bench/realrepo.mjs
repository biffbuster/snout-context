#!/usr/bin/env node
/**
 * Real-repo A/B: issues from a popular outside Go repository, run by a real headless Claude Code
 * with Snout observing (off) and enforcing, graded by the fix PR's own tests. Tasks are drawn by a
 * rule written down before any run (docs/benchmark-protocol.md, "Real-repo study"), and every
 * drawn task is reported.
 *
 * Each session gets the repository at the PR's base commit with no git history (the fix is not in
 * `git log`), and reads the issue through GitHub's MCP server, read-only and limited to the issues
 * tools, so it cannot open the fix PR or write anything upstream. After the session the PR's test
 * files replace the workspace's copies and the packages they touch run with `go test -json`: a
 * task is resolved when every fail-to-pass test passes and no pass-to-pass test fails.
 *
 * Usage:
 *   SWE_FAKE_AGENT=1 node bench/realrepo.mjs --n 1 --tasks hugo-15452         # free dry run (gold patch)
 *   node bench/realrepo.mjs --n 3 --model claude-sonnet-5-5 --api --budget 3.00 --max-spend 90 --jobs 1
 *   node bench/realrepo.mjs --summarize bench/ab-results/realrepo-<ts>.json
 *   SWE_FAKE_AGENT=1 node bench/realrepo.mjs --chain --n 1 --allow-dirty    # free long-session dry run
 *   node bench/realrepo.mjs --chain --n 3 --model claude-sonnet-5-5 --api --budget 3.00 --max-spend 100   # one session per arm per rep, all tasks
 *   node bench/realrepo.mjs --resume bench/ab-results/realrepo-<ts>.json --n 3 --model <same>
 *   SWE_FAKE_AGENT=1 node bench/realrepo.mjs --chain --n 1 --arms plain,plain-fresh,snout-fresh --tasks hugo-15234,hugo-15253,hugo-15330
 *   node bench/realrepo.mjs --chain --n 3 --arms plain,plain-fresh,snout-fresh --model claude-sonnet-5-5 --plan --budget 3.00 --max-spend 100
 *   node bench/realrepo.mjs --chain --n 1 --arms plain-fresh,snout-fresh --map off --model claude-sonnet-5-5 --api --budget 2.00 --max-spend 1.00
 *     the product test: one long session without Snout, a new session per issue without Snout, and a
 *     new session per issue with Snout as installed (notes carried between sessions). --plan runs on
 *     the operator's Claude subscription (`claude setup-token`) instead of an API key.
 *   node bench/realrepo.mjs --chain --codex-setup --tasks hugo-15234,hugo-15253
 *   SWE_FAKE_AGENT=1 node bench/realrepo.mjs --chain --n 1 --arms plain-fresh,snout-fresh --agents claude,codex --tasks hugo-15234,hugo-15253 --allow-dirty
 *   node bench/realrepo.mjs --chain --n 1 --arms plain-fresh,snout-fresh --agents claude,codex --model claude-sonnet-5-5 --api --budget 2.00 --tasks hugo-15234,hugo-15253
 *     handoff between agents: issues alternate Claude Code and Codex, and only Snout's notes carry
 *     from one to the next. Codex runs in one fixed folder that --codex-setup builds once for the
 *     operator to trust (Codex runs project hooks only there); its tokens bill the ChatGPT plan.
 *   env: REALREPO_TASKS (default bench/realrepo-hugo-tasks.json), GITHUB_MCP_TOKEN (default `gh auth token`), CODEX_CLI_JS (Windows)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { armSettings, launchClaude, workBase, frozenBuild, REPO, SNOUT_BIN, FAKE, CLEAN_HOME, API_REFUSED } from "./swe.mjs";
import { shippedClaudeHooks } from "./shipped-hooks.mjs";
import { bootstrap } from "./long.mjs";
import { costLines, ledgerFacts, peakContext, reliabilityLines } from "./stats.mjs";
import { transcriptFacts } from "./swelong.mjs";
import { stamp } from "./stamp.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const N = Number(args.n ?? 1);
const MODEL = typeof args.model === "string" ? args.model : "haiku";
const ARMS = (typeof args.arms === "string" ? args.arms : "off,enforce").split(",");
const BUDGET = String(args.budget ?? "3.00");
const MAX_SPEND = args["max-spend"] ? Number(args["max-spend"]) : 0;
// --map off: the snout arm without the repo map, so a run measures notes and trimming alone.
const REPO_MAP = args.map !== "off";
const JOBS = Number(args.jobs ?? 1);
// --agents claude,codex: the agent for each issue of a chain in turn (issue 1 Claude Code, issue 2
// Codex, ...), so notes written by one reach the other. Fresh arms only: no session crosses agents.
const AGENTS = (typeof args.agents === "string" ? args.agents : "claude").split(",");
const USES_CODEX = AGENTS.includes("codex");
const CODEX_MODEL = typeof args["codex-model"] === "string" ? args["codex-model"] : null;
const TASKS_FILE = process.env.REALREPO_TASKS || join(REPO, "bench/realrepo-hugo-tasks.json");
const SESSION_LIMIT_MS = 30 * 60_000;
// GitHub's MCP server, read-only, issues tools only: the agent reads the issue and its comments,
// and can neither open the fix PR nor change anything on GitHub.
const MCP_URL = "https://api.githubcopilot.com/mcp/x/issues/readonly";
const TEST_FILE = (f) => f.endsWith("_test.go") || f.includes("/testdata/");

const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 512 << 20, ...opts });

/** The PR's diff split by file: the test part (graded with) and the source part (the gold fix). */
export function splitPatch(full) {
  const blocks = full.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  const file = (b) => /^diff --git a\/\S+ b\/(\S+)$/m.exec(b)?.[1] ?? "";
  return {
    test: blocks.filter((b) => TEST_FILE(file(b))).join(""),
    source: blocks.filter((b) => !TEST_FILE(file(b))).join(""),
    testFiles: blocks.map(file).filter(TEST_FILE),
  };
}

function githubToken() {
  if (process.env.GITHUB_MCP_TOKEN) return process.env.GITHUB_MCP_TOKEN;
  const r = sh("gh", ["auth", "token"]);
  if (r.status !== 0 || !r.stdout.trim()) throw new Error("no GitHub token: set GITHUB_MCP_TOKEN or sign in with gh");
  return r.stdout.trim();
}

/** The repository at `base` in `dir`, no history, committed as "baseline" so the saved diff is the agent's alone. */
function checkout(spec, task, dir) {
  mkdirSync(dir, { recursive: true });
  // The clone path is stored relative to this repo (or given with --clone) so the task file names no user folder.
  const clone = resolve(REPO, typeof args.clone === "string" ? args.clone : spec.clone);
  const tar = sh("git", ["-C", clone, "archive", "--format=tar", task.base], { encoding: "buffer" });
  if (tar.status !== 0) throw new Error(`git archive ${task.base}: ${tar.stderr}`);
  // No path argument: the tar on a Windows PATH may be Git Bash's, which misreads C:\ paths.
  const x = sh("tar", ["-xf", "-"], { cwd: dir, input: tar.stdout, encoding: "buffer" });
  if (x.status !== 0) throw new Error(`extract: ${x.stderr}`);
  const git = (...a) => sh("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", ...a], { cwd: dir });
  git("init", "-q");
  for (const [k, v] of [["core.autocrlf", "false"], ["core.filemode", "false"]]) git("config", k, v);
  appendFileSync(join(dir, ".git/info/exclude"), "\n/.claude/\n/.codex/\n/.snout/\n/.mcp.json\n/.gocache/\n");
  git("add", "-A");
  const c = git("commit", "-q", "--no-verify", "-m", "baseline");
  if (c.status !== 0) throw new Error(`baseline commit: ${c.stderr}`);
  // The repository's own address, as any clone has: Snout keys a project's notes by it, so every
  // issue's checkout is one project, the way one repository is over time. Nothing fetches from it.
  git("remote", "add", "origin", `https://github.com/${spec.repo}.git`);
}

const { gateEntries, initAgent, squeezeEntries } = await import(pathToFileURL(join(REPO, "dist/lib.mjs")).href);

/**
 * An arm is how Snout is set up, plus "-fresh" in --chain for a new session per issue:
 *   plain   no Snout at all
 *   off     Snout in observe: records, changes nothing
 *   enforce trimming and the read gate only (no memory)
 *   snout   the product as a user installs it, plus the repo map (--map off leaves it out): the plugin's own hooks (notes written at the end of
 *           each session, brought into the next one, recall on prompts), enforce mode, memory on
 */
const snoutOf = (arm) => arm.replace(/-fresh$/, "");
const isFresh = (arm) => arm.endsWith("-fresh");

/** Hooks and Snout config for the arm, and the GitHub MCP server every arm reads issues through. */
function settings(dir, arm) {
  if (snoutOf(arm) === "snout") {
    const hooks = shippedClaudeHooks(REPO, SNOUT_BIN);
    hooks.PreToolUse = gateEntries(SNOUT_BIN);
    hooks.PostToolUse = [...(hooks.PostToolUse ?? []), ...squeezeEntries(SNOUT_BIN)];
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2));
    mkdirSync(join(dir, ".snout"), { recursive: true });
    // The repo map on: with the issue read through MCP, Snout shows the files it ranks for the issue.
    writeFileSync(join(dir, ".snout/config.json"), JSON.stringify({ mode: "enforce", memory: true, memoryNotes: true, repoMap: REPO_MAP }) + "\n");
  } else armSettings(dir, snoutOf(arm));
  // Snout's MCP hook matcher (mcp__.*) sees the issue in enforce; observe only records it.
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { github: { type: "http", url: MCP_URL, headers: { Authorization: "Bearer ${GITHUB_MCP_TOKEN}" } } } }, null, 2));
}

function makeWorkspace(spec, task, arm) {
  const dir = mkdtempSync(join(workBase(), "snout-real-"));
  checkout(spec, task, dir);
  settings(dir, arm);
  return dir;
}

const prompt = (spec, task) => `Fix GitHub issue #${task.issue} in ${spec.repo}. The repository in the current directory is ${spec.name} at the commit just before the fix.

Read the issue and its comments with the GitHub tools, find the cause, and fix it by editing the source code. Go is installed: run the relevant tests with \`go test\`. Do not modify the existing tests.`;

function runClaude(dir, text, goldPatch, token) {
  const argv = [
    "-p", text,
    "--output-format", "json",
    "--model", MODEL,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--mcp-config", join(dir, ".mcp.json"),
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "mcp__github", "Bash(go:*)", "Bash(gofmt:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)",
    "--max-budget-usd", BUDGET,
  ];
  return launchClaude(dir, argv, { goldPatch, limitMs: SESSION_LIMIT_MS, env: { GITHUB_MCP_TOKEN: token, GOTOOLCHAIN: "local" } });
}

/** go test -json over `pkgs`: each test's last action (pass, fail, skip), and whether it built. */
function goTest(dir, pkgs) {
  const r = sh("go", ["test", "-count=1", "-json", ...pkgs], { cwd: dir, timeout: 1_200_000, env: { ...process.env, GOTOOLCHAIN: "local" } });
  const res = {};
  for (const l of (r.stdout || "").split("\n")) {
    try { const e = JSON.parse(l); if (e.Test && ["pass", "fail", "skip"].includes(e.Action)) res[`${e.Package}.${e.Test}`] = e.Action; } catch { /* not a test event */ }
  }
  return { res, built: !/\[build failed\]|\[setup failed\]/.test(r.stdout || "") };
}

/** The PR's test files over the agent's work (its own edits to them dropped), then the touched packages. */
export function grade(dir, task, testPatch) {
  const git = (...a) => sh("git", a, { cwd: dir });
  for (const f of task.testFiles) {
    if (git("cat-file", "-e", `HEAD:${f}`).status === 0) git("checkout", "HEAD", "--", f);
    else rmSync(join(dir, f), { force: true });
  }
  writeFileSync(join(dir, ".grade.patch"), testPatch);
  const a = git("apply", ".grade.patch");
  rmSync(join(dir, ".grade.patch"), { force: true });
  if (a.status !== 0) return { resolved: false, gradeError: `test patch did not apply: ${a.stderr.slice(0, 200)}` };
  const { res, built } = goTest(dir, task.pkgs);
  const f2pFailed = task.f2p.filter((t) => res[t] !== "pass");
  const p2pFailed = task.p2p.filter((t) => res[t] === "fail");
  return { resolved: built && !f2pFailed.length && !p2pFailed.length, built, f2pFailed, p2pFailed };
}

async function runOne(spec, task, arm, rep, token) {
  const started = Date.now();
  let dir;
  try { dir = makeWorkspace(spec, task, arm); } catch (e) { return { task: task.id, arm, rep, infra: String(e.message).slice(0, 300) }; }
  const patches = splitPatch(readFileSync(join(REPO, task.patch), "utf8"));
  const gold = `${dir}.gold.patch`;
  if (FAKE) writeFileSync(gold, patches.source);
  const r = await runClaude(dir, prompt(spec, task), gold, token);
  if (FAKE) rmSync(gold, { force: true });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
  const u = out.usage ?? {};
  const facts = ledgerFacts(join(dir, ".snout/ledger.jsonl"));
  const peak = peakContext(out.session_id, CLEAN_HOME ? join(CLEAN_HOME, "projects") : undefined);
  sh("git", ["add", "-A"], { cwd: dir });
  const patch = sh("git", ["diff", "--cached", "HEAD"], { cwd: dir }).stdout;
  const row = {
    task: task.id, arm, rep,
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
    patch,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  if (r.timedOut) row.infra = `session hit the ${SESSION_LIMIT_MS / 60_000}-minute limit`;
  else if (arm !== "plain" && !row.error && facts.rows === 0) { row.infra = "Snout recorded nothing: its hooks did not run"; row.snoutMissing = true; }
  if (!row.infra) Object.assign(row, patch.trim() ? grade(dir, task, patches.test) : { resolved: false });
  if (!args.keep) rmSync(dir, { recursive: true, force: true });
  else row.dir = dir;
  return row;
}

// ------------------------------------------------------------------ long sessions (--chain)

/**
 * --chain: every task worked one after another in ONE session, oldest issue first, each in its own
 * folder (taskN/, at that issue's base commit), so context grows and compacts the way a long working
 * session does. Claude Code's own auto-compact point in every arm. Cost is priced per call from the
 * transcript (bench/swelong.mjs), so each issue's share is known; each folder is graded on its own.
 */
const chainIntro = (spec, n) => `You'll work through ${n} GitHub issues in ${spec.repo} in this session, one at a time. Each issue has its own folder here (task1/, task2/, ...): ${spec.name} at the commit just before that issue's fix. The next issue comes after you finish the current one.

Read each issue and its comments with the GitHub tools. Go is installed: run tests with \`go test\` from the issue's folder. Do not modify the existing tests.`;

const chainPrompt = (spec, t, i, n) => `${i === 0 ? chainIntro(spec, n) + "\n\n" : ""}Issue ${i + 1} of ${n}: fix GitHub issue #${t.issue} in the folder \`task${i + 1}/\`, by editing its source code.`;

/**
 * A "-fresh" arm starts a new session for every issue, the way Snout suggests working: one task, one
 * session. Each session gets the same setup text, since it remembers nothing; what carries over is
 * only what Snout wrote down (in the "snout" arm). "Issue N of M" stays, so costs are tagged alike.
 */
const freshPrompt = (spec, t, i, n) => `The repository in the current directory is ${spec.name} (${spec.repo}) at the commit just before the fix for the issue below.

Read the issue and its comments with the GitHub tools, find the cause, and fix it by editing the source code. Go is installed: run the relevant tests with \`go test\`. Do not modify the existing tests.

Issue ${i + 1} of ${n}: fix GitHub issue #${t.issue}.`;

/** The memory block Snout put in front of each new session (.snout/recall.jsonl "inject" rows). */
function injections(dir) {
  try {
    return readFileSync(join(dir, ".snout/recall.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "inject");
  } catch {
    return [];
  }
}

function runChainStep(dir, text, resume, goldPatch, token, snoutConfig, cwd = dir) {
  const argv = [
    "-p", text,
    "--output-format", "json",
    "--model", MODEL,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--mcp-config", join(dir, ".mcp.json"),
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "mcp__github", "Bash(cd:*)", "Bash(go:*)", "Bash(gofmt:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)",
    "--max-budget-usd", BUDGET,
    ...(resume ? ["--resume", resume] : []),
  ];
  // As in swelong.mjs: the advisor tool off in every arm, and Claude Code's own auto-compact window
  // (an empty value overrides any the operator's environment sets).
  // Snout's own config folder (private notes, the memory model) is the run's own, so no notes reach a
  // session from another run, another arm or the operator. CI and SNOUT_TOKEN would make Snout treat
  // the session as unattended, which gets shared notes only.
  // A fresh session works inside its issue's checkout; Snout's records for the run stay in one
  // folder (SNOUT_DIR), so its notes, session cards and repo map carry from issue to issue.
  const env = { GITHUB_MCP_TOKEN: token, GOTOOLCHAIN: "local", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", SNOUT_CONFIG_DIR: snoutConfig, CI: "", SNOUT_TOKEN: "", ...(cwd !== dir ? { SNOUT_DIR: join(dir, ".snout") } : {}) };
  return launchClaude(cwd, argv, { goldPatch, limitMs: SESSION_LIMIT_MS, env });
}

/** Claude Code's JSON result, or an error shaped like one. */
function claudeResult(r) {
  try { return JSON.parse(r.stdout); } catch { return { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
}

/**
 * Codex chains run in one fixed folder: Codex runs a project's hooks only in a folder the operator
 * has trusted and whose hooks they approved (/hooks), and a new temp folder each run would need that
 * again. --codex-setup prepares the folder once; every run then rebuilds it at the same path with the
 * same hooks. Nothing here bypasses trust or approval.
 */
const codexChainDir = () => join(workBase(), "codex-chain");

/**
 * One Codex session (`codex exec --json`) on an issue, or the stand-in with SWE_FAKE_AGENT=1. The
 * same issue tools as Claude Code (GitHub's read-only issues server, and only it), the workspace-write
 * sandbox, Go's build cache inside the checkout so tests can build there. The result is shaped like
 * Claude Code's; Codex bills the ChatGPT plan, so its cost is tokens, not dollars.
 */
function runCodexStep(cwd, text, goldPatch, token, snoutConfig, chainDir) {
  const argv = ["exec", "--json", "-s", "workspace-write", "-C", cwd,
    "-c", `mcp_servers={github={url="${MCP_URL}",bearer_token_env_var="GITHUB_MCP_TOKEN"}}`,
    ...(CODEX_MODEL ? ["-m", CODEX_MODEL] : []), text];
  // npm's Windows `codex` shim is a .cmd wrapper spawn cannot run; CODEX_CLI_JS is the CLI's own entry point (as in bench/ab.mjs).
  const cli = process.env.CODEX_CLI_JS;
  if (!FAKE && process.platform === "win32" && !cli) throw new Error("set CODEX_CLI_JS to the Codex CLI's JavaScript entry point (npm's codex.cmd can't be spawned)");
  const [bin, a] = FAKE ? [process.execPath, [join(REPO, "bench/fake-codex.mjs"), ...argv]] : cli ? [process.execPath, [cli, ...argv]] : ["codex", argv];
  const env = { ...process.env, GITHUB_MCP_TOKEN: token, GOTOOLCHAIN: "local", GOCACHE: join(cwd, ".gocache"), SNOUT_CONFIG_DIR: snoutConfig, SNOUT_DIR: join(chainDir, ".snout"), SNOUT_MODE: "", CI: "", SNOUT_TOKEN: "", ...(FAKE && goldPatch ? { SWE_FAKE_PATCH: goldPatch } : {}) };
  return new Promise((done) => {
    const child = spawn(bin, a, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, SESSION_LIMIT_MS);
    child.on("close", () => {
      clearTimeout(timer);
      if (FAKE) process.stderr.write(stderr);
      let thread = null, turns = 0, input = 0, cached = 0, output = 0, error, final = "";
      for (const line of stdout.split("\n")) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "thread.started") thread = e.thread_id;
        else if (e.type === "turn.completed" && e.usage) { turns++; input += e.usage.input_tokens ?? 0; cached += e.usage.cached_input_tokens ?? 0; output += e.usage.output_tokens ?? 0; }
        else if (e.type === "item.completed" && e.item?.type === "agent_message") final = e.item.text ?? final;
        else if (e.type === "error" || e.type === "turn.failed") error = String(e.message ?? e.error?.message ?? e.type);
      }
      if (!input && !error) error = (stderr || "no output").slice(0, 200);
      done({ timedOut, out: { session_id: thread, num_turns: turns, total_cost_usd: 0, is_error: !!error && !input, result: error ?? final, usage: { input_tokens: input - cached, cache_read_input_tokens: cached, output_tokens: output } } });
    });
  });
}

/** Rows Snout's hooks wrote for one session (.snout/hooks.jsonl heartbeats): none means the agent skipped them. */
function hookRows(chainDir, session) {
  try {
    return readFileSync(join(chainDir, ".snout/hooks.jsonl"), "utf8").split("\n").filter((l) => l.includes(`"session":"${session}"`)).length;
  } catch {
    return 0;
  }
}

/** --codex-setup: build the fixed Codex folder with Snout's hooks, once, for the operator to trust. */
function codexSetup(spec, tasks) {
  const dir = codexChainDir();
  rmSync(dir, { recursive: true, force: true });
  tasks.forEach((t, i) => checkout(spec, t, join(dir, `task${i + 1}`)));
  settings(dir, "snout-fresh");
  tasks.forEach((_, i) => initAgent("codex", join(dir, `task${i + 1}`), `node "${SNOUT_BIN}"`));
  console.log([
    `Codex folders ready under ${dir}. Once, for each of them:`,
    ...tasks.map((_, i) => `  ${join(dir, `task${i + 1}`)}`),
    "open Codex in the folder, trust it, and approve Snout's hooks with /hooks. Later runs rebuild the",
    "folders at the same paths with the same hooks, so this is needed only once.",
  ].join("\n"));
}

async function runChain(spec, tasks, arm, rep, token, spentBefore) {
  const started = Date.now();
  const dir = USES_CODEX ? codexChainDir() : mkdtempSync(join(workBase(), "snout-chain-"));
  if (USES_CODEX) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  const snoutConfig = mkdtempSync(join(workBase(), "snout-cfg-"));
  const fresh = isFresh(arm);
  const row = { mode: "chain", arm, rep, fresh, issues: [], steps: [] };
  try {
    tasks.forEach((t, i) => checkout(spec, t, join(dir, `task${i + 1}`)));
    settings(dir, arm);
    // Codex reads its hooks from each issue's folder: the same ones --codex-setup put there, for every arm with Snout.
    if (USES_CODEX && snoutOf(arm) !== "plain") tasks.forEach((_, i) => initAgent("codex", join(dir, `task${i + 1}`), `node "${SNOUT_BIN}"`));
    // Claude Code reads hooks from the folder it starts in: each issue's checkout gets the same ones.
    if (fresh) tasks.forEach((_, i) => {
      const d = join(dir, `task${i + 1}`);
      mkdirSync(join(d, ".claude"), { recursive: true });
      writeFileSync(join(d, ".claude/settings.json"), readFileSync(join(dir, ".claude/settings.json")));
      writeFileSync(join(d, ".mcp.json"), readFileSync(join(dir, ".mcp.json")));
    });
    let session = null;
    const sessions = [];
    for (let i = 0; i < tasks.length; i++) {
      // The stand-in works in the folder named in .current and applies the gold fix from outside it.
      writeFileSync(join(dir, ".current"), join(realpathSync(dir), `task${i + 1}`));
      const gold = FAKE ? `${dir}.gold.patch` : undefined;
      if (gold) writeFileSync(gold, splitPatch(readFileSync(join(REPO, tasks[i].patch), "utf8")).source);
      const injectedBefore = injections(dir).length;
      const text = fresh ? freshPrompt(spec, tasks[i], i, tasks.length) : chainPrompt(spec, tasks[i], i, tasks.length);
      const agent = AGENTS[i % AGENTS.length];
      let r, out;
      if (agent === "codex") ({ out, ...r } = await runCodexStep(join(dir, `task${i + 1}`), text, gold, token, snoutConfig, dir));
      else { r = await runChainStep(dir, text, fresh ? null : session, gold, token, snoutConfig, fresh ? join(dir, `task${i + 1}`) : dir); out = claudeResult(r); }
      if (gold) rmSync(gold, { force: true });
      session = out.session_id ?? (fresh ? null : session);
      if (out.session_id) sessions.push(out.session_id);
      // What Snout put in front of this session: notes from the issues before it (fresh "snout" arm).
      const inj = injections(dir).slice(injectedBefore).at(-1);
      const u = out.usage ?? {};
      row.steps.push({
        task: tasks[i].id, agent, session: out.session_id, cliUsd: out.total_cost_usd ?? 0, turns: out.num_turns ?? 0,
        tokens: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
        notesIn: inj ? (inj.items ?? []).length : 0, notesTokens: inj?.injected ? inj.tokensEst ?? 0 : 0,
        error: out.is_error ? String(out.result ?? out.subtype ?? "error").slice(0, 200) : undefined, timedOut: r.timedOut || undefined,
      });
      // A Codex session in an untrusted folder, or with hooks not approved, runs without Snout and says nothing.
      if (agent === "codex" && snoutOf(arm) !== "plain" && out.session_id && !hookRows(dir, out.session_id)) {
        row.infra = `issue ${i + 1}: Codex ran without Snout's hooks; run --codex-setup and trust the folders`;
        row.snoutMissing = true;
        break;
      }
      // One hard issue does not end the chain: it counts as attempted and the session moves on.
      if (r.timedOut) {
        row.hung = [...(row.hung ?? []), i + 1];
        if (row.hung.length >= 3) { row.infra = `3 issues hit the ${SESSION_LIMIT_MS / 60_000}-minute limit (last: issue ${i + 1})`; break; }
      }
      if (!session) { row.infra = `issue ${i + 1}: no session id (${row.steps.at(-1).error ?? "?"})`; break; }
      const spent = spentBefore + row.steps.reduce((s, x) => s + x.cliUsd, 0);
      if (MAX_SPEND && spent >= MAX_SPEND) { row.capped = `stopped after issue ${i + 1}: run spend $${spent.toFixed(2)} reached --max-spend $${MAX_SPEND}`; break; }
    }
    // Tokens for every agent: Codex bills the ChatGPT plan, so for a chain with Codex in it, dollars cover only the Claude Code issues.
    row.tokens = row.steps.reduce((t, s) => ({ input: t.input + s.tokens.input, cached: t.cached + s.tokens.cached, output: t.output + s.tokens.output }), { input: 0, cached: 0, output: 0 });
    if (fresh) {
      // One transcript per issue: its whole cost is that issue's, and peak and compactions are per session.
      const per = sessions.map((s) => transcriptFacts(s));
      row.perIssueUsd = [0, ...per.map((f) => f?.costUsd ?? 0)];
      Object.assign(row, { costUsd: row.perIssueUsd.reduce((a, b) => a + b, 0), peak: Math.max(0, ...per.map((f) => f?.peak ?? 0)), compactions: per.reduce((a, f) => a + (f?.compactions ?? 0), 0), calls: per.reduce((a, f) => a + (f?.calls ?? 0), 0), sessions });
    } else {
      row.session = session;
      Object.assign(row, session ? transcriptFacts(session) ?? {} : {});
    }
    const facts = ledgerFacts(join(dir, ".snout/ledger.jsonl"));
    Object.assign(row, { withheld: facts.withheld, byRule: facts.byRule, followUps: facts.followUps, followUpTokens: facts.followUpTokens, jevUsd: facts.jevUsd, ledgerRows: facts.rows });
    if (snoutOf(arm) !== "plain" && facts.rows === 0 && !row.infra) { row.infra = "Snout recorded nothing: its hooks did not run"; row.snoutMissing = true; }
    // The point of the "snout" arm in fresh sessions: notes written after one issue reach the next.
    // Reported, not fatal: sessions that learn nothing worth keeping leave no notes, which is a result.
    if (snoutOf(arm) === "snout" && fresh && row.steps.length > 1 && !row.steps.slice(1).some((s) => s.notesIn > 0)) row.noNotes = "no notes reached any later session";
    // Notes that would have reached the session, had it been an arm with memory: none should, outside "snout".
    if (snoutOf(arm) !== "snout" && row.steps.some((s) => s.notesTokens > 0)) row.leak = "notes reached an arm without Snout memory";
    for (let i = 0; i < row.steps.length; i++) {
      const d = join(dir, `task${i + 1}`);
      sh("git", ["add", "-A"], { cwd: d });
      const patch = sh("git", ["diff", "--cached", "HEAD"], { cwd: d }).stdout;
      const g = patch.trim() ? grade(d, tasks[i], splitPatch(readFileSync(join(REPO, tasks[i].patch), "utf8")).test) : { resolved: false };
      row.issues.push({ task: tasks[i].id, position: i + 1, costUsd: row.perIssueUsd?.[i + 1] ?? 0, patch, ...g });
    }
  } catch (e) {
    row.infra = String(e.message).slice(0, 300);
  } finally {
    if (!args.keep) { rmSync(dir, { recursive: true, force: true }); rmSync(snoutConfig, { recursive: true, force: true }); } else Object.assign(row, { dir, snoutConfig });
  }
  row.solved = row.issues.filter((x) => x.resolved).length;
  row.seconds = Math.round((Date.now() - started) / 1000);
  return row;
}

function summarizeChains(saved) {
  const rows = saved.rows.filter((r) => !r.infra);
  const sum = (rs, k) => rs.reduce((x, r) => x + (r[k] ?? 0), 0);
  const pct = (a, b) => (b > 0 ? `${a <= b ? "−" : "+"}${Math.abs((1 - a / b) * 100).toFixed(1)}%` : "n/a");
  const agents = saved.agents ?? ["claude"];
  console.log(`\n${saved.repo}, ${agents.length > 1 ? `agents in turn ${agents.join(" → ")}, claude ${saved.model}${saved.codexModel ? `, codex ${saved.codexModel}` : ""}` : `claude ${saved.model}`}, ${rows.length} chain run(s) of ${saved.chainLength} issues (an arm ending in -fresh starts a new session per issue)\n`);
  if (agents.includes("codex")) console.log("  Codex bills the ChatGPT plan: cost and $/solved count the Claude Code issues only; tokens count every issue.\n");
  console.log("  arm            rep   solved      cost   $/solved   peak   compactions   kept out   tokens in (cached)   out");
  for (const r of rows) console.log(`  ${r.arm.padEnd(14)} ${String(r.rep).padStart(3)}   ${`${r.solved}/${r.issues.length}`.padStart(6)}   $${(r.costUsd ?? 0).toFixed(3).padStart(6)}   ${r.solved ? `$${(r.costUsd / r.solved).toFixed(3)}` : "   n/a"}   ${String(Math.round((r.peak ?? 0) / 1000)).padStart(4)}k   ${String(r.compactions ?? 0).padStart(11)}   ${String(Math.round((r.withheld ?? 0) / 1000)).padStart(7)}k   ${r.tokens ? `${String(Math.round(r.tokens.input / 1000)).padStart(8)}k (${Math.round(r.tokens.cached / 1000)}k)   ${Math.round(r.tokens.output / 1000)}k` : "        n/a"}`);
  const notes = rows.filter((r) => r.fresh && snoutOf(r.arm) === "snout");
  if (notes.length) console.log(`\n  notes carried: ${notes.map((r) => `${r.arm} rep ${r.rep}: ${r.steps.slice(1).filter((s) => s.notesIn > 0).length}/${r.steps.length - 1} later sessions started with notes (~${Math.round(r.steps.reduce((a, s) => a + (s.notesTokens ?? 0), 0) / Math.max(1, r.steps.length - 1))} tokens each)`).join("; ")}`);
  const leaks = rows.filter((r) => r.leak);
  if (leaks.length) console.log(`  WARNING: ${leaks.map((r) => `${r.arm} rep ${r.rep}: ${r.leak}`).join("; ")}`);
  // Every pair of arms, each later arm against each earlier one (A, C-off, C-on: three comparisons).
  const arms = saved.arms ?? ARMS;
  for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) compareChains(rows, arms[i], arms[j], sum, pct);
}

function compareChains(rows, base, arm, sum, pct) {
  const off = rows.filter((r) => r.arm === base), on = rows.filter((r) => r.arm === arm);
  if (!off.length || !on.length) return;
  // Per-issue rows (each issue's share of its session's cost), paired by issue across arms: the
  // bootstrap draws issues, then runs within each issue.
  const per = (rs) => rs.flatMap((r) => r.issues.map((x) => ({ task: x.task, costUsd: x.costUsd, resolved: x.resolved })));
  const io = per(off), ion = per(on);
  const solvedOff = io.filter((x) => x.resolved).length, solvedOn = ion.filter((x) => x.resolved).length;
  console.log(`\n  ${arm} vs ${base}\n`);
  console.log(`  cost            ${pct(sum(on, "costUsd"), sum(off, "costUsd"))}   ($${sum(off, "costUsd").toFixed(2)} → $${sum(on, "costUsd").toFixed(2)})`);
  const ci = bootstrap(io, ion, "costUsd");
  if (ci) console.log(`  cost 95% CI     ${ci}   (bootstrap over issues, then runs within each issue)`);
  if (solvedOff && solvedOn) console.log(`  $/solved issue  ${pct(sum(on, "costUsd") / solvedOn, sum(off, "costUsd") / solvedOff)}   ($${(sum(off, "costUsd") / solvedOff).toFixed(3)} → $${(sum(on, "costUsd") / solvedOn).toFixed(3)})`);
  console.log(`  resolved        ${base} ${solvedOff}/${io.length} · ${arm} ${solvedOn}/${ion.length}   (the fix PR's own tests)`);
  for (const l of costLines(off, on, sum)) console.log(l);
  for (const l of reliabilityLines(io, ion, (r) => r.resolved, [base, arm])) console.log(l);
  // Late in a session is where trimming should compound and compaction can lose facts.
  const half = (rs, late) => rs.flatMap((r) => r.issues.filter((x) => (x.position > r.issues.length / 2) === late));
  for (const [label, late] of [["first half", false], ["second half", true]]) {
    const a = half(off, late), b = half(on, late);
    console.log(`  ${label.padEnd(15)} cost ${pct(sum(b, "costUsd"), sum(a, "costUsd"))} · resolved ${base} ${a.filter((x) => x.resolved).length}/${a.length}, ${arm} ${b.filter((x) => x.resolved).length}/${b.length}`);
  }
}

function summarize(saved) {
  if (saved.mode === "chain") return summarizeChains(saved);
  const rows = saved.rows.filter((r) => !r.infra);
  const sum = (rs, k) => rs.reduce((x, r) => x + (r[k] ?? 0), 0);
  const pct = (a, b) => (b > 0 ? `${a <= b ? "−" : "+"}${Math.abs((1 - a / b) * 100).toFixed(1)}%` : "n/a");
  const tasks = [...new Set(rows.map((r) => r.task))];
  console.log(`\n${saved.repo} real-repo A/B, claude ${saved.model}, n=${saved.n}, ${tasks.length} tasks\n`);
  console.log("  task            arm       resolved   input tok   output   turns     cost   kept out");
  for (const t of tasks) for (const a of ["plain", "off", "enforce"]) {
    const rs = rows.filter((r) => r.task === t && r.arm === a);
    if (!rs.length) continue;
    const avg = (k) => sum(rs, k) / rs.length;
    console.log(`  ${t.padEnd(15)} ${a.padEnd(9)} ${`${rs.filter((r) => r.resolved).length}/${rs.length}`.padStart(8)} ${String(Math.round(avg("inputTokens"))).padStart(11)} ${String(Math.round(avg("outputTokens"))).padStart(8)} ${avg("turns").toFixed(1).padStart(7)}   $${avg("costUsd").toFixed(3)} ${String(Math.round(avg("withheld"))).padStart(9)}`);
  }
  const [base, arm] = ARMS.length === 2 ? ARMS : ["off", "enforce"];
  const off = rows.filter((r) => r.arm === base);
  const on = rows.filter((r) => r.arm === arm);
  if (off.length && on.length) {
    console.log(`\n  ${arm} vs ${base}\n`);
    console.log(`  cost            ${pct(sum(on, "costUsd"), sum(off, "costUsd"))}   ($${sum(off, "costUsd").toFixed(2)} → $${sum(on, "costUsd").toFixed(2)})`);
    const ci = bootstrap(off, on, "costUsd");
    if (ci) console.log(`  cost 95% CI     ${ci}   (bootstrap over tasks, then runs within each task)`);
    console.log(`  input tokens    ${pct(sum(on, "inputTokens"), sum(off, "inputTokens"))}`);
    for (const l of costLines(off, on, sum)) console.log(l);
    for (const l of reliabilityLines(off, on, (r) => r.resolved, [base, arm])) console.log(l);
    console.log(`  resolved        ${base} ${off.filter((r) => r.resolved).length}/${off.length} · ${arm} ${on.filter((r) => r.resolved).length}/${on.length}   (the fix PR's own tests)`);
  }
  const infra = saved.rows.filter((r) => r.infra);
  if (infra.length) console.log(`  infrastructure failures (excluded): ${infra.map((r) => `${r.task}/${r.arm}/${r.rep}`).join(", ")}`);
}

async function main() {
  if (typeof args.summarize === "string") return summarize(JSON.parse(readFileSync(args.summarize, "utf8")));
  const spec = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
  const only = typeof args.tasks === "string" ? new Set(args.tasks.split(",")) : null;
  const tasks = only ? spec.tasks.filter((t) => only.has(t.id)) : spec.tasks;
  if (args.chain) return mainChain(spec, tasks);
  const resumed = typeof args.resume === "string" ? JSON.parse(readFileSync(args.resume, "utf8")) : null;
  if (resumed && (resumed.model !== MODEL || resumed.n !== N)) throw new Error(`--resume: file is model ${resumed.model} n ${resumed.n}; pass the same --model and --n`);
  const excluded = [...(resumed?.excluded ?? []), ...(resumed?.rows ?? []).filter((r) => r.infra)];
  const rows = (resumed?.rows ?? []).filter((r) => !r.infra);
  const have = new Set(rows.map((r) => `${r.task}|${r.arm}|${r.rep}`));
  const plan = [];
  // Arm order rotates by task and rep, so neither arm always gets the other's warm prompt cache.
  for (let rep = 0; rep < N; rep++) tasks.forEach((t, i) => {
    const k = (i + rep) % ARMS.length;
    for (const a of [...ARMS.slice(k), ...ARMS.slice(0, k)]) if (!have.has(`${t.id}|${a}|${rep}`)) plan.push([t, a, rep]);
  });
  const runId = resumed?.runId ?? `realrepo-${Date.now()}`;
  const outFile = resumed ? args.resume : join(REPO, "bench/ab-results", `${runId}.json`);
  mkdirSync(join(REPO, "bench/ab-results"), { recursive: true });
  const frozen = frozenBuild();
  if (resumed && resumed.frozen.snoutDistSha256 !== frozen.snoutDistSha256) throw new Error("--resume: dist/snout.mjs changed since this run started; the arms would not be the same Snout");
  const token = FAKE ? "" : githubToken();
  const save = () => writeFileSync(outFile, JSON.stringify({ runId, repo: spec.repo, model: MODEL, n: N, measuredAt: resumed?.measuredAt ?? new Date().toISOString(), ...stamp(), frozen, rows, ...(excluded.length ? { excluded } : {}) }, null, 2));
  console.error(`${plan.length} session(s): ${tasks.length} task(s) × ${ARMS.length} arm(s) × ${N}, model ${MODEL}, cap $${BUDGET}, ${JOBS} at a time → ${outFile}`);
  let next = 0, done = 0, halted = null;
  const worker = async () => {
    while (next < plan.length && !halted) {
      const [t, a, rep] = plan[next++];
      let row = await runOne(spec, t, a, rep, token);
      if (row.infra && !row.snoutMissing) row = { ...(await runOne(spec, t, a, rep, token)), retried: true }; // protocol: one rerun
      if (row.snoutMissing) halted ??= `Snout recorded nothing in ${t.id} · ${a} · rep ${rep}; fix the install, then --resume ${outFile}`;
      rows.push(row);
      const spent = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      if (MAX_SPEND && spent >= MAX_SPEND) halted ??= `spent $${spent.toFixed(2)}, at the --max-spend cap of $${MAX_SPEND}; raise it and --resume ${outFile}`;
      const last = rows.slice(-3);
      if (last.length === 3 && last.every((r) => API_REFUSED.test(r.error ?? ""))) halted ??= `the API refused 3 sessions in a row (${last[2].error}); fix it, then --resume ${outFile}`;
      save();
      done++;
      process.stderr.write(`[${done}/${plan.length}] ${t.id} · ${a} · rep ${rep}: ${row.infra ? `INFRA ${row.infra}` : `${Math.round(row.inputTokens / 1000)}k in · ${row.turns} turns · $${row.costUsd.toFixed(3)} · ${row.resolved ? "RESOLVED" : "not resolved"}${row.withheld ? ` · ~${Math.round(row.withheld / 1000)}k kept out` : ""}${row.error ? ` · ${row.error}` : ""}`}\n`);
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
  console.log(`\nSessions: ${outFile}`);
  if (halted) { console.error(halted); process.exit(2); }
  summarize(JSON.parse(readFileSync(outFile, "utf8")));
}

/** --chain: N chain runs per arm, arm order alternating by rep, issues oldest first. */
async function mainChain(spec, picked) {
  const tasks = [...picked].sort((a, b) => a.closed.localeCompare(b.closed) || a.issue - b.issue);
  if (args["codex-setup"]) return codexSetup(spec, tasks);
  if (AGENTS.some((a) => a !== "claude" && a !== "codex")) throw new Error(`--agents: claude and codex only, not ${AGENTS.join(",")}`);
  if (USES_CODEX && ARMS.some((a) => !isFresh(a))) throw new Error("--agents with codex needs fresh arms only (plain-fresh, snout-fresh): a session can't pass from one agent to another");
  if (USES_CODEX && JOBS > 1) throw new Error("--agents with codex runs one chain at a time: Codex works in one fixed, trusted folder");
  const resumed = typeof args.resume === "string" ? JSON.parse(readFileSync(args.resume, "utf8")) : null;
  if (resumed && (resumed.model !== MODEL || resumed.n !== N || resumed.mode !== "chain")) throw new Error("--resume: pass the same --chain, --model and --n as the run being resumed");
  if (resumed && (resumed.agents ?? ["claude"]).join() !== AGENTS.join()) throw new Error("--resume: pass the same --agents as the run started with");
  const excluded = [...(resumed?.excluded ?? []), ...(resumed?.rows ?? []).filter((r) => r.infra)];
  const rows = (resumed?.rows ?? []).filter((r) => !r.infra);
  const have = new Set(rows.map((r) => `${r.arm}|${r.rep}`));
  const plan = [];
  for (let rep = 0; rep < N; rep++) {
    const k = rep % ARMS.length;
    for (const a of [...ARMS.slice(k), ...ARMS.slice(0, k)]) if (!have.has(`${a}|${rep}`)) plan.push([a, rep]);
  }
  const runId = resumed?.runId ?? `realrepo-chain-${Date.now()}`;
  const outFile = resumed ? args.resume : join(REPO, "bench/ab-results", `${runId}.json`);
  mkdirSync(join(REPO, "bench/ab-results"), { recursive: true });
  const frozen = frozenBuild();
  if (resumed && resumed.frozen.snoutDistSha256 !== frozen.snoutDistSha256) throw new Error("--resume: dist/snout.mjs changed since this run started; the arms would not be the same Snout");
  if (resumed && (resumed.repoMap ?? true) !== REPO_MAP) throw new Error("--resume: pass the same --map as the run started with");
  const token = FAKE ? "" : githubToken();
  const save = () => writeFileSync(outFile, JSON.stringify({ runId, mode: "chain", repo: spec.repo, model: MODEL, n: N, arms: ARMS, agents: AGENTS, ...(CODEX_MODEL ? { codexModel: CODEX_MODEL } : {}), repoMap: REPO_MAP, chainLength: tasks.length, order: tasks.map((t) => t.id), measuredAt: resumed?.measuredAt ?? new Date().toISOString(), ...stamp(), frozen, rows, ...(excluded.length ? { excluded } : {}) }, null, 2));
  console.error(`${plan.length} chain run(s) of ${tasks.length} issues: ${ARMS.length} arm(s) × ${N}, model ${MODEL}, cap $${BUDGET} per issue → ${outFile}`);
  for (const [a, rep] of plan) {
    const spent = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    if (MAX_SPEND && spent >= MAX_SPEND) { console.error(`spent $${spent.toFixed(2)}, at the --max-spend cap of $${MAX_SPEND}; raise it and --resume ${outFile}`); break; }
    const row = await runChain(spec, tasks, a, rep, token, spent);
    rows.push(row);
    save();
    process.stderr.write(`${a} · rep ${rep}: ${row.infra ? `INFRA ${row.infra}` : `${row.solved}/${row.issues.length} solved · $${(row.costUsd ?? 0).toFixed(3)} · peak ${Math.round((row.peak ?? 0) / 1000)}k · ${row.compactions ?? 0} compaction(s)${row.withheld ? ` · ~${Math.round(row.withheld / 1000)}k kept out` : ""}${row.fresh ? ` · notes into ${row.steps.slice(1).filter((s) => s.notesIn > 0).length}/${Math.max(0, row.steps.length - 1)} later sessions` : ""}${row.noNotes ? ` · ${row.noNotes}` : ""}${row.leak ? ` · WARNING ${row.leak}` : ""}${row.capped ? ` · ${row.capped}` : ""}`}\n`);
    if (row.snoutMissing) { console.error(`Snout recorded nothing in ${a} · rep ${rep}; fix the install, then --resume ${outFile}`); process.exit(2); }
    if (row.capped) break;
  }
  console.log(`\nSessions: ${outFile}`);
  summarize(JSON.parse(readFileSync(outFile, "utf8")));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(1); });
