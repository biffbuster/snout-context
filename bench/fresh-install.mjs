#!/usr/bin/env node
/**
 * Gate 2, fresh install (docs/memory-gates.md), as a script. Installs this checkout the way the
 * README says, into an empty home and config folder, then runs stand-in sessions in a new Node
 * project for Claude Code and for Codex and records every piece of text Snout adds.
 *
 *   Claude Code   the plugin as `claude plugin install` unpacks it (the package's own files, with
 *                 hooks/hooks.json), its hooks fired the way Claude Code fires them
 *   Codex         `npm install -g` of the packed package into a scratch prefix, then
 *                 `snout init codex` in the project, and the hooks it wrote fired the way Codex does
 *
 * For each agent: session 1 runs a passing `npm test`; session 2 asks "The add tests fail after my
 * change. Run the tests and fix it." in the default mode; then `snout mode enforce` and session 3
 * asks the same; then `snout memory notes on` and session 4. Checked: nothing is written to the home
 * or config folders at install, the default is observe and the agent gets no note in it, the note is
 * recorded as fitting (recall.jsonl), enforce alone shows none (automatic notes are opt-in), it is
 * shown with its source once notes are on, and the local index (where node:sqlite exists) is in the
 * config folder, never the project. No model and no network: npm installs the packed file offline.
 *
 *   node bench/fresh-install.mjs [--label NAME]     results in bench/fresh-install/results-NAME.json
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LABEL = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "run";
const work = mkdtempSync(join(tmpdir(), "snout-fresh-"));
const home = join(work, "home");
const appData = join(home, "AppData", "Roaming");
const prefix = join(work, "prefix");
for (const d of [home, appData, prefix]) mkdirSync(d, { recursive: true });

// The user's environment, minus anything Snout reads, with an empty home and config folder.
const ENV = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, XDG_CONFIG_HOME: join(home, ".config"), npm_config_prefix: prefix, npm_config_cache: join(work, "npm-cache") };
for (const k of Object.keys(ENV)) if (/^(SNOUT_|CLAUDE_|CODEX_)/.test(k)) delete ENV[k];
const configDir = process.platform === "win32" ? join(appData, "snout") : join(home, ".config", "snout");

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, env: ENV, shell: process.platform === "win32" && !cmd.endsWith(".exe") && cmd !== process.execPath, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};
const tree = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

// ---------------------------------------------------------------- install

const tarball = join(work, sh("npm", ["pack", "--silent", "--pack-destination", work], { cwd: ROOT }).trim().split(/\r?\n/).pop());
const homeBefore = tree(home);
sh("npm", ["install", "-g", "--offline", "--no-audit", "--no-fund", "--prefix", prefix, tarball], { cwd: work });
const installed = join(prefix, process.platform === "win32" ? "" : "lib", "node_modules", "usesnout");
const SNOUT = join(installed, "dist", "snout.mjs");
const plugin = join(work, "plugin");
mkdirSync(plugin);
// Relative paths: GNU tar (Git Bash) reads "C:" as a remote host.
sh("tar", ["-xzf", basename(tarball), "-C", "plugin"], { cwd: work });
const pluginRoot = join(plugin, "package");

/** A new Node project per agent, so each agent's notes come from its own sessions. */
function newProject(name) {
  const dir = join(work, name);
  mkdirSync(dir);
  sh("git", ["init", "-q"], { cwd: dir });
  sh("git", ["config", "user.email", "fresh@example.com"], { cwd: dir });
  sh("git", ["config", "user.name", "Fresh Install"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fresh", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(dir, "add.js"), "export const add = (a, b) => a + b;\n");
  writeFileSync(join(dir, "add.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./add.js";\ntest("add", () => assert.equal(add(1, 2), 3));\n');
  sh("git", ["add", "-A"], { cwd: dir });
  sh("git", ["commit", "-q", "-m", "Start"], { cwd: dir });
  return dir;
}
const PROJECTS = { claude: newProject("project-claude"), codex: newProject("project-codex") };
let project = PROJECTS.codex;
const snout = (...args) => sh(process.execPath, [SNOUT, ...args], { cwd: project });
snout("init", "codex");
const homeAfterInstall = tree(home);

// ---------------------------------------------------------------- the stand-in agents

const hooksOf = (file, root) => {
  const spec = JSON.parse(readFileSync(file, "utf8")).hooks ?? {};
  return Object.fromEntries(Object.entries(spec).map(([event, groups]) => [event, groups.flatMap((g) => g.hooks.map((h) => h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", root ?? "")))]));
};
const AGENTS = {
  claude: { hooks: hooksOf(join(pluginRoot, "hooks", "hooks.json"), pluginRoot), env: { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: PROJECTS.claude } },
  codex: { hooks: hooksOf(join(PROJECTS.codex, ".codex", "hooks.json")), env: {} },
};

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const said = [];

function fire(agent, event, session, transcript, payload) {
  const input = JSON.stringify({ session_id: session, cwd: project, hook_event_name: event, transcript_path: transcript, ...(agent === "codex" ? { model: "stand-in" } : {}), ...payload });
  for (const command of AGENTS[agent].hooks[event] ?? []) {
    const r = spawnSync(command, { cwd: project, input, encoding: "utf8", shell: true, windowsHide: true, env: { ...ENV, ...AGENTS[agent].env } });
    const out = r.stdout.trim();
    if (r.status !== 0 || r.stderr.trim()) said.push({ agent, event, session, error: `${r.status} ${r.stderr.trim().slice(0, 300)}` });
    if (out) said.push({ agent, event, session, prompt: payload.prompt, out: JSON.parse(out) });
  }
}

/** One session: a prompt, maybe a passing test run, a last message. Returns what Snout added to it. */
function session(agent, prompt, { runTests = false, final = "Done." } = {}) {
  const id = `${agent}-${uid()}`;
  const transcript = join(work, agent === "codex" ? `rollout-${id}.jsonl` : `${id}.jsonl`);
  const ts = () => new Date().toISOString();
  const claude = (type, content) => appendFileSync(transcript, JSON.stringify({ type, sessionId: id, uuid: uid(), cwd: project, timestamp: ts(), message: { role: type, content, ...(type === "assistant" ? { id: `msg_${uid()}`, model: "stand-in", usage: { input_tokens: 3, output_tokens: 20 } } : {}) } }) + "\n");
  const rollout = (type, payload) => appendFileSync(transcript, JSON.stringify({ timestamp: ts(), type, payload }) + "\n");
  const start = said.length;
  if (agent === "codex") rollout("session_meta", { id, cwd: project, originator: "stand-in" });
  fire(agent, "SessionStart", id, transcript, { source: "startup" });
  fire(agent, "UserPromptSubmit", id, transcript, { prompt });
  if (agent === "claude") claude("user", prompt); else rollout("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  if (runTests) {
    const out = spawnSync("npm", ["test"], { cwd: project, encoding: "utf8", shell: process.platform === "win32", env: ENV, windowsHide: true });
    const text = `${out.stdout}${out.stderr}`;
    const call = `call_${uid()}`;
    if (agent === "claude") { claude("assistant", [{ type: "tool_use", id: call, name: "Bash", input: { command: "npm test" } }]); claude("user", [{ type: "tool_result", tool_use_id: call, content: text }]); }
    else { rollout("response_item", { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "npm test" }), call_id: call }); rollout("response_item", { type: "function_call_output", call_id: call, output: text }); }
    fire(agent, "PostToolUse", id, transcript, { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: call, tool_response: agent === "claude" ? { stdout: text, stderr: "", interrupted: false, isImage: false } : text });
  }
  if (agent === "claude") claude("assistant", [{ type: "text", text: final }]); else rollout("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: final }] });
  fire(agent, "Stop", id, transcript, agent === "codex" ? { last_assistant_message: final } : {});
  return said.slice(start);
}

/** Text that reaches the agent: additionalContext (and Codex's plain stdout), not what only the user sees. */
const agentText = (rows) => rows.flatMap((r) => [r.out?.hookSpecificOutput?.additionalContext, r.out?.additionalContext].filter(Boolean)).join("\n");
const userText = (rows) => rows.flatMap((r) => [r.out?.systemMessage].filter(Boolean)).join("\n");

const FIX = "The add tests fail after my change. Run the tests and fix it.";
const result = { label: LABEL, ranAt: new Date().toISOString(), node: process.version, agents: {} };
for (const agent of ["claude", "codex"]) {
  project = PROJECTS[agent];
  snout("mode", "observe");
  const first = session(agent, "Add a subtract function to add.js and make sure the tests pass.", { runTests: true, final: "Added subtract; npm test passes." });
  const observe = session(agent, FIX);
  snout("mode", "enforce");
  const enforce = session(agent, FIX);
  // Automatic notes are opt-in: enforce alone shows none; `snout memory notes on` turns them on.
  snout("memory", "notes", "on");
  const notesOn = session(agent, FIX);
  snout("memory", "notes", "off");
  snout("mode", "observe");
  const recallRows = readFileSync(join(project, ".snout", "recall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "inject");
  result.agents[agent] = {
    hooks: Object.fromEntries(Object.entries(AGENTS[agent].hooks).map(([e, c]) => [e, c.length])),
    first: { agent: agentText(first), user: userText(first) },
    observe: { agent: agentText(observe), user: userText(observe), recorded: recallRows.filter((r) => r.injected === false).length },
    enforce: { agent: agentText(enforce), user: userText(enforce) },
    notesOn: { agent: agentText(notesOn), user: userText(notesOn) },
  };
}
const indexFiles = tree(join(configDir, "index")).filter((f) => f.endsWith(".sqlite"));
result.install = {
  homeWrittenAtInstall: homeAfterInstall.filter((f) => !homeBefore.includes(f) && !f.startsWith(".npm") && !f.includes("npm-cache")),
  codexFiles: tree(join(PROJECTS.codex, ".codex")),
  defaultMode: "observe",
};
result.index = { inConfig: indexFiles, inProject: Object.values(PROJECTS).flatMap((p) => tree(p)).filter((f) => /\.sqlite/.test(f)) };
result.errors = said.filter((r) => r.error);

const checks = [];
const check = (name, ok) => checks.push({ name, ok: !!ok });
check("nothing written to the home or config folder at install", result.install.homeWrittenAtInstall.length === 0);
for (const agent of ["claude", "codex"]) {
  const a = result.agents[agent];
  check(`${agent}: no Snout memory text reaches the agent in observe`, !/Snout memory/.test(a.first.agent + a.observe.agent));
  check(`${agent}: the fitting note is recorded in observe, not shown`, a.observe.recorded > 0);
  check(`${agent}: enforce alone shows no note (automatic notes are opt-in)`, !/Snout memory/.test(a.enforce.agent));
  check(`${agent}: with notes on, enforce shows the test command with where it came from`, /Run the tests with: npm test/.test(a.notesOn.agent) && /seen in a passing test run/.test(a.notesOn.agent));
}
check("no hook failed or wrote to stderr", result.errors.length === 0);
const sqlite = Number(process.versions.node.split(".")[0]) > 22 || (process.versions.node.startsWith("22.") && Number(process.versions.node.split(".")[1]) >= 13);
if (sqlite) check("the local index is in the config folder, one per project", indexFiles.length === 2);
check("no index file in the project", result.index.inProject.length === 0);
result.checks = checks;
result.pass = checks.every((c) => c.ok);

const outDir = join(ROOT, "bench", "fresh-install");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `results-${LABEL}.json`), `${JSON.stringify(result, null, 1)}\n`);
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}`);
console.log(`${result.pass ? "PASS" : "FAIL"}: bench/fresh-install/results-${LABEL}.json`);
try { rmSync(work, { recursive: true, force: true }); } catch { console.error(`left ${work} behind`); }
process.exitCode = result.pass ? 0 : 1;
