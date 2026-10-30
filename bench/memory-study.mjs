#!/usr/bin/env node
/**
 * The memory study (docs/benchmark-protocol.md, "Memory study"): validated tasks from repositories we
 * did not write, each in a new session, in three arms, graded by the fix PR's own tests.
 *
 *   plain    no Snout (Codex: Snout's hooks, inherited from the trusted checkout, in observe: they add nothing)
 *   trim     Snout's read gate and output trimming, memory off
 *   memory   trim plus verified memory as built; notes carry from task to task within the chain
 *   search   trim plus memory as it ships: no notes; Snout's search and fetch as MCP tools, and the
 *            session-start hint once earlier sessions are on record. The agent decides whether to search.
 *
 * Arms are interleaved by task (each task in every arm before the next, the order rotating), so no arm
 * starts on a prompt cache another arm warmed. --pilot runs the frozen Gate 4 pilot (bench/memory-pilot.json:
 * plain, trim, search; its tasks; one repeat); --summarize takes two result files to pool an agent's repositories.
 *
 *   SWE_FAKE_AGENT=1 node bench/memory-study.mjs --agent claude --tasks bench/memory-check-vite.json --allow-dirty   # free, stand-in agent
 *   SWE_FAKE_AGENT=1 node bench/memory-study.mjs --pilot --agent codex --tasks bench/memory-tasks-hugo.json --allow-dirty   # pilot dry run
 *   node bench/memory-study.mjs --pilot --agent claude --tasks bench/memory-tasks-vite.json --model claude-sonnet-5-5 --api --max-spend 8
 *   node bench/memory-study.mjs --agent claude --tasks bench/memory-check-hugo.json --repeats 1 --model claude-sonnet-5-5 --api --max-spend 8
 *   node bench/memory-study.mjs --agent codex  --tasks bench/memory-tasks-vite.json --repeats 2 --max-sessions 132
 *   node bench/memory-study.mjs --summarize bench/ab-results/memory-study-<...>.json
 *
 * Each task starts at its own fix's base commit in every arm; tasks run oldest merge first; an
 * agent's patch never carries over. The agent gets the issue as it read before the fix PR opened,
 * no MCP server, no web: web tools and network commands are refused, package managers and Go
 * modules are offline, and every command a session ran is scanned afterwards for network use.
 * The fix and the PR's tests are never in the workspace during a session. Snout's own processes run
 * under bench/snout-guard.cjs; a call from Snout to Jev, Snout Cloud, the embedding model or the
 * network invalidates the chain.
 *
 * Workspaces are prepared once per task (dependencies installed, vite built) and reset to the base
 * commit before every session. Claude Code works in ~/.snout-bench/mem-ws, outside this repository,
 * so none of its instruction files load. Codex runs project hooks only in a folder its user has
 * trusted, so its workspaces live in this (trusted) checkout under .snout/mem-ws, with no git
 * repository of their own (the harness keeps theirs outside the folder) and AGENTS.md loading off.
 * There Snout would take this checkout (the nearest folder above with a .snout/) as the project and
 * git would find this repository, so each Codex session and its MCP server get the workspace declared
 * as the project (CLAUDE_PROJECT_DIR, which Snout reads for any agent) and git pointed at the
 * workspace's own repository (ownProject): Snout's paths, branch and project key come from the task's
 * repository, as on a user's machine, and the agent's own git commands show it, not this repository.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { armSettings, launchClaude, frozenBuild, REPO, SNOUT_BIN, FAKE, CLEAN_HOME, API_REFUSED } from "./swe.mjs";
import { shippedClaudeHooks } from "./shipped-hooks.mjs";
import { transcriptFacts } from "./swelong.mjs";
import { stamp } from "./stamp.mjs";
import { codexToolchainEnv, removeSandboxed } from "./codex-toolchain.mjs";
import { networkCommands, modeProblems, armProblems, scoreStep, costMismatch, spentUsd, hookCoverage, codexHookCoverage, pilotVerdict, armOrder, memoryUse, groupFits, recordName } from "./study-checks.mjs";

const { gateEntries, squeezeEntries } = await import(pathToFileURL(join(REPO, "dist/lib.mjs")).href);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const AGENT = args.agent === "codex" ? "codex" : "claude";
const MODEL = typeof args.model === "string" ? args.model : AGENT === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5";
// --pilot: the frozen Gate 4 pilot (bench/memory-pilot.json) sets the arms, repeats, tasks and spend cap, and a run can't change them.
const PILOT_FILE = join(REPO, "bench", "memory-pilot.json");
const PILOT = args.pilot ? JSON.parse(readFileSync(PILOT_FILE, "utf8")) : null;
if (PILOT && ((typeof args.arms === "string" && args.arms !== PILOT.armOrder.join(",")) || (args.repeats !== undefined && Number(args.repeats) !== PILOT.repeats))) throw new Error("--pilot sets the arms and repeats (bench/memory-pilot.json)");
if (PILOT && !PILOT.agents.includes(AGENT)) throw new Error(`the pilot has no ${AGENT} arm`);
const ARMS = PILOT ? PILOT.armOrder : (typeof args.arms === "string" ? args.arms : "plain,trim,memory").split(",");
const REPEATS = PILOT ? PILOT.repeats : Number(args.repeats ?? 2);
const BUDGET = String(args.budget ?? "2.00");
const MAX_SPEND = args["max-spend"] ? Number(args["max-spend"]) : 0;
const MAX_SESSIONS = args["max-sessions"] ? Number(args["max-sessions"]) : 0;
const LIMIT_MS = 30 * 60_000;
const HOME = homedir();
const BIN_DIR = join(HOME, ".snout-bench", "bin"); // corepack's pnpm shim
const WS_ROOT = AGENT === "codex" ? join(REPO, ".snout", "mem-ws") : join(HOME, ".snout-bench", "mem-ws");
const GIT_ROOT = join(HOME, ".snout-bench", "mem-git");
/** gpt-6.1-sol list prices per million tokens (OpenAI model page, 2026-10-23): input, cached input, output. */
const CODEX_PRICE = { input: 2, cached: 0.1, output: 10 };

const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 512 << 20, timeout: 1_800_000, shell: process.platform === "win32" && cmd === "pnpm", ...opts });
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || "").slice(-400)}`); return r; };

// Offline for everything the agent and the grader run: package managers, Go modules, corepack.
const OFFLINE = { npm_config_offline: "true", npm_config_prefer_offline: "true", COREPACK_ENABLE_NETWORK: "0", GOPROXY: "off", GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" };
const pathWith = (dir) => `${dir}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
const ENV = { ...process.env, PATH: pathWith(BIN_DIR), CI: "1" };

// ---------- Tasks ----------

const TASKS_FILE = resolve(REPO, String(args.tasks ?? ""));
const spec = typeof args.tasks === "string" && existsSync(TASKS_FILE) ? JSON.parse(readFileSync(TASKS_FILE, "utf8")) : null;
const NAME = spec?.repo.split("/")[1];
// Set explicitly: otherwise Codex takes it from the operator's ~/.codex/config.toml.
const EFFORT = typeof args.effort === "string" ? args.effort : "low";

/** The tasks a run uses: validated, not used in an earlier run of ours, and in a check file only its check set. */
// In the pilot, its tasks only; --only narrows them for a dry run, never for a run with a real agent.
const studyTasks = () => {
  const pilot = PILOT ? PILOT.tasks[relative(REPO, TASKS_FILE).replace(/\\/g, "/")] : null;
  if (PILOT && !pilot) throw new Error(`${TASKS_FILE} is not in the pilot`);
  if (PILOT && !FAKE && args.only) throw new Error("--only is for a dry run: the pilot runs all its tasks");
  const tasks = spec.tasks
    .filter((t) => t.validated && !t.usedBefore && (!spec.checkSet || spec.checkSet.includes(t.id)) && (!pilot || pilot.includes(t.id)))
    .filter((t) => typeof args.only !== "string" || args.only.split(",").includes(t.id));
  if (pilot && !args.only && tasks.length !== pilot.length) throw new Error(`the pilot lists ${pilot.length} tasks here, ${tasks.length} are validated and held out`);
  return tasks;
};

