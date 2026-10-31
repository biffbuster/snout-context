#!/usr/bin/env node
/**
 * The cross-agent handoff check (bench/handoff/spec.json): one agent does a piece of work and
 * verifies it; the other agent, in a fresh session on the result, gets a related task twice from the
 * same snapshot: with Snout's search and fetch (on), then with no Snout (off). Both directions:
 * Claude Code to Codex, Codex to Claude Code. Two small projects written for this check
 * (bench/handoff/berthbook, bench/handoff/depotclock), none of the pilot's held-out tasks.
 *
 *   node bench/handoff-check.mjs --grade-check                 # free: the references pass, the unchanged projects fail
 *   node bench/handoff-check.mjs --freeze                      # bench/handoff/freeze.json: what a run must match
 *   SWE_FAKE_AGENT=1 node bench/handoff-check.mjs --allow-dirty   # free dry run with the stand-in agents
 *   node bench/handoff-check.mjs --api --max-spend 6 --allow-dirty   # 6 sessions: 3 Claude Code (API), 3 Codex (plan)
 *   node bench/handoff-check.mjs --summarize <results file>
 *
 * A spec with "lessons": true (spec-lesson.json) also tests the lesson loop (src/memory/review.ts):
 * the on arm gets snout_memory_propose and the memory skill, and each direction stops after its
 * giver so a person reviews what the giver proposed before any receiver runs:
 *   node bench/handoff-check.mjs --spec spec-lesson.json --review <results file>                  # the proposals, every field
 *   node bench/handoff-check.mjs --spec spec-lesson.json --review <results file> approve <id>     # or reject, edit, show
 *   node bench/handoff-check.mjs --spec spec-lesson.json --resume <results file> [--max-spend 3]  # the receivers, then the next direction
 *   SWE_FAKE_AGENT=1 node bench/handoff-check.mjs --spec spec-lesson.json --experimental-notes --allow-dirty  # optional stand-in diagnostic only
 *
 * The receiver's prompt never names the answer or asks for Snout. What is scored comes from the MCP
 * server's own traffic (bench/handoff-mcp-tap.mjs), so both agents are scored on what they were shown.
 * Other ways the answer could reach a receiver are closed and checked: Claude Code's and Codex's own
 * memories, Snout's automatic notes, instruction files, the giver's git history, and this repository.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { armSettings, launchClaude, frozenBuild, REPO, SNOUT_BIN, FAKE, CLEAN_HOME, API_REFUSED } from "./swe.mjs";
import { shippedClaudeHooks } from "./shipped-hooks.mjs";
import { transcriptFacts } from "./swelong.mjs";
import { stamp } from "./stamp.mjs";
import { codexToolchainEnv, removeSandboxed } from "./codex-toolchain.mjs";
import { networkCommands, modeProblems, armProblems, hookCoverage, codexHookCoverage } from "./study-checks.mjs";

const { gateEntries, squeezeEntries, MEMORY_SKILL, storesFor, lessons: lessonsIn, approved: approvedLesson } = await import(pathToFileURL(join(REPO, "dist/lib.mjs")).href);
const { snoutSideCalls } = createRequire(import.meta.url)("./snout-guard.cjs");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const HERE = join(REPO, "bench", "handoff");
// --spec picks a check (spec.json, the first; spec-record.json, a decision only in the record); each has its own freeze and results.
const SPEC_FILE = join(HERE, typeof args.spec === "string" ? args.spec : "spec.json");
const SPEC_TAG = basename(SPEC_FILE, ".json").replace(/^spec/, "");
const SPEC = JSON.parse(readFileSync(SPEC_FILE, "utf8"));
const S = SPEC.settings;
const BUDGET = S.budgetUsd;
const LIMIT_MS = S.limitMinutes * 60_000;
const MAX_SPEND = args["max-spend"] ? Number(args["max-spend"]) : 0;
const HOME = homedir();
const BIN_DIR = join(HOME, ".snout-bench", "bin");
const TAP = join(REPO, "bench", "handoff-mcp-tap.mjs");
const GUARD = join(REPO, "bench", "snout-guard.cjs");
const FREEZE_FILE = join(HERE, `freeze${SPEC_TAG}.json`);
/** gpt-6.1-sol list prices per million tokens (as bench/memory-study.mjs): input, cached input, output. */
const CODEX_PRICE = { input: 2, cached: 0.1, output: 10 };
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, ".codex");
const CODEX_JS = process.env.CODEX_CLI_JS || [join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js")].find(existsSync);

const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 256 << 20, timeout: 600_000, ...opts });
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || "").slice(-400)}`); return r; };
const lines = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const rows = (file) => lines(file).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const OFFLINE = { npm_config_offline: "true", npm_config_prefer_offline: "true", COREPACK_ENABLE_NETWORK: "0", GOPROXY: "off", GOTOOLCHAIN: "local", PIP_NO_INDEX: "1" };
const pathWith = (dir) => `${dir}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;

// ---------- Arms (as bench/memory-study.mjs) ----------

const OFF = { coach: "off", memoryJudge: "off", memoryLessons: false, repoMap: false, fastHooks: false };
const armConfig = (arm) => (arm === "plain" ? { mode: "observe", memory: false, memoryNotes: false, ...OFF } : { mode: "enforce", memory: true, memoryNotes: arm === "notes", ...OFF });
const SEARCH_TOOLS = ["snout_memory_search", "snout_memory_fetch"];
/** A lesson spec's on arm can also propose; anything else is the pilot's search arm. */
const LESSONS = SPEC.lessons === true;
/**
 * `"ownMemory": "claude"` (spec-decision.json): Claude Code's own memory stays on in every arm, as a
 * user has it, so "off" means plain Claude Code rather than no memory at all. Its memory is kept per
 * project folder, so every Claude Code session of a direction runs in one folder (the snapshot put back
 * between sessions), and each receiver starts from the memory the giver left: what one receiver writes
 * never reaches the other. A live run needs an isolated config (--plan or --api), so nothing is written
 * to the operator's own ~/.claude. Codex keeps its usual setup: its memories live in the operator's
 * own Codex home, which a run may not copy.
 */
const OWN_MEMORY = SPEC.ownMemory === "claude";
// Fresh safety sets still found unrelated automatic lessons. Keep the notes-on receiver out of
// live paid runs until the delivery design passes a new frozen safety check.
if (args["experimental-notes"] && !FAKE) throw new Error("Automatic lesson delivery is not cleared for a live run; --experimental-notes is stand-in only.");
const NOTES_ARM = LESSONS && FAKE && args["experimental-notes"] === true;
/** The memory tools and skill as the product ships them: a lesson spec, or `"skill": true` without the review stop (spec-decision.json). */
const SHIPPED = LESSONS || SPEC.skill === true;
const MEMORY_TOOLS = SHIPPED ? [...SEARCH_TOOLS, "snout_memory_propose"] : SEARCH_TOOLS;
const DISALLOWED = ["WebFetch", "WebSearch", ...["curl", "wget", "gh", "git fetch", "git pull", "git clone", "git push", "npm install", "npm i", "npm add", "pnpm install", "pnpm i", "pnpm add", "pip install", "go get", "go install", "go mod download", "taskkill", "cmd", "powershell", "pwsh", "pkill", "killall", "Invoke-WebRequest"].map((c) => `Bash(${c}:*)`)];
/** What is not the project: agents' and tools' own folders. Never copied into a snapshot or a grading copy. */
const ARTIFACTS = new Set([".git", ".claude", ".codex", ".agents", ".snout", ".mcp.json", "__pycache__", ".pytest_cache", ".gocache", "node_modules"]);

/** Snout's MCP server with the search tools only, behind the tap that logs its traffic. */
const searchServer = (w, env, tapLog) => ({
  command: process.execPath,
  args: [TAP, tapLog, SNOUT_BIN, "mcp", w.ws, "--tools", MEMORY_TOOLS.join(",")],
  env: { ...Object.fromEntries(["SNOUT_DIR", "SNOUT_CONFIG_DIR", "SNOUT_GUARD_LOG", "NODE_OPTIONS", "SNOUT_MEMORY", "SNOUT_MEMORY_NOTES"].map((k) => [k, env[k] ?? ""])), ...ownProject(w) },
});
/**
 * A Codex workspace sits inside this checkout (Codex trusts it there) with its repository kept
 * outside. Snout would take this checkout (the nearest folder above with a .snout/) as the project,
 * and git would find this repository. Declaring the workspace as the project (CLAUDE_PROJECT_DIR,
 * which Snout reads for any agent) and pointing git at its own repository, for the session and the
 * server, makes the folder its own project as on a user's machine: Snout records paths and the branch
 * from it and keys its notes by its remote, the same project as the other agent's workspace; and the
 * agent's own git commands show the project, not this repository. Codex finds its trusted root by the
 * folders above.
 */