// ---------- Freeze ----------

/** What a paid run must match (docs/benchmark-protocol.md, "Frozen inputs"): `--freeze` writes it, every paid run checks it. */
const FREEZE_FILE = join(REPO, "bench", "memory-freeze.json");
const FROZEN_SETTINGS = { claudeCode: "2.1.306", codex: "0.163.0", claudeModel: "claude-sonnet-5-5", codexModel: "gpt-6.1-sol", codexEffort: "low", budgetUsd: "2.00", limitMinutes: 30 };
const TASK_FILES = ["bench/memory-tasks-hugo.json", "bench/memory-tasks-vite.json", "bench/memory-check-hugo.json", "bench/memory-check-vite.json"];
function freezeFiles() {
  const files = ["dist/snout.mjs", "dist/lib.mjs", "hooks/hooks.json", ".codex/hooks.json", "bench/memory-study.mjs", "bench/codex-toolchain.mjs", "bench/study-checks.mjs", "bench/snout-guard.cjs",
    "bench/swe.mjs", "bench/swelong.mjs", "bench/shipped-hooks.mjs", "bench/stamp.mjs", "bench/memory-pilot.json", "docs/benchmark-protocol.md", ...TASK_FILES];
  for (const tf of TASK_FILES) {
    const s = JSON.parse(readFileSync(join(REPO, tf), "utf8"));
    for (const t of s.tasks) if (t.validated && !t.usedBefore && (!s.checkSet || s.checkSet.includes(t.id))) files.push(t.patch, t.issueSnapshot);
  }
  return Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(join(REPO, f))).digest("hex")]));
}
function writeFreeze() {
  const files = freezeFiles();
  const counts = Object.fromEntries(TASK_FILES.map((tf) => { const s = JSON.parse(readFileSync(join(REPO, tf), "utf8")); return [tf, s.tasks.filter((t) => t.validated && !t.usedBefore && (!s.checkSet || s.checkSet.includes(t.id))).map((t) => t.id)]; }));
  writeFileSync(FREEZE_FILE, JSON.stringify({ frozenAt: new Date().toISOString(), settings: FROZEN_SETTINGS, tasks: counts, files }, null, 2) + "\n");
  console.log(`froze ${Object.keys(files).length} files → ${FREEZE_FILE}`);
}
/** A paid run refuses to start unless every frozen file, setting and agent version still matches. */
function checkFreeze(agentVersion) {
  if (!existsSync(FREEZE_FILE)) throw new Error("no bench/memory-freeze.json: freeze the inputs first (--freeze)");
  const want = JSON.parse(readFileSync(FREEZE_FILE, "utf8"));
  const now = freezeFiles();
  const bad = Object.keys({ ...want.files, ...now }).filter((f) => want.files[f] !== now[f]);
  const s = want.settings;
  if (MODEL !== (AGENT === "codex" ? s.codexModel : s.claudeModel)) bad.push(`model ${MODEL}`);
  if (AGENT === "codex" && EFFORT !== s.codexEffort) bad.push(`effort ${EFFORT}`);
  if (AGENT === "claude" && BUDGET !== s.budgetUsd) bad.push(`budget ${BUDGET}`);
  if (LIMIT_MS / 60000 !== s.limitMinutes) bad.push(`limit ${LIMIT_MS / 60000} min`);
  if (!String(agentVersion ?? "").includes(AGENT === "codex" ? s.codex : s.claudeCode)) bad.push(`${AGENT} version ${agentVersion}`);
  if (bad.length) throw new Error(`differs from the frozen inputs (bench/memory-freeze.json): ${bad.join(", ")}`);
}

/** Codex reads the operator's config.toml; what it held is recorded with the run (plugins, sandbox and approval keys, its hash). */
function codexUserConfig() {
  const file = join(process.env.CODEX_HOME || join(HOME, ".codex"), "config.toml");
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const top = (k) => new RegExp(`^${k}\\s*=\\s*"?([^"\\n]*)"?`, "m").exec(text)?.[1];
  const plugins = [...text.matchAll(/^\[plugins\."([^"]+)"\]\s*\n\s*enabled\s*=\s*true/gm)].map((m) => m[1]);
  return { sha256: createHash("sha256").update(text).digest("hex"), model: top("model"), effort: top("model_reasoning_effort"), sandbox_mode: top("sandbox_mode"), approval_policy: top("approval_policy"), service_tier: top("service_tier"), pluginsEnabled: plugins };
}
const GO = spec?.repo === "gohugoio/hugo";
const CLONE = GO ? join(REPO, "..", "study-hugo") : join(HOME, ".snout-bench", "clones", "vite");

/** What every arm's agent is asked, around the frozen issue snapshot. */
const prompt = (t) => `The repository in the current directory is ${spec.repo} at the commit just before the fix for the issue below. Find the cause and fix it by editing the source code. Run the relevant tests before you finish, and do not modify the existing tests. There is no network access: dependencies are already installed.

${readFileSync(join(REPO, t.issueSnapshot), "utf8")}`;

// ---------- Workspaces ----------

const wsOf = (t) => join(WS_ROOT, `${NAME}-${t.issue}`);
const gitDirOf = (t) => (AGENT === "codex" ? join(GIT_ROOT, `${NAME}-${t.issue}.git`) : join(wsOf(t), ".git"));
const git = (t, ...a) => sh("git", ["--git-dir", gitDirOf(t), "--work-tree", wsOf(t), "-c", "user.name=bench", "-c", "user.email=bench@localhost", ...a], { cwd: wsOf(t), env: ENV });

/** The base commit with no history, dependencies installed and (vite) built, committed as the baseline. Once per task. */
function prepare(t) {
  const ws = wsOf(t);
  const marker = join(gitDirOf(t), "snout-prepared");
  if (existsSync(marker) && readFileSync(marker, "utf8") === t.base) return;
  rmSync(ws, { recursive: true, force: true });
  rmSync(gitDirOf(t), { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  // The base commit's files, written by git with a throwaway index: no link to the clone (whose
  // history holds the fix), and symbolic links written as files, as a Windows checkout does
  // (tar can't create vite's playground links here).
  const index = join(WS_ROOT, `${NAME}-${t.issue}.index`);
  must(sh("git", ["-C", CLONE, "-c", "core.symlinks=false", "-c", "core.autocrlf=false", `--work-tree=${ws}`, "checkout", t.base, "--", "."], { env: { ...ENV, GIT_INDEX_FILE: index } }), "checkout base");
  rmSync(index, { force: true });
  must(sh("git", ["init", "-q", ...(AGENT === "codex" ? ["--separate-git-dir", gitDirOf(t)] : [])], { cwd: ws }), "git init");
  // A separate git dir leaves a `.git` file pointing to it: remove it, so the folder has no repository of its own.
  if (AGENT === "codex") rmSync(join(ws, ".git"), { force: true });
  for (const [k, v] of [["core.autocrlf", "false"], ["core.filemode", "false"]]) git(t, "config", k, v);
  appendFileSync(join(gitDirOf(t), "info", "exclude"), "\n/.claude/\n/.codex/\n/.snout/\n/.mcp.json\n/.gocache/\n");
  must(git(t, "add", "-A"), "git add");
  must(git(t, "commit", "-q", "--no-verify", "-m", "baseline"), "baseline commit");
  // The repository's address, as any clone has: Snout keys a project's notes by it, so every task of a repo is one project.
  git(t, "remote", "add", "origin", `https://github.com/${spec.repo}.git`);
  if (GO) must(sh("go", ["mod", "download"], { cwd: ws, env: { ...ENV, GOTOOLCHAIN: "local" } }), "go mod download");
  else {
    // The repo's postinstall would write .git/hooks into the folder: a `.git` there could make Codex treat it as its own, untrusted project.
    must(sh("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: ws, env: { ...ENV, SKIP_INSTALL_SIMPLE_GIT_HOOKS: "1", SKIP_SIMPLE_GIT_HOOKS: "1" } }), "pnpm install");
    must(sh("pnpm", ["--filter", "vite", "run", "build"], { cwd: ws, env: ENV }), "build vite");
  }
  if (AGENT === "codex") rmSync(join(ws, ".git"), { recursive: true, force: true });
  writeFileSync(marker, t.base);
}

/** Back to the baseline before a session: tracked files restored, new files removed (installed deps kept), Snout's files gone. */
function reset(t) {
  must(git(t, "reset", "-q", "--hard", "HEAD"), "reset");
  must(git(t, "clean", "-fdq"), "clean");
  // Go's build cache (.gocache) is kept: a warm cache changes time, not what a session sees or spends.
  // Codex: a folder its session's Python made private to the sandbox user is removed as that user.
  for (const f of [".claude", ".codex", ".snout", ".mcp.json", ...(AGENT === "codex" ? [".git"] : [])]) (AGENT === "codex" && !FAKE ? removeSandboxed : (p) => rmSync(p, { recursive: true, force: true }))(join(wsOf(t), f));
  if (!GO) must(sh("pnpm", ["--filter", "vite", "run", "build"], { cwd: wsOf(t), env: { ...ENV, ...OFFLINE } }), "rebuild vite");
}

/** The arm's Snout config, in the chain's Snout folder (SNOUT_DIR), which is where Snout reads it. */
// Every model-backed or networked option is set off by name, so the arms differ only in what they test:
// the prompt coach (its Jev mode sends the prompt), the preference judge (Jev), lessons, the repo map.
// Cloud sync needs a login, and each chain's config folder is new and empty; the side-call watch below checks all of it.
const OFF = { coach: "off", memoryJudge: "off", memoryLessons: false, repoMap: false, fastHooks: false };
// Automatic notes are opt-in (memoryNotes, off by default since 2026-10-27): the memory arm turns them on by
// name, or it would run trimming only and still be labeled "memory".
// The search arm keeps memory and turns automatic notes off: the agent gets Snout's memory search as an
// MCP tool (search and fetch only) and decides itself whether to call it. Only it has the session-start
// hint (memoryHint): one line saying earlier sessions are on record and how to search them.
const armConfig = (arm) => (arm === "plain"
  ? { mode: "observe", memory: false, memoryNotes: false, memoryHint: false, ...OFF }
  : { mode: "enforce", memory: arm === "memory" || arm === "search", memoryNotes: arm === "memory", memoryHint: arm === "search", ...OFF });

/** The search arm's MCP server: Snout's memory search and fetch, nothing else, on the chain's own store. */
const SEARCH_TOOLS = ["snout_memory_search", "snout_memory_fetch"];
const searchServer = (t, snoutEnv) => ({
  command: process.execPath,
  args: [SNOUT_BIN, "mcp", wsOf(t), "--tools", SEARCH_TOOLS.join(",")],
  env: { ...Object.fromEntries(["SNOUT_DIR", "SNOUT_CONFIG_DIR", "SNOUT_GUARD_LOG", "NODE_OPTIONS", "SNOUT_MEMORY", "SNOUT_MEMORY_NOTES"].map((k) => [k, snoutEnv[k] ?? ""])), ...ownProject(t) },
});
/** Codex only: the workspace is the project, and git is the workspace's own repository (see the header). */
const ownProject = (t) => (AGENT === "codex" ? { CLAUDE_PROJECT_DIR: wsOf(t), GIT_DIR: gitDirOf(t), GIT_WORK_TREE: wsOf(t) } : {});

/**
 * Before a search chain's first session: the server the agent will be given starts and offers exactly
 * the search tools. A chain whose agent could not search would measure trimming under the search label.
 */
/** Dry runs only: one search for the task's title on the search arm's server, then a fetch of the first session it shows. */
function probeSearch(t, snoutEnv, query) {
  const s = searchServer(t, snoutEnv);
  const ask = (name, args) => {
    const input = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const r = spawnSync(s.command, s.args, { input, encoding: "utf8", timeout: 30_000, env: { ...process.env, ...s.env } });
    try { return r.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2)?.result?.content?.[0]?.text ?? ""; } catch { return ""; }
  };
  const found = ask("snout_memory_search", { query });
  const id = /session:[\w.-]+/.exec(found)?.[0];
  if (id) ask("snout_memory_fetch", { id });
  return { query, fetched: id ?? null };
}

function searchPreflight(t, snoutEnv) {
  const s = searchServer(t, snoutEnv);
  const input = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" }].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const r = spawnSync(s.command, s.args, { input, encoding: "utf8", timeout: 30_000, env: { ...process.env, ...s.env } });
  const names = (() => { try { return r.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2).result.tools.map((x) => x.name); } catch { return []; } })();
  if (names.join(",") !== SEARCH_TOOLS.join(",")) throw new Error(`the search arm's MCP server offers [${names.join(", ")}], not [${SEARCH_TOOLS.join(", ")}]: ${(r.stderr || "").slice(-300)}`);
}

/** TOML for Codex's `-c`: literal strings, so Windows paths need no escaping. */
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(",")}]` : typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(",")}}` : `'${String(v)}'`);

/** The arm's hooks in the workspace (Claude Code; Codex inherits the trusted checkout's), and its MCP servers. */
function setArm(t, arm, snoutEnv) {
  const ws = wsOf(t);
  if (AGENT === "claude") {
    if (arm === "plain") armSettings(ws, "plain");
    else {
      const hooks = shippedClaudeHooks(REPO, SNOUT_BIN);
      hooks.PreToolUse = gateEntries(SNOUT_BIN);
      hooks.PostToolUse = [...(hooks.PostToolUse ?? []), ...squeezeEntries(SNOUT_BIN)];
      mkdirSync(join(ws, ".claude"), { recursive: true });
      writeFileSync(join(ws, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2));
    }
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: arm === "search" ? { snout: searchServer(t, snoutEnv) } : {} }));
  }
}

// ---------- Sessions ----------

/** Refused in every arm: web tools, commands that reach the network, and ones that end every Node process on the machine. */
const DISALLOWED = ["WebFetch", "WebSearch", ...["curl", "wget", "gh", "git fetch", "git pull", "git clone", "git push", "npm install", "npm i", "npm add", "pnpm install", "pnpm i", "pnpm add", "go get", "go install", "go mod download", "taskkill", "cmd", "powershell", "pwsh", "pkill", "killall", "Invoke-WebRequest"].map((c) => `Bash(${c}:*)`)];

function runClaude(t, text, snoutEnv, session, arm) {
  const argv = [
    "-p", text, "--output-format", "json", "--model", MODEL, "--session-id", session, "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", join(wsOf(t), ".mcp.json"), "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "Bash", ...(arm === "search" ? SEARCH_TOOLS.map((n) => `mcp__snout__${n}`) : []),
    "--disallowedTools", ...DISALLOWED, "--max-budget-usd", BUDGET,
  ];
  const env = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", ...OFFLINE, ...snoutEnv, CI: "", SNOUT_TOKEN: "", PATH: pathWith(BIN_DIR) };
  return launchClaude(wsOf(t), argv, { env, limitMs: LIMIT_MS, goldPatch: FAKE ? fakePatch(t) : undefined });
}