const ownProject = (w) => (w.agent === "codex" ? { CLAUDE_PROJECT_DIR: w.ws, GIT_DIR: w.gitDir, GIT_WORK_TREE: w.ws } : {});
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(",")}]` : typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(",")}}` : `'${String(v)}'`);

/** A Snout store for one session or more: its records folder, config folder and the side-call log. */
function newStore(dir, arm, from) {
  const snoutDir = join(dir, "snout"), configDir = join(dir, "config");
  if (from) { cpSync(from.snoutDir, snoutDir, { recursive: true }); cpSync(from.configDir, configDir, { recursive: true }); }
  mkdirSync(snoutDir, { recursive: true }); mkdirSync(configDir, { recursive: true });
  const config = armConfig(arm);
  // This check's notes arm has both the prompt notes and the search tools. The study's
  // memory arm intentionally has no search hint, so its shared validator has different rules.
  const wrong = arm === "notes"
    ? (config.mode === "enforce" && config.memory === true && config.memoryNotes === true ? [] : ["notes arm lacks enforce, memory, or automatic notes"])
    : armProblems(arm, config);
  if (wrong.length) throw new Error(`arm config: ${wrong.join("; ")}`);
  writeFileSync(join(snoutDir, "config.json"), JSON.stringify(config) + "\n");
  const sideLog = join(dir, "side-calls.jsonl");
  const env = { SNOUT_DIR: snoutDir, SNOUT_CONFIG_DIR: configDir, SNOUT_MEMORY: "", SNOUT_MEMORY_NOTES: "", TYPESAFE_API_KEY: "", SNOUT_CLOUD_URL: "", SNOUT_EMBED_FAKE: "",
    SNOUT_GUARD_LOG: sideLog, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(GUARD)}`].filter(Boolean).join(" ") };
  return { dir, snoutDir, configDir, sideLog, env, arm };
}

// ---------- Workspaces ----------

/**
 * Copies a project without agents' and tools' folders. A file or folder the operator cannot read (a
 * Codex session's Python can leave folders private to the sandbox user) is left out and returned, so a
 * caller can tell a complete copy from one that is not.
 */
function copyProject(from, to) {
  const unreadable = [];
  cpSync(from, to, { recursive: true, filter: (s) => {
    if (ARTIFACTS.has(basename(s))) return false;
    try { if (statSync(s).isDirectory()) readdirSync(s); else closeSync(openSync(s, "r")); return true; } catch { unreadable.push(relative(from, s).replace(/\\/g, "/")); return false; }
  } });
  return unreadable;
}

/**
 * A fresh workspace holding `from` as one baseline commit, named after the project with a random
 * suffix (no "giver" or "off" in a path an agent sees). Claude Code works outside this repository so
 * none of its instruction files load; Codex runs project hooks only in a folder its user trusts, so
 * its workspaces live in this checkout under .snout/handoff-ws, with the repository kept outside.
 */
function newWorkspace(agent, d, from, { fixed = false } = {}) {
  // fixed: the direction's one Claude Code folder (OWN_MEMORY), made again from `from` each time.
  const name = `${d.project}-${fixed ? createHash("sha256").update(d.id).digest("hex").slice(0, 6) : randomBytes(3).toString("hex")}`;
  const ws = agent === "codex" ? join(REPO, ".snout", "handoff-ws", name) : join(HOME, ".snout-bench", "handoff-ws", name);
  if (fixed) rmSync(ws, { recursive: true, force: true });
  const gitDir = agent === "codex" ? join(HOME, ".snout-bench", "handoff-git", `${name}.git`) : join(ws, ".git");
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(gitDir, ".."), { recursive: true });
  copyProject(from, ws);
  const git = (...a) => sh("git", ["--git-dir", gitDir, "--work-tree", ws, "-c", "user.name=bench", "-c", "user.email=bench@localhost", ...a], { cwd: ws });
  must(sh("git", ["init", "-q", ...(agent === "codex" ? ["--separate-git-dir", gitDir] : [])], { cwd: ws }), "git init");
  if (agent === "codex") rmSync(join(ws, ".git"), { force: true });
  git("config", "core.autocrlf", "false");
  git("config", "core.filemode", "false");
  appendFileSync(join(gitDir, "info", "exclude"), "\n/.claude/\n/.codex/\n/.snout/\n/.mcp.json\n__pycache__/\n.pytest_cache/\n");
  must(git("add", "-A"), "git add");
  // A stand-in dry run needs file state, not Git history. Keep it commit-free;
  // live agents get the normal baseline commit when that action is authorized.
  if (!FAKE) must(git("commit", "-q", "--no-verify", "-m", "baseline"), "baseline commit");
  // A remote, as any clone has: Snout keys a project's private notes by it.
  git("remote", "add", "origin", d.remote);
  return { agent, name, ws, gitDir, git };
}

// ---------- Grading ----------

/**
 * A copy of the work with the project's original test files restored and the hidden tests added:
 * the giver's for a giver; the giver's and the receiver's for a receiver. Run in the copy, so the
 * workspace (and so the snapshot) never holds a hidden test.
 */
function grade(d, from, role, runDir) {
  const dir = join(runDir, "grade", `${basename(from)}-${role}`);
  rmSync(dir, { recursive: true, force: true });
  const unreadable = copyProject(from, dir);
  for (const f of d.grade.baseTests) { mkdirSync(join(dir, f, ".."), { recursive: true }); cpSync(join(HERE, d.project, "base", f), join(dir, f)); }
  const hidden = [...d.grade.giverTests, ...(role === "receiver" ? d.grade.receiverTests : [])];
  for (const h of hidden) cpSync(join(HERE, d.project, h), join(dir, d.grade.testDir, basename(h)));
  const files = [...d.grade.baseTests.filter((f) => !f.endsWith("conftest.py")), ...hidden.map((h) => `${d.grade.testDir}/${basename(h)}`)];
  const env = { ...process.env, ...OFFLINE, PYTHONDONTWRITEBYTECODE: "1" };
  const r = d.grade.runner === "pytest"
    ? sh("python", ["-m", "pytest", "-q", "-rA", "-p", "no:cacheprovider", ...files], { cwd: dir, env })
    : sh(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = d.grade.runner === "pytest"
    ? [...out.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1])
    : [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  rmSync(dir, { recursive: true, force: true });
  return { solved: r.status === 0 && unreadable.length === 0, failed, tail: r.status === 0 ? undefined : out.slice(-600), ...(unreadable.length ? { unreadable } : {}) };
}

// ---------- Sessions ----------

function setClaudeArm(ws, arm, store, tapLog) {
  if (arm === "plain") return armSettings(ws, "plain");
  const hooks = shippedClaudeHooks(REPO, SNOUT_BIN);
  hooks.PreToolUse = gateEntries(SNOUT_BIN);
  hooks.PostToolUse = [...(hooks.PostToolUse ?? []), ...squeezeEntries(SNOUT_BIN)];
  mkdirSync(join(ws, ".claude"), { recursive: true });
  writeFileSync(join(ws, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2));
  writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { snout: searchServer({ agent: "claude", ws }, store.env, tapLog) } }));
}

function runClaude(w, text, store, arm, session, tapLog, fake) {
  setClaudeArm(w.ws, arm, store, tapLog);
  const argv = [
    "-p", text, "--output-format", "json", "--model", S.claudeModel, "--session-id", session, "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", join(w.ws, ".mcp.json"), "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "Bash", ...(arm !== "plain" ? MEMORY_TOOLS.map((n) => `mcp__snout__${n}`) : []),
    "--disallowedTools", ...DISALLOWED, "--max-budget-usd", BUDGET,
  ];
  const env = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", ...(OWN_MEMORY ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }), ...OFFLINE, ...store.env, CI: "", SNOUT_TOKEN: "", PATH: pathWith(BIN_DIR),
    ...(FAKE && OWN_MEMORY ? { SWE_FAKE_AUTO_MEMORY_DIR: claudeMemoryDir(w.ws) } : {}),
    ...(fake?.say ? { SWE_FAKE_SAY: fake.say } : {}), ...(fake?.mcp ? { SWE_FAKE_MCP: JSON.stringify(fake.mcp) } : {}),
    ...(fake?.testCommand ? { SWE_FAKE_TEST_COMMAND: fake.testCommand } : {}) };
  return launchClaude(w.ws, argv, { env, limitMs: LIMIT_MS, goldPatch: fake?.patch });
}

function runCodex(w, text, store, arm, tapLog, fake) {
  const servers = arm !== "plain" ? `mcp_servers={snout=${toml(searchServer(w, store.env, tapLog))}}` : "mcp_servers={}";
  const argv = ["exec", "--json", "-s", "workspace-write", "-C", w.ws, "-m", S.codexModel, "-c", `model_reasoning_effort=${S.codexEffort}`,
    "-c", "project_doc_max_bytes=0", "-c", servers, text];
  const [bin, a] = FAKE ? [process.execPath, [join(REPO, "bench/fake-codex.mjs"), ...argv]] : [process.execPath, [CODEX_JS, ...argv]];
  if (!FAKE && !CODEX_JS) throw new Error("set CODEX_CLI_JS to the Codex CLI's JavaScript entry point");
  const env = { ...process.env, ...OFFLINE, ...store.env, ...ownProject(w), CI: "", SNOUT_TOKEN: "", SNOUT_MODE: "", ...(!FAKE ? codexToolchainEnv(REPO, pathWith(BIN_DIR), w.ws) : { PATH: pathWith(BIN_DIR) }),
    ...(FAKE ? { SWE_FAKE_PATCH: fake?.patch ?? "", SWE_FAKE_GIT_DIR: w.gitDir, SWE_FAKE_SAY: fake?.say ?? "", SWE_FAKE_MCP: fake?.mcp ? JSON.stringify(fake.mcp) : "",
      SWE_FAKE_TEST_COMMAND: fake?.testCommand ?? "", CODEX_HOOKS_FILE: join(REPO, ".codex", "hooks.json") } : {}) };
  return new Promise((done) => {
    const child = spawn(bin, a, { cwd: w.ws, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, LIMIT_MS);
    child.on("close", () => { clearTimeout(timer); done({ stdout, stderr, timedOut }); });
  });
}

/** Codex: the thread, tokens, tool calls and commands, from its JSONL events. */
function codexFacts(stdout) {
  let thread = null, input = 0, cached = 0, output = 0, error, calls = 0;
  const commands = [], mcp = [];
  for (const line of stdout.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "thread.started") thread = e.thread_id;
    else if (e.type === "turn.completed" && e.usage) { input += e.usage.input_tokens ?? 0; cached += e.usage.cached_input_tokens ?? 0; output += e.usage.output_tokens ?? 0; }
    else if (e.type === "item.completed" && e.item) {
      if (!["agent_message", "reasoning", "todo_list"].includes(e.item.type)) calls++;
      if (e.item.type === "command_execution") commands.push(String(e.item.command ?? ""));
      if (e.item.type === "mcp_tool_call") mcp.push(`${e.item.server ?? "?"}/${e.item.tool ?? "?"}`);
    } else if (e.type === "error" || e.type === "turn.failed") error = String(e.message ?? e.error?.message ?? e.type);
  }
  const usd = ((input - cached) * CODEX_PRICE.input + cached * CODEX_PRICE.cached + output * CODEX_PRICE.output) / 1e6;
  return { session: thread, tokens: { input, cached, output, total: input + output }, costUsd: usd, toolCalls: calls, commands, memoryCalls: mcp.filter((m) => m.startsWith("snout/")).map((m) => m.slice(6)), error };
}

const claudeRoot = () => join(CLEAN_HOME ?? (FAKE ? join(process.env.TEMP ?? "/tmp", "snout-fake-claude") : join(HOME, ".claude")), "projects");

/** Claude Code: every tool call ({id, name, input}) from the session's transcript. */
function claudeToolUses(session) {
  let file;
  try { file = readdirSync(claudeRoot(), { recursive: true }).map(String).find((p) => p.endsWith(`${session}.jsonl`)); } catch { /* none */ }
  if (!file) return [];
  const out = new Map();
  for (const l of readFileSync(join(claudeRoot(), file), "utf8").split("\n")) {
    try { const o = JSON.parse(l); for (const b of o.message?.content ?? []) if (b.type === "tool_use") out.set(b.id, { id: b.id, name: b.name, input: b.input }); } catch { /* not a row */ }
  }
  return [...out.values()];
}

// ---------- Other memory paths ----------

/** Files in Claude Code's own memory for this workspace (its project folder in the isolated config). */
const claudeMemoryDir = (ws) => join(claudeRoot(), ws.replace(/[^A-Za-z0-9]/g, "-"), "memory");
function claudeMemoryFiles(ws) {
  const dir = claudeMemoryDir(ws);
  try { return readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()); } catch { return []; }
}

/** Codex's own memories: the files in its memories folder and the rows of its memories database. */
function codexMemories() {
  let files = 0;
  try { files = readdirSync(join(CODEX_HOME, "memories"), { recursive: true }).length; } catch { /* none */ }
  const counts = {};
  const db = join(CODEX_HOME, "memories_1.sqlite");
  if (existsSync(db)) {
    const r = sh(process.execPath, ["--no-warnings", "-e", `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});const o={};for(const {name} of d.prepare("select name from sqlite_master where type='table'").all())o[name]=d.prepare('select count(*) c from "'+name+'"').get().c;console.log(JSON.stringify(o))`, db]);
    try { Object.assign(counts, JSON.parse(r.stdout)); } catch { counts.unreadable = 1; }
  }
  return JSON.stringify({ files, ...counts });
}

/**
 * Paths a session touched outside its workspace. Forbidden: this repository's handoff files (the
 * spec, hidden tests, references), the bench stores and other workspaces. Anything else outside
 * (a Python install, a temp folder) is listed for review.
 */
export function outsideAccess(texts, w, runDir) {
  const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
  // A path as Windows spells it (c:/users/...) and as Git Bash does (/c/users/...).
  const spellings = (p) => [norm(p), norm(p).replace(/^([a-z]):\//, "/$1/")];
  const owns = spellings(w.ws);
  const forbidden = [], review = [];
  const BAD = [...[join(REPO, "bench"), join(REPO, "src"), join(REPO, "docs"), join(REPO, "dist"), join(REPO, ".snout", "notes"), join(HOME, ".snout-bench", "handoff"), runDir].flatMap(spellings), "bench/handoff", "handoff-runs", "handoff-git", "claude-home"];
  for (const t of texts) {
    const n = norm(String(t ?? ""));
    if (!n) continue;
    const rest = owns.reduce((x, o) => x.replaceAll(o, ""), n);
    const other = /handoff-ws\/([\w-]+)/.exec(rest);
    if (BAD.some((b) => rest.includes(b)) || other) forbidden.push(String(t).slice(0, 160));
    else if (/(?:^|[\s"'=])(?:[a-z]:\/|\/c\/|~\/|\$home|%userprofile%)/.test(rest) || /(?:^|[\s"'/])\.\.(?:\/|$)/.test(n)) review.push(String(t).slice(0, 160));
  }
  return { forbidden, review };
}

// ---------- What the receiver was shown ----------

/**
 * From the MCP server's traffic: each search and fetch the agent made, and every place the giver's
 * record appeared in what came back: its line in a search result, or its fetch.
 */
export function memoryUse(tapRows, giverSession, giverAgent, recordPattern, lessonIds = []) {
  const calls = [];
  const replies = new Map(tapRows.filter((r) => r.dir === "out" && r.msg?.id !== undefined).map((r) => [r.msg.id, r.msg]));
  for (const r of tapRows) {
    if (r.dir !== "in" || r.msg?.method !== "tools/call") continue;
    const reply = replies.get(r.msg.id);
    const text = (reply?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    calls.push({ tool: r.msg.params?.name, args: r.msg.params?.arguments ?? {}, text, error: !!(reply?.error || reply?.result?.isError), probe: !!r.probe });
  }
  const id = `session:${giverSession}`;
  const shown = [];
  for (const c of calls) {
    if (c.error) continue;
    if (c.tool === "snout_memory_search") for (const l of c.text.split("\n")) { if (l.includes(id)) shown.push({ via: "search", text: l }); }
    if (c.tool === "snout_memory_fetch" && String(c.args.id ?? "") === id) shown.push({ via: "fetch", text: c.text });
  }
  // The giver's approved lessons: a search line that shows one, or a fetch that opens one. Each line cites the giver's session.
  const lessonShown = calls.some((c) => !c.error && c.tool === "snout_memory_search" && lessonIds.some((l) => c.text.includes(l)));
  const lessonOpened = calls.some((c) => !c.error && c.tool === "snout_memory_fetch" && lessonIds.includes(String(c.args.id ?? "")));
  for (const c of calls) {
    if (c.error) continue;
    if (c.tool === "snout_memory_search") for (const l of c.text.split("\n")) { if (lessonIds.some((x) => l.includes(x))) shown.push({ via: "lesson", text: l }); }
    if (c.tool === "snout_memory_fetch" && lessonIds.includes(String(c.args.id ?? ""))) shown.push({ via: "lesson fetch", text: c.text });
  }
  // Found: the giver's record (or an approved lesson of it) was shown or opened, by its id. Whether the
  // shown text words the fact as recordPattern expects is reported apart (factShown): a record can say it
  // in other words ("payment keys are now stable per invoice"), and the hidden tests judge its use.
  const re = new RegExp(recordPattern, "i");
  const found = shown.length > 0;
  const factShown = shown.some((s) => re.test(s.text));
  return {
    searches: calls.filter((c) => c.tool === "snout_memory_search").length,
    fetches: calls.filter((c) => c.tool === "snout_memory_fetch").length,
    proposals: calls.filter((c) => c.tool === "snout_memory_propose").length,
    lessonShown,
    lessonOpened,
    queries: calls.map((c) => `${String(c.tool ?? "").replace(/^snout_memory_/, "")} ${JSON.stringify(c.tool === "snout_memory_search" ? c.args.query : c.tool === "snout_memory_fetch" ? c.args.id : c.args.text)}`),
    shown: shown.map((s) => ({ via: s.via, text: s.text.slice(0, 600) })),
    found,
    factShown,
    current: found && shown.every((s) => !/\[an out-of-date claim/.test(s.text) && !/^Out of date:/m.test(s.text)),
    cited: found && shown.some((s) => s.text.includes(id) && s.text.includes(giverAgent) && /\b\d{4}-\d{2}-\d{2}/.test(s.text)),
  };
}

/** Dry run only: the receiver's server, asked what an agent might ask (its own prompt, then the giver's record), to show the path works. */
function probe(server, tapLog, queries) {
  const msgs = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "handoff-probe", version: "0" } } }, { jsonrpc: "2.0", method: "notifications/initialized" },
    ...queries.map((q, i) => ({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: q }))];
  sh(server.command, server.args, { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env: { ...process.env, ...server.env }, timeout: 60_000 });
  // Marked, so a dry run's results can never be read as an agent's search.
  writeFileSync(tapLog, lines(tapLog).map((l) => { const o = JSON.parse(l); return JSON.stringify({ ...o, probe: true }); }).join("\n") + "\n");
}

// ---------- One session ----------

async function session(role, d, w, store, prompt, runDir, fake) {
  const agent = w.agent;
  const arm = store.arm;
  const tapLog = join(runDir, `${role}-${d.id}-mcp.jsonl`);
  const memBefore = agent === "claude" ? claudeMemoryFiles(w.ws) : [];
  const codexBefore = codexMemories();
  const sideBefore = lines(store.sideLog).length;
  const recallBefore = rows(join(store.snoutDir, "recall.jsonl")).length;
  const started = Date.now();
  const id = agent === "claude" ? randomUUID() : null;
  // A lesson spec's on arm: the memory skill where the agent reads skills, as the plugin and `snout init codex` place it.
  const skillFile = SHIPPED && arm !== "plain" ? join(w.ws, ...(agent === "claude" ? [".claude", "skills"] : [".agents", "skills"]), "snout-memory", "SKILL.md") : null;
  if (skillFile) { mkdirSync(join(skillFile, ".."), { recursive: true }); writeFileSync(skillFile, MEMORY_SKILL); }
  if (fake?.mcpCalls) fake = { ...fake, mcp: { ...searchServer(w, store.env, tapLog), calls: fake.mcpCalls } };
  const r = agent === "claude" ? await runClaude(w, prompt, store, arm, id, tapLog, fake) : await runCodex(w, prompt, store, arm, tapLog, fake);
  const step = { role, agent, arm, workspace: w.name, seconds: Math.round((Date.now() - started) / 1000), timedOut: r.timedOut || undefined };
  let uses = [];
  if (agent === "codex") {
    Object.assign(step, codexFacts(r.stdout), { priced: "list-price equivalent; billed to the ChatGPT plan" });
  } else {
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
    const tf = out.session_id ? transcriptFacts(out.session_id) : null;
    const u = out.usage ?? {};
    uses = out.session_id ? claudeToolUses(out.session_id) : [];
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    Object.assign(step, {
      session: out.session_id, costUsd: tf?.costUsd ?? out.total_cost_usd ?? 0, cliCostUsd: out.total_cost_usd, priced: "transcript at list prices; billed to the API",
      tokens: { input, cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, total: input + (u.output_tokens ?? 0) },
      toolCalls: uses.length, turns: out.num_turns ?? 0,
      commands: [...new Set(uses.filter((x) => x.name === "Bash").map((x) => String(x.input?.command ?? "")))],
      memoryCalls: uses.filter((x) => String(x.name).startsWith("mcp__snout__")).map((x) => String(x.name).slice(12)),
      cut: /max_budget/.test(String(out.subtype ?? "")) || undefined,
      error: out.is_error && !/max_budget/.test(String(out.subtype ?? "")) ? String(out.result ?? out.subtype ?? "error").slice(0, 200) : undefined,
    });
  }
  step.minutes = +(step.seconds / 60).toFixed(1);
  step.tap = rows(tapLog);
  step.network = networkCommands(step.commands ?? []);
  step.side = snoutSideCalls(lines(store.sideLog).slice(sideBefore));
  step.hooks = step.session ? rows(join(store.snoutDir, "hooks.jsonl")).filter((h) => h.session === step.session) : [];
  step.hookCoverage = arm === "plain" && agent === "claude" ? undefined : agent === "codex" ? codexHookCoverage(step.commands, step.hooks) : hookCoverage(uses, step.hooks);
  const injected = rows(join(store.snoutDir, "recall.jsonl")).slice(recallBefore).filter((x) => x.kind === "inject" && x.injected);
  step.injected = { count: injected.length, ids: [...new Set(injected.flatMap((x) => x.items ?? []))], tokens: injected.reduce((n, x) => n + (x.tokensEst ?? 0), 0) };
  const texts = agent === "claude" ? uses.flatMap((x) => [x.input?.file_path, x.input?.path, x.input?.command, x.input?.notebook_path]) : step.commands;
  step.outside = outsideAccess(texts, w, runDir);
  const memAfter = agent === "claude" ? claudeMemoryFiles(w.ws) : [];
  const codexAfter = codexMemories();
  // Validity, as the spec lists it.
  const bad = [];
  if (!step.session) bad.push(`no session (${step.error ?? r.stderr?.slice(0, 200) ?? "?"})`);
  if (API_REFUSED.test(step.error ?? "")) { bad.push(step.error); step.refused = true; }
  if (arm === "plain" && (step.tap.length || step.memoryCalls?.length)) bad.push("memory search reached the off arm");
  if (arm === "plain" && agent === "claude" && step.side.processes) bad.push("Snout ran in the off arm");
  if (arm !== "notes" && injected.length) bad.push("automatic notes were injected outside the notes arm");
  step.hint = hintOf(step, store);
  if (skillFile) step.skill = { installed: true, seen: inSessionFile(step, /snout-memory/) };
  if (arm === "plain" && (step.hint.logged || step.hint.delivered)) bad.push("the session-start hint reached the off arm");
  // With OWN_MEMORY its memory is part of the arm: reported (files at the start, files at the end), not a fault.
  if (OWN_MEMORY && agent === "claude") step.ownMemory = { before: memBefore.length, after: memAfter.length };
  else if (memBefore.length || memAfter.length) bad.push(`Claude Code's own memory holds ${memAfter.length || memBefore.length} file(s) for this workspace`);
  if (codexAfter !== codexBefore) bad.push(`Codex's memories changed during the session (${codexBefore} → ${codexAfter})`);
  if (step.outside.forbidden.length) bad.push(`read outside its workspace: ${step.outside.forbidden.slice(0, 3).join("; ")}`);
  if (step.network.length) bad.push(`network command: ${step.network[0].slice(0, 100)}`);
  const side = [...step.side.network, ...step.side.jev, ...step.side.cloud, ...step.side.embedding];
  if (side.length) bad.push(`Snout made a side call: ${side.slice(0, 3).join("; ")}`);
  if ((arm !== "plain" || agent === "codex") && step.session && !step.hooks.length) bad.push("Snout's hooks did not run");
  if (!FAKE && step.hookCoverage?.missing > 0) bad.push(`${step.hookCoverage.missing} expected Snout hook call(s) missing`);
  if (arm !== "plain" && step.session) {
    const modes = modeProblems(rows(join(store.snoutDir, "ledger.jsonl")).filter((x) => x.session === step.session));
    if (modes.length) bad.push(`Snout ran in ${modes.join("/")} mode`);
  }
  if (bad.length) step.invalid = bad;
  delete step.hooks;
  return step;
}