function runCodex(t, text, snoutEnv, arm) {
  const servers = arm === "search" ? `mcp_servers={snout=${toml(searchServer(t, snoutEnv))}}` : "mcp_servers={}";
  const argv = ["exec", "--json", "-s", "workspace-write", "-C", wsOf(t), "-m", MODEL, "-c", `model_reasoning_effort=${EFFORT}`,
    "-c", "project_doc_max_bytes=0", "-c", servers, text]; // live web search needs --search, which is never passed
  const cli = process.env.CODEX_CLI_JS;
  const [bin, a] = FAKE ? [process.execPath, [join(REPO, "bench/fake-codex.mjs"), ...argv]] : cli ? [process.execPath, [cli, ...argv]] : ["codex", argv];
  if (!FAKE && process.platform === "win32" && !cli) throw new Error("set CODEX_CLI_JS to the Codex CLI's JavaScript entry point");
  const env = { ...process.env, ...OFFLINE, ...snoutEnv, ...ownProject(t), CI: "", SNOUT_TOKEN: "", SNOUT_MODE: "", ...(!FAKE ? codexToolchainEnv(REPO, pathWith(BIN_DIR), wsOf(t)) : { PATH: pathWith(BIN_DIR) }), GOCACHE: join(wsOf(t), ".gocache"),
    ...(FAKE ? { SWE_FAKE_PATCH: fakePatch(t), SWE_FAKE_GIT_DIR: gitDirOf(t), CODEX_HOOKS_FILE: join(REPO, ".codex", "hooks.json") } : {}) };
  return new Promise((done) => {
    const child = spawn(bin, a, { cwd: wsOf(t), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, LIMIT_MS);
    child.on("close", () => { clearTimeout(timer); done({ stdout, stderr, timedOut }); });
  });
}

/** The stand-in applies the fix's source part, so a dry run exercises grading end to end. */
function fakePatch(t) {
  const p = join(WS_ROOT, `${NAME}-${t.issue}.gold.patch`);
  const blocks = readFileSync(join(REPO, t.patch), "utf8").split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  writeFileSync(p, blocks.filter((b) => !t.testFiles.includes(/^diff --git a\/\S+ b\/(\S+)$/m.exec(b)?.[1] ?? "")).join(""));
  return p;
}

/** Codex: the session's thread, tokens and every command it ran, from its JSONL events. */
function codexFacts(stdout) {
  let thread = null, input = 0, cached = 0, output = 0, error;
  const commands = [], mcp = [];
  for (const line of stdout.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "thread.started") thread = e.thread_id;
    else if (e.type === "turn.completed" && e.usage) { input += e.usage.input_tokens ?? 0; cached += e.usage.cached_input_tokens ?? 0; output += e.usage.output_tokens ?? 0; }
    else if (e.type === "item.completed" && e.item?.type === "command_execution") commands.push(String(e.item.command ?? ""));
    else if (e.type === "item.completed" && e.item?.type === "mcp_tool_call") mcp.push(`${e.item.server ?? "?"}/${e.item.tool ?? "?"}`);
    else if (e.type === "error" || e.type === "turn.failed") error = String(e.message ?? e.error?.message ?? e.type);
  }
  const usd = ((input - cached) * CODEX_PRICE.input + cached * CODEX_PRICE.cached + output * CODEX_PRICE.output) / 1e6;
  return { session: thread, tokens: { input, cached, output }, costUsd: usd, commands, mcp, error };
}

/** Claude Code: every tool call the session made ({id, name, input}), from its transcript. */
function claudeToolUses(session) {
  const root = join(CLEAN_HOME ?? (FAKE ? join(process.env.TEMP ?? "/tmp", "snout-fake-claude") : join(HOME, ".claude")), "projects");
  let file;
  try { file = readdirSync(root, { recursive: true }).map(String).find((p) => p.endsWith(`${session}.jsonl`)); } catch { /* none */ }
  if (!file) return [];
  const out = new Map();
  for (const l of readFileSync(join(root, file), "utf8").split("\n")) {
    try { const o = JSON.parse(l); for (const b of o.message?.content ?? []) if (b.type === "tool_use") out.set(b.id, { id: b.id, name: b.name, input: b.input }); } catch { /* not a row */ }
  }
  return [...out.values()];
}

/** Claude Code: every Bash command the session ran. */
const claudeCommands = (uses) => [...new Set(uses.filter((u) => u.name === "Bash").map((u) => String(u.input?.command ?? "")))];

// ---------- Grading ----------

function goTest(t) {
  const r = sh("go", ["test", "-count=1", "-json", ...t.pkgs], { cwd: wsOf(t), env: { ...ENV, ...OFFLINE }, timeout: 1_200_000 });
  const res = {};
  for (const l of (r.stdout || "").split("\n")) {
    try { const e = JSON.parse(l); if (e.Test && ["pass", "fail", "skip"].includes(e.Action)) res[`${e.Package}.${e.Test}`] = e.Action; } catch { /* not a test event */ }
  }
  return res;
}

function vitest(t) {
  const out = join(WS_ROOT, `${NAME}-${t.issue}.grade.json`);
  rmSync(out, { force: true });
  sh("pnpm", ["exec", "vitest", "run", ...t.specFiles, "--reporter=json", `--outputFile=${out}`], { cwd: wsOf(t), env: { ...ENV, ...OFFLINE } });
  if (!existsSync(out)) return {};
  const res = {};
  for (const f of JSON.parse(readFileSync(out, "utf8")).testResults) {
    const rel = f.name.replace(/\\/g, "/").replace(`${wsOf(t).replace(/\\/g, "/")}/`, "");
    for (const a of f.assertionResults) res[`${rel}::${a.fullName}`] = a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip";
  }
  return res;
}

/** The PR's test files over the agent's work (its own edits to them dropped), then FAIL_TO_PASS and PASS_TO_PASS. */
function grade(t) {
  for (const f of t.testFiles) {
    if (git(t, "cat-file", "-e", `HEAD:${f}`).status === 0) git(t, "checkout", "HEAD", "--", f);
    else rmSync(join(wsOf(t), f), { force: true });
  }
  const blocks = readFileSync(join(REPO, t.patch), "utf8").split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  const testPatch = join(WS_ROOT, `${NAME}-${t.issue}.grade.patch`);
  writeFileSync(testPatch, blocks.filter((b) => t.testFiles.includes(/^diff --git a\/\S+ b\/(\S+)$/m.exec(b)?.[1] ?? "")).join(""));
  const a = git(t, "apply", "--whitespace=nowarn", testPatch);
  if (a.status !== 0) return { resolved: false, gradeError: `test files did not apply: ${a.stderr.slice(0, 200)}` };
  if (!GO) {
    const b = sh("pnpm", ["--filter", "vite", "run", "build"], { cwd: wsOf(t), env: { ...ENV, ...OFFLINE } });
    if (b.status !== 0) return { resolved: false, gradeError: "vite does not build with the agent's change" };
  }
  const res = GO ? goTest(t) : vitest(t);
  const f2pFailed = t.f2p.filter((n) => res[n] !== "pass");
  const p2pFailed = t.p2p.filter((n) => res[n] !== "pass");
  return { resolved: !f2pFailed.length && !p2pFailed.length, f2pFailed, p2pFailed };
}

// ---------- One chain: every task, oldest first, in one arm ----------