// ---------- One direction ----------

/** A stand-in's change for a dry run: `overlay` over `from`, as a patch. */
function fakePatch(from, overlay, runDir, name) {
  const dir = join(runDir, "fake", name);
  rmSync(dir, { recursive: true, force: true });
  copyProject(from, dir);
  const g = (...a) => sh("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "core.autocrlf=false", ...a], { cwd: dir });
  g("init", "-q"); g("add", "-A");
  const baseTree = must(g("write-tree"), "stand-in base tree").stdout.trim();
  cpSync(overlay, dir, { recursive: true });
  g("add", "-A");
  const file = join(runDir, "fake", `${name}.patch`);
  writeFileSync(file, must(g("diff", "--cached", "--binary", baseTree), "stand-in patch").stdout);
  return file;
}

/** What the stand-ins say at the end of a dry run: the giver's cause, as a real agent's summary would carry it. */
const FAKE_SAY = {
  "claude-to-codex": "Added export-invoices: semicolon-separated CSV with a decimal comma for finance; tests pass.",
  "codex-to-claude": "Fixed: the daily report grouped deliveries by their UTC date. It now uses each depot's own time zone (localDay in src/time.js). Tests pass.",
};

async function direction(d, runDir, spend) {
  const out = { id: d.id, project: d.project, giverAgent: d.giver, receiverAgent: d.receiver };
  const base = join(HERE, d.project, "base");
  const shared = newStore(join(runDir, d.id, "store"), "search");
  const giverFake = FAKE ? { patch: fakePatch(base, join(HERE, d.project, refGiver(d)), runDir, `${d.id}-giver`), say: d.dryRunSay ?? FAKE_SAY[d.id],
    ...(LESSONS && d.dryRunLesson ? { mcpCalls: [{ name: "snout_memory_propose", arguments: d.dryRunLesson }], testCommand: d.dryRunLesson.evidence } : {}) } : undefined;
  // 1. The giver: the task, verified, in a store of its own that starts empty.
  const gw = newWorkspace(d.giver, d, base, { fixed: OWN_MEMORY && d.giver === "claude" });
  if (d.giver === "claude" && !spend.allow()) return { ...out, stopped: spend.why() };
  const g = await session("giver", d, gw, shared, d.giverPrompt, runDir, giverFake);
  spend.add(g);
  g.graded = grade(d, gw.ws, "giver", runDir);
  // Claude Code's own memory as the giver left it: each Claude Code receiver starts from this.
  if (OWN_MEMORY && d.giver === "claude" && existsSync(claudeMemoryDir(gw.ws))) cpSync(claudeMemoryDir(gw.ws), join(runDir, d.id, "claude-memory"), { recursive: true });
  if (g.graded.unreadable?.length) g.invalid = [...(g.invalid ?? []), `grading copy omitted ${g.graded.unreadable.length} unreadable project path(s)`];
  g.solved = g.graded.solved && !g.timedOut && !g.cut;
  out.giver = g;
  // 2. The gate: solved, and the giver's record is in the store, from the giver's agent, with the fact.
  const cardFile = g.session ? join(shared.snoutDir, "memory", `${g.session.replace(/[^\w.-]/g, "_").slice(0, 80)}.json`) : "";
  const card = existsSync(cardFile) ? JSON.parse(readFileSync(cardFile, "utf8")) : null;
  const recordText = card ? [card.task, card.request, card.outcome].filter(Boolean).join("\n") : "";
  // A lesson spec: what the giver proposed, and what its record backed (checked at its Stop).
  if (LESSONS) out.lessons = { proposedInSession: (g.memoryCalls ?? []).filter((n) => n === "snout_memory_propose").length || rows(join(runDir, `giver-${d.id}-mcp.jsonl`)).filter((r) => r.dir === "in" && r.msg?.params?.name === "snout_memory_propose").length, atGiver: giverLessons(d, shared, g.session) };
  const lessonFact = LESSONS && out.lessons.atGiver.some((l) => new RegExp(d.recordPattern, "i").test(`${l.text} ${l.applies}`));
  out.gate = {
    solved: g.solved, record: !!card, agent: card?.agent ?? null, fact: (!!card && new RegExp(d.recordPattern, "i").test(recordText)) || lessonFact,
    recordText: recordText.slice(0, 1200), changed: card?.changed ?? [], test: card?.test ?? null,
  };
  out.gate.pass = out.gate.solved && out.gate.record && out.gate.agent === d.giver && out.gate.fact && !g.invalid;
  // 3. The snapshot: the giver's project as it left it, without agents' or tools' folders.
  const snapshot = join(runDir, d.id, "snapshot");
  const unreadable = copyProject(gw.ws, snapshot);
  out.snapshot = { dir: snapshot, codeVisible: codeShows(snapshot, d.codePattern), ...(d.repoPattern ? { decisionInRepo: repoShows(snapshot, d.repoPattern) } : {}), ...(unreadable.length ? { unreadable } : {}) };
  // A snapshot missing part of the giver's project is not the giver's work: no receiver runs on it.
  if (unreadable.length) out.gate.pass = false;
  if (!out.gate.pass) return { ...out, stopped: `no record to hand off: ${Object.entries({ solved: out.gate.solved, record: out.gate.record, agent: out.gate.agent === d.giver, fact: out.gate.fact, valid: !g.invalid, snapshot: !unreadable.length }).filter(([, v]) => !v).map(([k]) => k).join(", ")}` };
  // A lesson spec stops here: a person reviews the giver's proposals (--review) before any receiver runs (--resume).
  if (LESSONS) {
    const rw = newWorkspace("claude", d, snapshot);
    out.review = { workspace: rw.ws, snoutDir: shared.snoutDir, configDir: shared.configDir };
    out.awaitingReview = true;
    return out;
  }
  return receivers(d, runDir, spend, out);
}

/** The giver's lessons in the shared store, as review sees them: proposed, checked, approved or rejected. */
function giverLessons(d, store, giverSession, projectDir) {
  if (!giverSession) return [];
  const stores = storesFor(projectDir ?? join(HERE, d.project, "base"), store.snoutDir, store.configDir, projectKeyOf(d));
  return lessonsIn(stores).filter((o) => o.source.session === giverSession).map((o) => ({
    id: o.id, text: o.text, applies: o.lesson.applies, basis: o.lesson.basis, evidence: o.source.evidence ?? null, check: o.lesson.check, record: o.lesson.checked ?? null,
    status: o.status, verdict: o.lesson.review?.verdict ?? null, edited: !!o.lesson.edited, approved: approvedLesson(o), agent: o.source.agent, date: o.created.slice(0, 10),
  }));
}

/** The project key Snout derives from a remote (src/memory/store.ts projectKey), for an https remote: every workspace of a direction shares it. */
const projectKeyOf = (d) => createHash("sha256").update(d.remote.replace(/^[a-z+]+:\/\/([^@/]*@)?/i, "").replace(/\.git$/, "").toLowerCase()).digest("hex").slice(0, 24);

/** The receivers from the same snapshot: search only, then off; fake runs may also inspect notes-on. */
async function receivers(d, runDir, spend, out) {
  const shared = newStore(join(runDir, d.id, "store"), "search");
  const g = out.giver;
  const snapshot = out.snapshot.dir;
  if (LESSONS) out.lessons.afterReview = giverLessons(d, shared, g.session);
  const lessonIds = LESSONS ? out.lessons.afterReview.filter((l) => l.approved).map((l) => l.id) : [];
  delete out.awaitingReview;
  out.receivers = {};
  for (const arm of (NOTES_ARM ? ["on", "notes", "off"] : ["on", "off"])) {
    if (d.receiver === "claude" && !spend.allow()) { out.stopped = spend.why(); break; }
    const store = arm === "off" ? newStore(join(runDir, d.id, "off-store"), "plain")
      : newStore(join(runDir, d.id, `${arm}-store`), arm === "notes" ? "notes" : "search", shared);
    const w = newWorkspace(d.receiver, d, snapshot, { fixed: OWN_MEMORY && d.receiver === "claude" });
    if (OWN_MEMORY && d.receiver === "claude") {
      const mem = claudeMemoryDir(w.ws), kept = join(runDir, d.id, "claude-memory");
      rmSync(mem, { recursive: true, force: true });
      if (existsSync(kept)) cpSync(kept, mem, { recursive: true });
    }
    const fake = FAKE ? { patch: fakePatch(snapshot, join(HERE, d.project, refReceiver(d)), runDir, `${d.id}-${arm}`), say: "Done; tests pass." } : undefined;
    const s = await session(`receiver-${arm}`, d, w, store, d.receiverPrompt, runDir, fake);
    spend.add(s);
    if (FAKE && arm === "on") {
      // The stand-ins call no MCP tool: ask the receiver's own server, as an agent might, and mark it a probe.
      const tapLog = join(runDir, `probe-${d.id}-mcp.jsonl`);
      probe(searchServer(w, store.env, tapLog), tapLog, [{ name: "snout_memory_search", arguments: { query: d.dryRunQuery ?? d.receiverPrompt.split(/(?<=\.)\s/)[0] } }, { name: "snout_memory_fetch", arguments: { id: lessonIds[0] ?? `session:${g.session}` } }]);
      s.tap = rows(tapLog);
      s.probe = true;
    }
    s.memory = memoryUse(s.tap, g.session, d.giver, d.recordPattern, lessonIds);
    delete s.tap;
    s.graded = grade(d, w.ws, "receiver", runDir);
    if (s.graded.unreadable?.length) s.invalid = [...(s.invalid ?? []), `grading copy omitted ${s.graded.unreadable.length} unreadable project path(s)`];
    s.solved = s.graded.solved && !s.timedOut && !s.cut;
    out.receivers[arm] = s;
  }
  const on = out.receivers.on, notes = out.receivers.notes, off = out.receivers.off;
  // Record only: no file states the decision and no code applies it (spec-record.json; spec.json has no repoPattern).
  const recordOnly = d.repoPattern ? !(out.snapshot.decisionInRepo.length || out.snapshot.codeVisible.length) : undefined;
  if (on) out.handoff = { hintLogged: on.hint?.logged, hintDelivered: on.hint?.delivered, recordOnly, searched: on.memory.searches + on.memory.fetches > 0, found: on.memory.found, current: on.memory.current, cited: on.memory.cited, solved: on.solved,
    success: !on.probe && on.memory.found && on.memory.current && on.memory.cited && on.solved && !on.invalid, offSolved: off?.solved ?? null,
    // A lesson spec: the lesson path, apart from the record path. Approved by the person, shown or opened, and the task solved.
    ...(LESSONS ? { lessonApproved: lessonIds.length > 0, lessonShown: on.memory.lessonShown, lessonOpened: on.memory.lessonOpened, skillSeen: on.skill?.seen ?? false,
      lessonSuccess: !on.probe && lessonIds.length > 0 && (on.memory.lessonShown || on.memory.lessonOpened) && on.solved && !on.invalid,
      ...(NOTES_ARM ? {
        notesInjected: notes?.injected?.ids?.some((id) => lessonIds.includes(id)) ?? false,
        notesSolved: notes?.solved ?? null,
        notesSuccess: !!notes && lessonIds.length > 0 && notes.injected.ids.some((id) => lessonIds.includes(id)) && notes.solved && !notes.invalid,
      } : {}) } : {}) };
  if (on && off) out.cost = Object.fromEntries(["tokens", "toolCalls", "minutes", "costUsd"].map((k) => {
    const v = (s) => (k === "tokens" ? s.tokens?.total ?? 0 : s[k] ?? 0);
    return [k, { on: v(on), off: v(off), onMinusOff: +(v(on) - v(off)).toFixed(4) }];
  }));
  return out;
}

const refGiver = (d) => d.grade.refGiver ?? "ref-giver";
const refReceiver = (d) => d.grade.refReceiver ?? "ref-receiver";

/** Every line of the snapshot (code, docs, tests) that states the decision, as `file:line: text`: the giver wrote it into the project. Reported, not scored. */
export function repoShows(dir, pattern) {
  const re = new RegExp(pattern, "i");
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (ARTIFACTS.has(e.name) ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return walk(dir).flatMap((f) => {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { return []; }
    return text.split("\n").flatMap((l, i) => (re.test(l) ? [`${relative(dir, f).replace(/\\/g, "/")}:${i + 1}: ${l.trim().slice(0, 120)}`] : []));
  });
}

/**
 * A repoPattern has to match the decision, not its topic. The receiver's prompt names the topic and
 * withholds the decision ("payroll's new rule"), so a pattern that matches it would flag any file that
 * mentions the topic: the first record-only run flagged a giver's test name for the word "payroll",
 * though that test pins the old rule. The pattern must match the giver's prompt, where the user gave
 * the decision. --grade-check also runs it on the references (`decisionShows`).
 */
export function decisionPatternProblems(d) {
  const re = new RegExp(d.repoPattern, "i");
  const out = [];
  if (!re.test(d.giverPrompt)) out.push("it does not match the giver's prompt, where the decision was given");
  const hit = re.exec(d.receiverPrompt);
  if (hit) out.push(`it matches the receiver's prompt ("${hit[0]}"), which names the topic and withholds the decision`);
  return out;
}

/** Where a project states the decision (repoPattern, any file) or applies it (codePattern, code only). */
const decisionShows = (dir, d) => [...repoShows(dir, d.repoPattern), ...codeShows(dir, d.codePattern)];

/** The session-start hint (memoryHint): did Snout log one for the session, and is its text in what the agent recorded of its context? */
const HINT = /earlier sessions? (?:is|are) on record in this project/;
function hintOf(step, store) {
  const logged = rows(join(store.snoutDir, "recall.jsonl")).some((r) => r.kind === "hint" && r.session === step.session);
  return { logged, delivered: inSessionFile(step, HINT) };
}

/** Whether the agent's own record of the session (Claude Code's transcript, Codex's rollout) holds `re`. */
function inSessionFile(step, re) {
  if (!step.session) return false;
  const root = step.agent === "claude" ? claudeRoot() : join(FAKE ? join(process.env.TEMP ?? "/tmp", "snout-fake-codex") : CODEX_HOME, "sessions");
  let file;
  try { file = readdirSync(root, { recursive: true }).map(String).find((p) => p.includes(step.session) && p.endsWith(".jsonl")); } catch { /* none */ }
  return !!file && re.test(readFileSync(join(root, file), "utf8"));
}

/** Does the snapshot's code (not its tests) show the expected fact? Reported, not scored. */
function codeShows(dir, pattern) {
  const re = new RegExp(pattern);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (ARTIFACTS.has(e.name) || e.name === "tests" || e.name === "test" ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.(py|js|mjs|ts)$/.test(e.name) ? [join(d, e.name)] : []));
  return walk(dir).filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(dir, f).replace(/\\/g, "/"));
}

// ---------- Freeze ----------

function freezeFiles() {
  const files = [SPEC_FILE, join(REPO, "bench/handoff-check.mjs"), TAP, GUARD, ...["swe.mjs", "swelong.mjs", "study-checks.mjs", "shipped-hooks.mjs", "stamp.mjs", "fake-claude.mjs", "fake-codex.mjs", "fake-mcp.mjs", "codex-toolchain.mjs"].map((f) => join(REPO, "bench", f)),
    join(REPO, "dist/snout.mjs"), join(REPO, "dist/lib.mjs"), join(REPO, "hooks/hooks.json"), join(REPO, ".codex/hooks.json")];
  const addFiles = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ARTIFACTS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) addFiles(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const d of SPEC.directions) {
    const root = join(HERE, d.project);
    addFiles(root);
  }
  return Object.fromEntries(files.map((f) => [relative(REPO, f).replace(/\\/g, "/"), sha(f)]).sort(([a], [b]) => a.localeCompare(b)));
}

function checkFreeze(versions) {
  if (!existsSync(FREEZE_FILE)) throw new Error("no bench/handoff/freeze.json: freeze first (--freeze)");
  const want = JSON.parse(readFileSync(FREEZE_FILE, "utf8"));
  const now = freezeFiles();
  const bad = Object.keys({ ...want.files, ...now }).filter((f) => want.files[f] !== now[f]);
  if (JSON.stringify(want.settings) !== JSON.stringify(S)) bad.push("settings");
  if (!FAKE) {
    if (!String(versions.claude ?? "").includes(S.claudeCode)) bad.push(`Claude Code ${versions.claude}`);
    if (!String(versions.codex ?? "").includes(S.codex)) bad.push(`Codex ${versions.codex}`);
  }
  if (bad.length) throw new Error(`differs from the frozen inputs (bench/handoff/freeze.json): ${bad.join(", ")}`);
  return want.frozenAt;
}