const hookRows = (dir, session) => {
  try { return readFileSync(join(dir, "hooks.jsonl"), "utf8").split("\n").filter((l) => l.includes(`"session":"${session}"`)).length; } catch { return 0; }
};
const GUARD = join(REPO, "bench", "snout-guard.cjs");
/** The session running now, saved with the results until it finishes. */
let inFlight = null;
const lines = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const { snoutSideCalls } = createRequire(import.meta.url)("./snout-guard.cjs");

const recallRows = (dir) => {
  try { return readFileSync(join(dir, "recall.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

/** A chain: one arm's own Snout folders for one repeat, so memory comes only from earlier tasks in the same chain. */
function openChain(arm, rep) {
  const snoutDir = mkdtempSync(join(HOME, ".snout-bench", `mem-snout-${arm}-`));
  const snoutConfig = mkdtempSync(join(HOME, ".snout-bench", `mem-cfg-${arm}-`));
  const sideLog = join(snoutConfig, "side-calls.jsonl");
  const snoutEnv = { SNOUT_DIR: snoutDir, SNOUT_CONFIG_DIR: snoutConfig, SNOUT_MEMORY: "", SNOUT_MEMORY_NOTES: "", SNOUT_MEMORY_HINT: "", TYPESAFE_API_KEY: "", SNOUT_CLOUD_URL: "", SNOUT_EMBED_FAKE: "",
    SNOUT_GUARD_LOG: sideLog, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(GUARD)}`].filter(Boolean).join(" ") };
  const config = armConfig(arm);
  const wrong = armProblems(arm, config);
  if (wrong.length) throw new Error(`arm config: ${wrong.join("; ")}`);
  writeFileSync(join(snoutDir, "config.json"), JSON.stringify(config) + "\n");
  return { arm, rep, snoutDir, snoutConfig, sideLog, snoutEnv, row: { arm, rep, steps: [] } };
}

function closeChain(chain) {
  const { row, snoutDir, snoutConfig } = chain;
  if (!args.keep) { rmSync(snoutDir, { recursive: true, force: true }); rmSync(snoutConfig, { recursive: true, force: true }); } else Object.assign(row, { snoutDir, snoutConfig });
  row.solved = row.steps.filter((s) => s.resolved).length;
  row.costUsd = row.steps.reduce((a, s) => a + s.costUsd, 0);
  return row;
}

/** The session records in a chain's memory folder, by file name. */
function recordFilesIn(snoutDir) {
  try { return readdirSync(join(snoutDir, "memory")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)); } catch { return []; }
}

/** One task's session in a chain. A session that breaks a validity rule marks the chain's row invalid, and the run stops. */
async function runStep(chain, t, onStep) {
  const { arm, rep, snoutDir, sideLog, snoutEnv, row } = chain;
  prepare(t);
  reset(t);
  setArm(t, arm, snoutEnv);
  if (arm === "search" && !row.steps.length) searchPreflight(t, snoutEnv);
  const before = recallRows(snoutDir).length;
  const recordsBefore = recordFilesIn(snoutDir);
  const sideBefore = lines(sideLog).length;
  const started = Date.now();
  // Saved before the session starts, so a run that is killed still accounts for it (`--summarize` prices it).
  const session = AGENT === "claude" ? randomUUID() : null;
  inFlight = { arm, rep, task: t.id, session, started: new Date(started).toISOString() };
  onStep(row);
  const r = AGENT === "codex" ? await runCodex(t, prompt(t), snoutEnv, arm) : await runClaude(t, prompt(t), snoutEnv, session, arm);
  let step, uses = [];
  if (AGENT === "codex") {
    const f = codexFacts(r.stdout);
    step = { task: t.id, session: f.session, costUsd: f.costUsd, priced: "list-price equivalent (plan billing)", tokens: f.tokens, commands: f.commands, memoryCalls: f.mcp.filter((m) => m.startsWith("snout/")).map((m) => m.slice(6)), error: f.error };
  } else {
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
    const tf = out.session_id ? transcriptFacts(out.session_id) : null;
    const u = out.usage ?? {};
    uses = out.session_id ? claudeToolUses(out.session_id) : [];
    step = {
      task: t.id, session: out.session_id, costUsd: tf?.costUsd ?? out.total_cost_usd ?? 0, cliCostUsd: out.total_cost_usd, turns: out.num_turns ?? 0, peak: tf?.peak ?? 0,
      tokens: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
      commands: claudeCommands(uses),
      memoryCalls: uses.filter((x) => String(x.name).startsWith("mcp__snout__")).map((x) => String(x.name).slice(12)),
      cut: /max_budget/.test(String(out.subtype ?? "")) || undefined,
      error: out.is_error && !/max_budget/.test(String(out.subtype ?? "")) ? String(out.result ?? out.subtype ?? "error").slice(0, 200) : undefined,
    };
  }
  step.seconds = Math.round((Date.now() - started) / 1000);
  step.timedOut = r.timedOut || undefined;
  step.network = networkCommands(step.commands);
  const rows = recallRows(snoutDir).slice(before).filter((x) => x.session === step.session);
  // What memory showed this session and whether it acted on it (one session at a time per chain, so every new row is its own).
  const touched = AGENT === "codex" ? step.commands : uses.flatMap((u) => ["file_path", "path", "notebook_path", "command", "pattern"].map((k) => u.input?.[k]).filter((x) => typeof x === "string"));
  const recordFiles = (id) => { try { return JSON.parse(readFileSync(join(snoutDir, "memory", `${recordName(id)}.json`), "utf8")).changed ?? []; } catch { return []; } };
  // The records this session left, so a later session's search and fetch can be traced to this task (pilotVerdict's path).
  step.records = recordFilesIn(snoutDir).filter((n) => !recordsBefore.includes(n));
  // A dry run's stand-in calls no MCP tool: ask the search arm's own server, as an agent might, so the measure runs end to end (marked a probe).
  if (FAKE && arm === "search" && step.session) step.probe = probeSearch(t, snoutEnv, "repository commit fix issue tests");
  const use = memoryUse(recallRows(snoutDir).slice(before), touched, recordFiles);
  if (use) step.memory = use;
  step.notes = rows.filter((x) => x.kind === "inject" && x.injected).map((x) => ({ turn: x.turn, items: x.items, tokens: x.tokensEst, leftOff: x.leftOff }));
  // The session-start hint, as Snout logged it (its text names no record; the handoff check saw it reach both agents).
  step.hint = rows.some((x) => x.kind === "hint") || undefined;
  step.hookRows = step.session ? hookRows(snoutDir, step.session) : 0;
  // Each tool call Snout's hooks should see, against their heartbeats (Codex: each shell command).
  if (arm !== "plain" && step.session) {
    const beats = lines(join(snoutDir, "hooks.jsonl")).map((l) => JSON.parse(l)).filter((h) => h.session === step.session);
    step.hooks = AGENT === "codex" ? codexHookCoverage(step.commands, beats) : hookCoverage(uses, beats);
  }
  step.side = snoutSideCalls(lines(sideLog).slice(sideBefore));
  git(t, "add", "-A");
  step.patch = git(t, "diff", "--cached", "HEAD").stdout;
  git(t, "reset", "-q");
  Object.assign(step, step.patch.trim() ? scoreStep(step, grade(t)) : { resolved: false });
  row.steps.push(step);
  inFlight = null;
  onStep(row);
  // Validity, per the protocol: memory reaches only `memory`; Snout runs in every arm that has it.
  if (arm !== "memory" && step.notes.length) row.invalid = `notes reached the ${arm} arm (${t.id})`;
  // Memory search reaches only `search`: no other arm has the server.
  if (arm !== "search" && step.memoryCalls?.length) row.invalid = `memory search reached the ${arm} arm (${t.id})`;
  if (arm !== "search" && step.hint) row.invalid = `the session-start hint reached the ${arm} arm (${t.id})`;
  if (arm !== "search" && step.memory) row.invalid = `Snout's memory tools answered in the ${arm} arm (${t.id})`;
  // Snout ran in the arm's mode: a session's judged records in trim or memory are enforce rows.
  if (arm !== "plain" && step.session) {
    const ledger = lines(join(snoutDir, "ledger.jsonl")).filter((l) => l.includes(`"session":"${step.session}"`)).map((l) => JSON.parse(l));
    const modes = modeProblems(ledger);
    if (modes.length) row.invalid = `Snout ran in ${modes.join("/")} mode in the ${arm} arm (${t.id})`;
  }
  if ((arm !== "plain" || AGENT === "codex") && step.session && !step.hookRows) { row.invalid = `Snout's hooks did not run (${t.id})`; return; }
  // No Snout-side model, embedding, cloud or network call in any arm, and the watch must have seen Snout run.
  const side = [...step.side.network, ...step.side.jev, ...step.side.cloud, ...step.side.embedding];
  if (side.length) { row.invalid = `Snout made a side call (${t.id}): ${side.slice(0, 3).join("; ")}`; return; }
  if ((arm !== "plain" || AGENT === "codex") && step.session && !step.side.processes) { row.invalid = `the side-call watch did not load in Snout's hooks (${t.id})`; return; }
  if (arm === "plain" && AGENT === "claude" && step.side.processes) { row.invalid = `Snout ran in the plain arm (${t.id})`; return; }
  if (!step.session) { row.invalid = `${t.id}: no session (${step.error ?? r.stderr?.slice(0, 200) ?? "?"})`; return; }
  if (API_REFUSED.test(step.error ?? "")) { row.invalid = `${t.id}: ${step.error}`; return; }
}

/** One repeat: every arm's chain, interleaved by task (armOrder, bench/study-checks.mjs). */
async function runRepeat(tasks, rep, rows, save) {
  const chains = ARMS.map((arm) => openChain(arm, rep));
  rows.push(...chains.map((c) => c.row));
  const spent = () => rows.reduce((a, r) => a + r.steps.reduce((x, s) => x + s.costUsd, 0), 0);
  const sessions = () => rows.reduce((a, r) => a + r.steps.length, 0);
  let stop = null;
  try {
    for (const [i, t] of tasks.entries()) {
      // A task's group starts only if all its arms fit the cap at the costliest session so far (bench/memory-pilot.json "spend").
      const costliest = Math.max(0, ...rows.flatMap((r) => r.steps.map((s) => s.costUsd ?? 0)));
      if (PILOT && MAX_SPEND && !groupFits(spent(), costliest, ARMS.length, MAX_SPEND)) {
        stop = `the next group (${t.id}) would pass --max-spend $${MAX_SPEND} at $${costliest.toFixed(3)} a session`;
        for (const c of chains) c.row.capped = stop;
        break;
      }
      for (const arm of armOrder(ARMS, rep, i)) {
        const chain = chains.find((c) => c.arm === arm);
        if (MAX_SPEND && spent() >= MAX_SPEND) { chain.row.capped = stop = `--max-spend $${MAX_SPEND} reached`; break; }
        if (MAX_SESSIONS && sessions() >= MAX_SESSIONS) { chain.row.capped = stop = `--max-sessions ${MAX_SESSIONS} reached`; break; }
        await runStep(chain, t, save);
        save();
        const s = chain.row.steps.at(-1);
        if (s) process.stderr.write(`${t.id} · ${arm} · rep ${rep}: ${s.resolved ? "solved" : "not solved"} · $${s.costUsd.toFixed(3)}${chain.row.invalid ? ` · INVALID ${chain.row.invalid}` : ""}\n`);
        if (chain.row.invalid) { stop = "invalid"; break; }
      }
      if (stop) break;
    }
  } finally {
    for (const c of chains) closeChain(c);
    save();
  }
  return stop;
}

// ---------- Report ----------

const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

/** Paired by task: cost per solved task ratio (arm / base) and solved-fraction difference, bootstrap over tasks then repeats. */
function compare(rows, base, arm, B = 2000) {
  const by = (a) => {
    const m = new Map();
    for (const r of rows.filter((x) => x.arm === a && !x.invalid)) for (const s of r.steps) { if (!m.has(s.task)) m.set(s.task, []); m.get(s.task).push(s); }
    return m;
  };
  const A = by(base), C = by(arm);
  const tasks = [...A.keys()].filter((k) => C.has(k));
  if (!tasks.length) return null;
  const stat = (pick) => {
    let costA = 0, costC = 0, solA = 0, solC = 0, dsum = 0;
    for (const k of tasks) {
      const a = pick(A.get(k)), c = pick(C.get(k));
      costA += a.reduce((x, s) => x + s.costUsd, 0); costC += c.reduce((x, s) => x + s.costUsd, 0);
      const fa = a.filter((s) => s.resolved).length / a.length, fc = c.filter((s) => s.resolved).length / c.length;
      solA += a.filter((s) => s.resolved).length; solC += c.filter((s) => s.resolved).length; dsum += fc - fa;
    }
    return { ratio: solA && solC ? (costC / solC) / (costA / solA) : NaN, diff: dsum / tasks.length };
  };
  const point = stat((xs) => xs);
  // A seeded generator, so the interval is the same every time the file is summarized.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ratios = [], diffs = [];
  for (let b = 0; b < B; b++) {
    const draw = tasks.map(() => tasks[Math.floor(rnd() * tasks.length)]);
    let costA = 0, costC = 0, solA = 0, solC = 0, dsum = 0;
    for (const k of draw) {
      const ra = A.get(k), rc = C.get(k);
      const a = ra.map(() => ra[Math.floor(rnd() * ra.length)]), c = rc.map(() => rc[Math.floor(rnd() * rc.length)]);
      costA += a.reduce((x, s) => x + s.costUsd, 0); costC += c.reduce((x, s) => x + s.costUsd, 0);
      solA += a.filter((s) => s.resolved).length; solC += c.filter((s) => s.resolved).length;
      dsum += c.filter((s) => s.resolved).length / c.length - a.filter((s) => s.resolved).length / a.length;
    }
    if (solA && solC) ratios.push((costC / solC) / (costA / solA));
    diffs.push(dsum / draw.length);
  }
  const lost = [];
  for (const k of tasks) for (const c of C.get(k)) {
    const sameRep = A.get(k).find((a) => rows.find((r) => r.steps.includes(a))?.rep === rows.find((r) => r.steps.includes(c))?.rep);
    if (!c.resolved && sameRep?.resolved) lost.push(`${k} (rep ${rows.find((r) => r.steps.includes(c))?.rep})`);
  }
  return { tasks: tasks.length, ...point, ratioCI: [quantile(ratios, 0.025), quantile(ratios, 0.975)], diffLower: quantile(diffs, 0.05), lost };
}

/** One agent's runs on several repositories (the pilot: Hugo and vite), read as one: tasks differ, so pairs stay within a repository. */
function pooled(files) {
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  if (runs.length === 1) return runs[0];
  if (new Set(runs.map((r) => `${r.agent} ${r.model} ${r.pilot ?? ""}`)).size > 1) throw new Error("pool only one agent's runs of the same pilot");
  return { ...runs[0], repo: runs.map((r) => r.repo).join(" + "), tasks: runs.flatMap((r) => r.tasks), rows: runs.flatMap((r) => r.rows), inFlight: runs.find((r) => r.inFlight)?.inFlight ?? null };
}

function summarize(saved) {
  const rows = saved.rows;
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  console.log(`\nMemory study · ${saved.agent} ${saved.model} · ${saved.repo} · ${saved.tasks.length} tasks · ${saved.repeats} repeat(s)${saved.agent === "codex" ? " · cost is the list-price equivalent of Codex's tokens" : ""}\n`);
  // Rescanned with the current rules, so an older file reports what they find.
  for (const r of rows) for (const s of r.steps) s.network = networkCommands(s.commands ?? []);
  // Claude Code sessions are repriced from their transcripts at the current list prices (bench/swelong.mjs).
  let repriced = 0;
  if (saved.agent === "claude") for (const r of rows) for (const s of r.steps) {
    const f = s.session ? transcriptFacts(s.session) : null;
    if (f && Math.abs(f.costUsd - s.costUsd) > 1e-9) { s.costUsd = f.costUsd; repriced++; }
  }
  if (repriced) console.log(`  ${repriced} session(s) repriced from their transcripts at current list prices\n`);
  const tokensOf = (s) => (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0);
  console.log("  arm      rep   solved      cost    $/solved      tokens   notes in   network cmds   invalid");
  for (const r of rows) {
    // From the steps, so a chain cut short by a killed run still adds up.
    const solved = r.steps.filter((s) => s.resolved).length, cost = r.steps.reduce((a, s) => a + s.costUsd, 0);
    const notes = r.steps.reduce((a, s) => a + s.notes.reduce((x, n) => x + (n.tokens ?? 0), 0), 0);
    console.log(`  ${r.arm.padEnd(7)} ${String(r.rep).padStart(3)}   ${`${solved}/${r.steps.length}`.padStart(6)}   $${cost.toFixed(3).padStart(7)}   ${solved ? `$${(cost / solved).toFixed(3)}` : "    n/a"}   ${String(r.steps.reduce((a, s) => a + tokensOf(s), 0)).padStart(9)}   ${String(notes).padStart(6)} tok   ${String(r.steps.reduce((a, s) => a + s.network.length, 0)).padStart(12)}   ${r.invalid ?? ""}`);
  }
  // The search arm: which sessions got the session-start hint, and which searched (tasks oldest first).
  for (const r of rows.filter((x) => x.arm === "search")) {
    const searched = r.steps.filter((s) => s.memoryCalls?.length);
    console.log(`\n  search, rep ${r.rep}: hint in ${r.steps.filter((s) => s.hint).length} of ${r.steps.length} sessions; searched in ${searched.length} (${searched.map((s) => `${s.task}: ${s.memoryCalls.join(", ")}`).join("; ") || "none"})`);
  }
  // Below this many tasks a bootstrap over tasks has too few to draw from; no interval is shown.
  const MIN_TASKS_FOR_INTERVAL = 10;
  for (const [base, arm] of [["plain", "trim"], ["plain", "memory"], ["trim", "memory"], ["plain", "search"], ["trim", "search"]]) {
    const c = compare(rows, base, arm);
    if (!c) continue;
    console.log(`\n  ${arm} vs ${base} (${c.tasks} tasks, paired)`);
    if (c.tasks < MIN_TASKS_FOR_INTERVAL) {
      console.log(`    cost per solved task  ${Number.isFinite(c.ratio) ? `×${c.ratio.toFixed(3)}` : "n/a (an arm solved none)"}  (no interval: fewer than ${MIN_TASKS_FOR_INTERVAL} tasks; not a result)`);
      console.log(`    solved fraction       ${c.diff >= 0 ? "+" : ""}${pct(c.diff)}`);
    } else {
      console.log(`    cost per solved task  ×${c.ratio.toFixed(3)}  95% CI ×${c.ratioCI[0]?.toFixed(3)} to ×${c.ratioCI[1]?.toFixed(3)}${c.ratioCI[1] < 1 ? "  (saving: whole interval below 1)" : ""}`);
      console.log(`    solved fraction       ${c.diff >= 0 ? "+" : ""}${pct(c.diff)}  one-sided 95% lower bound ${pct(c.diffLower)}${c.diffLower > -0.10 ? "  (within the 10-point margin)" : "  (crosses the 10-point margin)"}`);
    }
    console.log(`    tasks ${arm} failed that ${base} solved: ${c.lost.length ? c.lost.join(", ") : "none"}`);
  }
  const covered = rows.flatMap((r) => r.steps.filter((s) => s.hooks));
  if (covered.length) {
    const calls = saved.agent === "codex" ? "shell commands" : "tool calls";
    const short = rows.flatMap((r) => r.steps.filter((s) => s.hooks && (s.hooks.missing || !s.hooks.started || !s.hooks.prompted)).map((s) => `${r.arm}/${s.task} (${s.hooks.expected - s.hooks.missing} of ${s.hooks.expected} ${calls}${s.hooks.started ? "" : ", no session start"}${s.hooks.prompted ? "" : ", no prompt"})`));
    const expected = covered.reduce((a, s) => a + s.hooks.expected, 0), missed = covered.reduce((a, s) => a + s.hooks.missing, 0);
    console.log(`\n  Snout's hooks: saw ${expected - missed} of ${expected} ${calls} in ${covered.length} sessions${short.length ? `; short: ${short.join(", ")}` : ", none missed"}`);
  }
  const limited = rows.flatMap((r) => r.steps.filter((s) => s.limitHit).map((s) => `${r.arm}/${s.task} (${s.limitHit} limit${s.gradedResolved ? "; its patch would have passed" : ""})`));
  if (limited.length) console.log(`\n  attempted, not solved, limit hit: ${limited.join(", ")}`);
  const mismatched = rows.flatMap((r) => r.steps.map((s) => [r, s, costMismatch(s.costUsd, s.cliCostUsd)]).filter(([, , m]) => m).map(([r, s, m]) => `${r.arm}/${s.task}: transcript $${m.transcriptUsd.toFixed(4)}, Claude Code $${m.cliUsd.toFixed(4)}`));
  if (mismatched.length) console.log(`\n  cost differs from Claude Code's own figure by more than 2%:\n    ${mismatched.join("\n    ")}`);
  // A session the run started but never recorded (the run was killed): its spend still counts.
  const interrupted = [];
  if (saved.inFlight) {
    const f = saved.inFlight.session ? transcriptFacts(saved.inFlight.session) : null;
    interrupted.push({ ...saved.inFlight, costUsd: f?.costUsd ?? 0 });
    console.log(`\n  interrupted: ${saved.inFlight.arm}/${saved.inFlight.task}, started ${saved.inFlight.started}, never graded; ${f ? `$${f.costUsd.toFixed(4)} from its transcript, counted in spend, not scored` : saved.inFlight.session ? "transcript not found (an API run is summarized with --api)" : "cost unknown (no session id before it started)"}`);
  }
  if (saved.agent === "claude") console.log(`\n  spend: $${spentUsd(rows, interrupted).toFixed(3)}${interrupted.length ? " including the interrupted session" : ""}`);
  // The pilot's frozen go/no-go (bench/study-checks.mjs pilotVerdict), on both repositories together.
  if (saved.pilot) {
    const v = pilotVerdict(rows, undefined, JSON.parse(readFileSync(PILOT_FILE, "utf8")).labels);
    const line = (name, c) => `    ${name.padEnd(36)} ${c.arm.solved}/${c.arm.sessions} vs ${c.base.solved}/${c.base.sessions} solved, $/solved ${Number.isFinite(c.arm.perSolved) ? c.arm.perSolved.toFixed(3) : "n/a"} vs ${Number.isFinite(c.base.perSolved) ? c.base.perSolved.toFixed(3) : "n/a"}, tokens/solved ${Number.isFinite(c.arm.tokensPerSolved) ? c.arm.tokensPerSolved.toLocaleString("en-US") : "n/a"} vs ${Number.isFinite(c.base.tokensPerSolved) ? c.base.tokensPerSolved.toLocaleString("en-US") : "n/a"}: ${c.pass ? "PASS" : "no"}`;
    console.log(`
  Gate 4 pilot verdict (${saved.repo})${v.valid ? "" : `: none, ${v.why}`}`);
    if (v.valid) {
      for (const [name, c] of [["memory adds value (search vs trim)", v.memory], ["complete workflow (search vs plain)", v.workflow], ["trimming (trim vs plain)", v.trimming]]) console.log(line(name, c));
      console.log(`    memory use (search arm, reported): searched in ${v.use.searched} of ${v.use.sessions} sessions, opened a record in ${v.use.opened}, acted on one in ${v.use.actedOn}; ${v.use.emptySearches} search(es) found nothing`);
      console.log(`    wrong recalls: ${v.wrongRecalls.length ? v.wrongRecalls.map((w) => `${w.task} (${w.records.join(", ")})`).join("; ") : "none"}`);
      for (const [label, arms] of Object.entries(v.byLabel)) console.log(`    ${label.padEnd(9)} ${Object.entries(arms).map(([a, x]) => `${a} ${x.solved}/${x.sessions} $${x.costUsd.toFixed(3)}`).join(" · ")}`);
      console.log("    memory path (search arm): task, label, hint → search → labeled record shown → opened → acted on → result");
      for (const p of v.path) console.log(`      ${p.task.padEnd(11)} ${p.label.padEnd(9)} ${p.from.length ? `(from ${p.from.join(", ")}) ` : ""}${p.reached}; opened ${p.opened.join(", ") || "none"}; ${p.resolved ? "solved" : "not solved"} · $${p.costUsd.toFixed(3)} · memory ${p.memoryTokens} tok`);
      console.log(`    next: ${v.diagnosis}`);
    }
  }
  const net = rows.flatMap((r) => r.steps.flatMap((s) => s.network.map((c) => `${r.arm}/${s.task}: ${c.slice(0, 100)}`)));
  if (net.length) console.log(`\n  network use found in commands:\n    ${net.join("\n    ")}`);
  const steps = rows.flatMap((r) => r.steps);
  const sum = (f) => steps.reduce((a, s) => a + (s.side ? f(s.side) : 0), 0);
  const watched = steps.filter((s) => s.side).length;
  if (watched) {
    const spawned = {};
    for (const s of steps) for (const [k, n] of Object.entries(s.side?.spawned ?? {})) spawned[k] = (spawned[k] ?? 0) + n;
    console.log(`\n  Snout side calls (${watched} sessions watched, ${sum((x) => x.processes)} Snout processes): Jev ${sum((x) => x.jev.length)}, cloud ${sum((x) => x.cloud.length)}, embedding model ${sum((x) => x.embedding.length)}, other network ${sum((x) => x.network.length)}, local connections ${sum((x) => x.local)}`);
    if (Object.keys(spawned).length) console.log(`  processes Snout started: ${Object.entries(spawned).map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  }
}

// ---------- Main ----------

/** --grade-check: no agent. In each prepared workspace, an unrelated edit must grade unsolved and the reference fix solved. */
function gradeCheck(tasks) {
  let ok = true;
  for (const t of tasks) {
    prepare(t);
    reset(t);
    appendFileSync(join(wsOf(t), GO ? "doc.go" : "README.md"), GO ? "\n// unrelated edit\n" : "\nunrelated edit\n");
    const wrong = grade(t);
    reset(t);
    must(git(t, "apply", "--whitespace=nowarn", fakePatch(t)), "apply the reference fix");
    const right = grade(t);
    reset(t);
    const fine = !wrong.resolved && wrong.f2pFailed?.length > 0 && right.resolved;
    ok &&= fine;
    console.log(`  ${fine ? "ok  " : "FAIL"} ${t.id}: unrelated edit ${wrong.resolved ? "SOLVED" : `unsolved (${wrong.f2pFailed?.length ?? "?"} fail-to-pass failing)`}${wrong.gradeError ? ` ${wrong.gradeError}` : ""}; reference fix ${right.resolved ? "solved" : `UNSOLVED ${right.gradeError ?? ""} f2p ${right.f2pFailed?.length} p2p ${right.p2pFailed?.length}`}`);
  }
  if (!ok) process.exit(1);
}

async function main() {
  if (typeof args.summarize === "string") return summarize(pooled(args.summarize.split(",")));
  if (args.freeze) return writeFreeze();
  if (!spec) throw new Error("--tasks <validated tasks file>");
  if (args["grade-check"]) {
    mkdirSync(WS_ROOT, { recursive: true });
    mkdirSync(GIT_ROOT, { recursive: true });
    return gradeCheck(studyTasks());
  }
  const tasks = studyTasks().sort((a, b) => a.merged.localeCompare(b.merged));
  if (!tasks.length) throw new Error(`no validated tasks in ${TASKS_FILE}`);
  if (!FAKE && AGENT === "claude" && !MAX_SPEND) throw new Error("--max-spend is required for a paid Claude Code run");
  const cap = PILOT?.maxSpendUsdPerTasksFile?.[AGENT];
  if (!FAKE && cap && MAX_SPEND > cap) throw new Error(`the pilot caps a Claude Code run at $${cap} per tasks file`);
  const frozen = frozenBuild();
  const runId = `memory-study-${AGENT}-${NAME}-${Date.now()}`;
  const outFile = join(REPO, "bench/ab-results", `${runId}.json`);
  mkdirSync(join(REPO, "bench/ab-results"), { recursive: true });
  mkdirSync(WS_ROOT, { recursive: true });
  mkdirSync(GIT_ROOT, { recursive: true });
  const rows = [];
  const versions = { claude: FAKE ? "stand-in" : AGENT === "claude" ? frozen.claudeCode : undefined, codex: AGENT === "codex" ? (FAKE ? "stand-in" : sh("codex", ["--version"], { shell: process.platform === "win32" }).stdout.trim()) : undefined, node: process.version, ...(AGENT === "codex" ? { codexEffort: EFFORT, codexUserConfig: FAKE ? undefined : codexUserConfig() } : {}) };
  if (!FAKE) checkFreeze(AGENT === "codex" ? versions.codex : versions.claude);
  const save = () => writeFileSync(outFile, JSON.stringify({ runId, agent: AGENT, model: MODEL, repo: spec.repo, tasksFile: TASKS_FILE.replace(REPO, "").replace(/^[\\/]/, ""), tasks: tasks.map((t) => t.id), arms: ARMS, repeats: REPEATS, ...(PILOT ? { pilot: createHash("sha256").update(readFileSync(PILOT_FILE)).digest("hex") } : {}), interleaved: true, budget: BUDGET, limitMinutes: LIMIT_MS / 60000, measuredAt: new Date().toISOString(), ...stamp(), frozen, versions, rows, inFlight }, null, 2));
  console.error(`${ARMS.length} arms × ${REPEATS} repeat(s) × ${tasks.length} tasks = ${ARMS.length * REPEATS * tasks.length} sessions, ${AGENT} ${MODEL} → ${outFile}`);
  for (let rep = 0; rep < REPEATS; rep++) {
    const stop = await runRepeat(tasks, rep, rows, save);
    if (stop) { console.log(`\nSessions: ${outFile}`); summarize(JSON.parse(readFileSync(outFile, "utf8"))); process.exit(stop === "invalid" ? 2 : 0); }
  }
  console.log(`\nSessions: ${outFile}`);
  summarize(JSON.parse(readFileSync(outFile, "utf8")));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(1); });