// ---------- Live Codex hook check ----------

/**
 * One live Codex session (ChatGPT plan, no API spend) before any paid session: in a workspace set up
 * as the check sets up Codex's, do Snout's project hooks run, does its MCP server answer, and does the
 * session's record name the workspace's own paths, branch and project? The prompt asks for a search
 * and a test run and no change. Not a handoff session and not scored.
 */
async function codexHookCheck() {
  const d = SPEC.directions.find((x) => x.project === "berthbook");
  const build = frozenBuild();
  const versions = { claude: build.claudeCode, codex: FAKE ? "stand-in" : sh(process.execPath, [CODEX_JS, "--version"]).stdout.trim(), node: process.version };
  const frozenAt = checkFreeze(versions);
  const runDir = join(HOME, ".snout-bench", "handoff-runs", `hook-check-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const store = newStore(join(runDir, "store"), "search");
  const w = newWorkspace("codex", d, join(HERE, d.project, "base"));
  // One earlier session on record, so the session-start hint has something to point at.
  const t0 = new Date(Date.now() - 3_600_000).toISOString();
  mkdirSync(join(store.snoutDir, "memory"), { recursive: true });
  writeFileSync(join(store.snoutDir, "memory", "hook-check-earlier.json"), JSON.stringify({ v: 1, id: "hook-check-earlier", session: "hook-check-earlier", agent: "claude", started: t0, updated: t0, task: "An earlier session (hook check).", changed: [], rules: [], commits: [] }));
  const prompt = "Call the snout_memory_search tool once with the query \"invoice export\" and say in one line what it returned. Then run the tests with `python -m pytest -q` and report how many passed. Do not change any files.";
  const s = await session("hook-check", d, w, store, prompt, runDir);
  const tap = rows(join(runDir, `hook-check-${d.id}-mcp.jsonl`));
  const listed = tap.find((r) => r.dir === "out" && r.msg?.result?.tools)?.msg.result.tools.map((t) => t.name) ?? [];
  const cardFile = s.session ? join(store.snoutDir, "memory", `${s.session.replace(/[^\w.-]/g, "_").slice(0, 80)}.json`) : "";
  const card = existsSync(cardFile) ? JSON.parse(readFileSync(cardFile, "utf8")) : null;
  // The project key Snout derives from a remote (src/memory/store.ts projectKey), for an https remote.
  const key = createHash("sha256").update(d.remote.replace(/^[a-z+]+:\/\/([^@/]*@)?/i, "").replace(/\.git$/, "").toLowerCase()).digest("hex").slice(0, 24);
  const keys = (() => { try { return readdirSync(join(store.configDir, "memory")).filter((k) => k !== "global"); } catch { return []; } })();
  const checks = {
    "session valid (hooks ran, no leak, no network, no side call)": !s.invalid,
    "hooks saw the session start and the prompt": !!(s.hookCoverage?.started && s.hookCoverage?.prompted),
    "hooks saw every shell command": !!s.hookCoverage && s.hookCoverage.expected > 0 && s.hookCoverage.missing === 0,
    [`MCP server offered ${MEMORY_TOOLS.join(", ")} only`]: listed.join(",") === MEMORY_TOOLS.join(","),
    "the agent's search reached the server": tap.some((r) => r.dir === "in" && r.msg?.params?.name === "snout_memory_search"),
    "record saved, as codex, on the workspace's branch": card?.agent === "codex" && card?.branch === "master",
    "record's paths are the workspace's own": !!card && (card.changed ?? []).every((p) => !/handoff-ws|^\.snout/.test(p)),
    "the test run was recorded": /pytest/.test(card?.test?.command ?? ""),
    "notes keyed by the project's remote": keys.length > 0 && keys.every((k) => k === key),
    "the session-start hint was logged": !!s.hint?.logged,
    "the hint reached the model (it is in the session's rollout)": !!s.hint?.delivered,
    ...(LESSONS ? { "the memory skill is in the session's rollout": !!s.skill?.seen } : {}),
  };
  const pass = Object.values(checks).every(Boolean);
  const out = join(REPO, "bench/ab-results", `handoff-hookcheck-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ fake: FAKE, measuredAt: new Date().toISOString(), frozenAt, versions, pass, checks, listed, keys, expectedKey: key, card, session: { ...s, tap: undefined } }, null, 2));
  console.log(`\nCodex hook check ·${FAKE ? "stand-in" : versions.codex} · ${pass ? "PASS" : "FAIL"} → ${relative(REPO, out)}`);
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "ok  " : "FAIL"} ${k}`);
  if (s.invalid) console.log(`  invalid: ${s.invalid.join("; ")}`);
  console.log(`  ${fmt(s)}`);
  if (!args.keep) removeSandboxed(join(REPO, ".snout", "handoff-ws"));
  if (!pass) process.exitCode = 1;
}

// ---------- Main ----------

function gradeCheck() {
  const runDir = join(HOME, ".snout-bench", "handoff-runs", `grade-check-${Date.now()}`);
  let ok = true;
  for (const d of SPEC.directions) {
    const base = join(HERE, d.project, "base");
    const giverDone = join(runDir, d.id, "giver-ref");
    copyProject(base, giverDone); cpSync(join(HERE, d.project, refGiver(d)), giverDone, { recursive: true });
    const both = join(runDir, d.id, "receiver-ref");
    copyProject(giverDone, both); cpSync(join(HERE, d.project, refReceiver(d)), both, { recursive: true });
    const checks = [
      ["unchanged project, giver's tests", grade(d, base, "giver", runDir), false],
      ["giver's reference, giver's tests", grade(d, giverDone, "giver", runDir), true],
      ["giver's reference, receiver's tests", grade(d, giverDone, "receiver", runDir), false],
      ["both references, receiver's tests", grade(d, both, "receiver", runDir), true],
    ];
    const visible = codeShows(giverDone, d.codePattern);
    for (const [what, g, want] of checks) {
      const fine = g.solved === want && (want || g.failed.length > 0);
      ok &&= fine;
      console.log(`  ${fine ? "ok  " : "FAIL"} ${d.id}: ${what}: ${g.solved ? "solved" : `not solved (${g.failed.length} failing${g.failed.length ? `: ${g.failed.slice(0, 2).join(", ")}` : ""})`}`);
      if (!fine && g.tail) console.log(g.tail);
    }
    console.log(`       ${d.id}: the giver's reference code shows the fact in ${visible.length ? visible.join(", ") : "no file"}`);
    // A record-only direction: its pattern names the decision; the giver's reference holds none of it, the receiver's does.
    if (d.repoPattern) {
      const problems = decisionPatternProblems(d);
      const inGiver = decisionShows(giverDone, d), inBoth = decisionShows(both, d);
      if (inGiver.length) problems.push(`the giver's reference already holds the decision: ${inGiver.slice(0, 3).join("; ")}`);
      if (!inBoth.length) problems.push("the receiver's reference shows no decision: the check could not see one written into the project");
      ok &&= !problems.length;
      console.log(`  ${problems.length ? "FAIL" : "ok  "} ${d.id}: the decision pattern ${problems.length ? problems.join("; ") : `names the decision (found in the receiver's reference: ${inBoth.slice(0, 2).join("; ")})`}`);
    }
  }
  rmSync(runDir, { recursive: true, force: true });
  if (!ok) process.exit(1);
}

function summarize(saved) {
  console.log(`\nCross-agent handoff check · ${saved.fake ? "DRY RUN with stand-in agents (no model calls)" : "live"} · frozen ${saved.frozenAt} · bundle ${saved.stamp.bundleSha256.slice(0, 8)}\n`);
  for (const d of saved.directions) {
    console.log(`${d.id} (${d.project}): ${d.giverAgent} → ${d.receiverAgent}`);
    const g = d.giver;
    if (g) console.log(`  giver      ${g.solved ? "solved" : "NOT solved"}${g.invalid ? ` · INVALID ${g.invalid.join("; ")}` : ""} · record ${d.gate.record ? `${d.gate.agent}, fact ${d.gate.fact ? "present" : "MISSING"}` : "MISSING"} · ${fmt(g)}`);
    if (d.lessons) {
      const ls = d.lessons.afterReview ?? d.lessons.atGiver;
      console.log(`  lessons    proposed ${d.lessons.proposedInSession} in the giver's session${ls.length ? "" : " · none on record"}${d.awaitingReview ? " · WAITING FOR REVIEW" : ""}`);
      for (const l of ls) console.log(`             ${l.id} [${l.basis}; record ${l.check === "verified" ? "backs it" : "does NOT back it"}; ${l.approved ? "approved" : l.verdict ?? "not reviewed"}] "${l.text.slice(0, 110)}" · applies when: ${l.applies.slice(0, 80)}`);
    }
    if (d.snapshot) console.log(`  snapshot   the code shows the fact: ${d.snapshot.codeVisible.length ? d.snapshot.codeVisible.join(", ") : "no"}${d.snapshot.decisionInRepo ? ` · the decision is in the project: ${d.snapshot.decisionInRepo.length ? d.snapshot.decisionInRepo.join(", ") : "no (record only)"}` : ""}`);
    for (const arm of (d.lessons && saved.fake && saved.experimentalNotes ? ["on", "notes", "off"] : ["on", "off"])) {
      const s = d.receivers?.[arm];
      if (!s) continue;
      const m = s.memory;
      const lessonPart = arm !== "off" && d.lessons ? ` · lesson ${m.lessonShown ? "shown" : "not shown"}, ${m.lessonOpened ? "opened" : "not opened"}${s.skill ? ` · skill placed, ${s.skill.seen ? "in the session's record" : "not in the session's record (Claude Code's holds it only if the agent opened it)"}` : ""}` : "";
      const mem = arm !== "off" ? `${s.hint ? ` · hint ${s.hint.logged ? "logged" : "NOT logged"}, ${s.hint.delivered ? "delivered" : "NOT seen in the agent's record"}` : ""} · ${m.searches} search, ${m.fetches} fetch${s.probe ? " (dry-run probe, not the agent)" : ""} · injected ${s.injected?.ids?.length ?? 0} item(s) / ${s.injected?.tokens ?? 0} tokens · record ${m.found ? `found${m.current ? ", current" : ", NOT current"}${m.cited ? ", cited" : ", NOT cited"}` : "not found"}${lessonPart}` : "";
      console.log(`  ${`receiver ${arm}`.padEnd(10)} ${s.solved ? "solved" : "NOT solved"}${mem} · ${fmt(s)}${s.invalid ? ` · INVALID ${s.invalid.join("; ")}` : ""}`);
      if (s.outside?.review.length) console.log(`             outside its workspace, for review: ${s.outside.review.slice(0, 3).join(" | ")}`);
    }
    if (d.handoff) console.log(`  handoff    ${d.handoff.success ? "SUCCEEDED" : "did not succeed"}${d.handoff.recordOnly === false ? " (decision also in the project)" : ""} (searched ${d.handoff.searched}, found ${d.handoff.found}, current ${d.handoff.current}, cited ${d.handoff.cited}, solved ${d.handoff.solved}); off arm solved: ${d.handoff.offSolved}`);
    if (d.handoff?.lessonApproved !== undefined) console.log(`  lesson     ${d.handoff.lessonSuccess ? "HANDED OFF" : "not handed off"} (approved ${d.handoff.lessonApproved}, shown ${d.handoff.lessonShown}, opened ${d.handoff.lessonOpened}, solved ${d.handoff.solved})`);
    if (d.handoff?.notesSuccess !== undefined) console.log(`  notes      ${d.handoff.notesSuccess ? "DELIVERED AND SOLVED" : "not shown or not solved"} (approved lesson injected ${d.handoff.notesInjected}, solved ${d.handoff.notesSolved})`);
    if (d.cost) console.log(`  cost       on − off: ${d.cost.tokens.onMinusOff} tokens, ${d.cost.toolCalls.onMinusOff} tool calls, ${d.cost.minutes.onMinusOff} min, $${d.cost.costUsd.onMinusOff} (one pair: an anecdote, not a result)`);
    if (d.stopped) console.log(`  stopped    ${d.stopped}`);
    console.log("");
  }
  console.log(`Claude Code spend (API): ${saved.spend.claudeUsd.toFixed(3)}${saved.spend.cap ? ` of a ${saved.spend.cap} cap` : " (stand-ins: nominal)"} · Codex list-price equivalent (plan): $${saved.spend.codexUsd.toFixed(3)}`);
}
const fmt = (s) => `${(s.tokens?.total ?? 0).toLocaleString("en-US")} tokens, ${s.toolCalls ?? 0} tool calls, ${s.minutes ?? 0} min, $${(s.costUsd ?? 0).toFixed(3)}${s.agent === "codex" ? " (plan)" : ""}`;

/** `--review <results file> [memory args]`: the person's step, on the store the receivers will copy. Default: list the proposals. */
function review(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const d = saved.directions.find((x) => x.awaitingReview);
  if (!d) return console.log("No direction is waiting for review in that run.");
  const after = process.argv.slice(process.argv.indexOf("--review") + 2).filter((a) => a !== "--spec" && !a.endsWith(".json"));
  const env = { ...process.env, SNOUT_DIR: d.review.snoutDir, SNOUT_CONFIG_DIR: d.review.configDir, CLAUDE_PROJECT_DIR: d.review.workspace, CI: "", SNOUT_TOKEN: "" };
  const r = sh(process.execPath, [SNOUT_BIN, "memory", ...(after.length ? after : ["review"])], { cwd: d.review.workspace, env });
  console.log(`${d.id}: ${d.giverAgent}'s proposals, for ${d.receiverAgent}'s sessions\n`);
  process.stdout.write(r.stdout || r.stderr);
  if (!after.length) console.log(`\nWhen you're done: node bench/handoff-check.mjs --spec ${basename(SPEC_FILE)} --resume ${file}${FAKE ? "" : " --max-spend <cap>"}`);
}

async function main() {
  if (typeof args.summarize === "string") return summarize(JSON.parse(readFileSync(args.summarize, "utf8")));
  if (typeof args.review === "string") return review(args.review);
  if (args["grade-check"]) return gradeCheck();
  if (args["codex-hook-check"]) return codexHookCheck();
  if (args.freeze) {
    writeFileSync(FREEZE_FILE, JSON.stringify({ frozenAt: new Date().toISOString(), settings: S, files: freezeFiles() }, null, 2) + "\n");
    return console.log(`froze ${Object.keys(freezeFiles()).length} files → ${relative(REPO, FREEZE_FILE)}`);
  }
  if (!FAKE && !MAX_SPEND) throw new Error("--max-spend is required for a live run (it caps Claude Code's API spend)");
  if (OWN_MEMORY && !FAKE && !CLEAN_HOME) throw new Error("this spec keeps Claude Code's own memory on: run with --plan (or --api) so it is written to an isolated config, not your ~/.claude");
  const build = frozenBuild();
  const versions = { claude: build.claudeCode, codex: FAKE ? "stand-in" : sh(process.execPath, [CODEX_JS, "--version"]).stdout.trim(), node: process.version };
  const frozenAt = checkFreeze(versions);
  const resumed = typeof args.resume === "string" ? JSON.parse(readFileSync(args.resume, "utf8")) : null;
  if (resumed && resumed.fake !== FAKE) throw new Error(`that run was ${resumed.fake ? "a dry run" : "live"}; resume it the same way`);
  if (resumed && !!resumed.experimentalNotes !== NOTES_ARM) throw new Error("resume with the same experimental-notes setting as the original run");
  const runId = resumed?.runId ?? `handoff-${FAKE ? "dryrun" : "live"}-${Date.now()}`;
  const runDir = join(HOME, ".snout-bench", "handoff-runs", runId);
  mkdirSync(runDir, { recursive: true });
  const outFile = resumed ? args.resume : FAKE ? join(REPO, "bench/ab-results", `${runId}.json`) : join(HERE, `results-${new Date().toISOString().slice(0, 10)}${SPEC_TAG}.json`);
  mkdirSync(join(outFile, ".."), { recursive: true });
  const spent = { claude: resumed?.spend.claudeUsd ?? 0, codex: resumed?.spend.codexUsd ?? 0 };
  // The cap: no Claude Code session starts unless its whole budget still fits under --max-spend.
  const spend = {
    add: (s) => { spent[s.agent] += s.costUsd ?? 0; if (s.refused) spent.refused = s.error; },
    // An API that refuses a session (no credit, a bad key, a rate limit) stops the whole run: no session starts after it.
    allow: () => !spent.refused && (FAKE || spent.claude + Number(BUDGET) <= MAX_SPEND),
    why: () => (spent.refused ? `the API refused a Claude Code session (${spent.refused})` : `--max-spend $${MAX_SPEND}: $${spent.claude.toFixed(2)} spent, a session may take $${BUDGET}`),
  };
  const only = typeof args.direction === "string" ? args.direction.split(",") : SPEC.directions.map((d) => d.id);
  const saved = resumed ?? { runId, fake: FAKE, experimentalNotes: NOTES_ARM, measuredAt: new Date().toISOString(), frozenAt, stamp: stamp(), build, versions, spec: sha(SPEC_FILE), directions: [], spend: {} };
  if (resumed && resumed.spec !== sha(SPEC_FILE)) throw new Error("the spec changed since that run started");
  const save = () => { saved.spend = { claudeUsd: spent.claude, codexUsd: spent.codex, cap: MAX_SPEND || null }; writeFileSync(outFile, JSON.stringify(saved, null, 2)); };
  console.error(`${only.length} direction(s), ${NOTES_ARM ? 4 : 3} sessions each → ${outFile}`);
  for (const d of SPEC.directions.filter((x) => only.includes(x.id))) {
    const i = saved.directions.findIndex((x) => x.id === d.id);
    const done = saved.directions[i];
    if (done && !done.awaitingReview) continue;
    const result = done ? await receivers(d, runDir, spend, done) : await direction(d, runDir, spend);
    if (i >= 0) saved.directions[i] = result; else saved.directions.push(result);
    save();
    if (spent.refused) { console.error(`stopped: ${spend.why()}`); break; }
    if (result.awaitingReview) {
      summarize(saved);
      console.log(`\n${d.id}: the giver is done. Review its proposals before the receivers run:\n  node bench/handoff-check.mjs --spec ${basename(SPEC_FILE)} --review ${outFile}`);
      if (!args.keep) removeSandboxed(join(REPO, ".snout", "handoff-ws"));
      return;
    }
  }
  save();
  console.log(`\nResults: ${outFile}`);
  summarize(saved);
  if (!args.keep) removeSandboxed(join(REPO, ".snout", "handoff-ws"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(1); });
