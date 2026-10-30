#!/usr/bin/env node
/**
 * Gate 3, local recall (docs/memory-gates.md). Replays a scripted project history through Snout's
 * real hooks, CLI and MCP server, then asks about 40 prompts three ways and scores what comes back.
 *
 *   node bench/recall-gate.mjs --freeze          record the hashes of the inputs and this scorer
 *   node bench/recall-gate.mjs --label baseline  run, and write bench/recall-gate/results-baseline.json
 *   node bench/recall-gate.mjs --set unseen ...   the same, for the inputs in bench/recall-gate/unseen/
 *   node bench/recall-gate.mjs --semantic ...     with the optional local model (memorySemantic on), from
 *                                                 ~/.snout-bench/model-cfg/model (--model-dir), served by
 *                                                 `snout serve` on a port of the run's own (--port, 47790)
 *
 * The inputs (bench/recall-gate/history.json, prompts.json) and this file are frozen before any fix:
 * a run refuses to start if one of them changed since --freeze. Nothing here calls a model or the
 * network; sessions are stand-ins whose transcripts are written in each agent's format, and every
 * command's output is scripted. Snout's records go to a scratch folder, never the user's own.
 *
 * The three paths:
 *   delivery   the prompt hook in enforce mode, in a new session, for Claude Code and for Codex
 *   recall     `snout recall "<prompt>"`
 *   search     the MCP tool snout_memory_search, with the prompt's short query
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const SET = flag("--set") ?? "";
const REL = ["bench/recall-gate", ...(SET ? [SET] : [])].join("/");
const DIR = join(ROOT, ...REL.split("/"));
const CLI = join(ROOT, "dist", "snout.mjs");
const FROZEN = [`${REL}/history.json`, `${REL}/prompts.json`, "bench/recall-gate.mjs"];

const sha = (rel) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
if (args.includes("--freeze")) {
  writeFileSync(join(DIR, "freeze.json"), JSON.stringify({ frozenAt: new Date().toISOString(), files: Object.fromEntries(FROZEN.map((f) => [f, sha(f)])) }, null, 2) + "\n");
  console.log(`Frozen: ${FROZEN.join(", ")}`);
  process.exit(0);
}
const freeze = JSON.parse(readFileSync(join(DIR, "freeze.json"), "utf8"));
const changed = FROZEN.filter((f) => freeze.files[f] !== sha(f));
if (changed.length) {
  console.error(`Changed since the freeze on ${freeze.frozenAt}: ${changed.join(", ")}. Gate 3's inputs and scorer stay fixed between runs.`);
  process.exit(2);
}

const LABEL = flag("--label") ?? "run";
const history = JSON.parse(readFileSync(join(DIR, "history.json"), "utf8"));
const { prompts } = JSON.parse(readFileSync(join(DIR, "prompts.json"), "utf8"));
const FACTS = Object.fromEntries(Object.entries(history.facts).map(([k, f]) => [k, { ...f, re: new RegExp(f.pattern) }]));
const BAD = ["stale", "wrong-scope", "unsupported"];
/** The default memoryBudget (src/memory/store.ts MEMORY_BUDGET); the gate sets no other. */
const BUDGET = 600;

// ---------------------------------------------------------------- a scratch project

const WORK = resolve(flag("--work") ?? join(homedir(), ".snout-bench", SET ? `g3-${SET}` : "g3"));
rmSync(WORK, { recursive: true, force: true });
const PROJECT = join(WORK, history.project.name);
const TRANSCRIPTS = join(WORK, "transcripts");
mkdirSync(TRANSCRIPTS, { recursive: true });
const ENV = { ...process.env, SNOUT_MODE: "enforce", SNOUT_CONFIG_DIR: join(WORK, "cfg"), SNOUT_HOME: join(WORK, "home") };
for (const k of ["SNOUT_DIR", "SNOUT_TOKEN", "CI", "TYPESAFE_API_KEY", "SNOUT_DISABLE"]) delete ENV[k];

/**
 * PATH is pinned, so a tool the history scripts as missing is missing here whatever this machine
 * has installed: only git, which Snout calls. On Windows that is Git's cmd folder, which holds only
 * Git's own launchers; elsewhere a folder of the run's own with a link to git. The CLI and the hooks
 * run under this Node by its full path. A run refuses to start if a scripted-missing tool is on it.
 */
function pinnedPath() {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!found.length) throw new Error("git is not on PATH");
  if (process.platform === "win32") return dirname(found.find((p) => /[\\/]cmd[\\/]git\.exe$/i.test(p)) ?? found[0]);
  const bin = join(WORK, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(found[0], join(bin, "git"));
  return bin;
}
for (const k of Object.keys(ENV)) if (/^path$/i.test(k)) delete ENV[k];
ENV.PATH = pinnedPath();
// The arm: words alone (the default), or with the optional local model. Either way `snout serve`, if
// anything starts it, listens on a port of the run's own, never the user's.
const SEMANTIC = args.includes("--semantic");
ENV.SNOUT_PORT = String(flag("--port") ?? 47790);
if (SEMANTIC) {
  mkdirSync(join(WORK, "home"), { recursive: true });
  writeFileSync(join(WORK, "home", "config.json"), JSON.stringify({ memorySemantic: true }) + "\n");
  mkdirSync(join(WORK, "cfg"), { recursive: true });
  symlinkSync(resolve(flag("--model-dir") ?? join(homedir(), ".snout-bench", "model-cfg", "model")), join(WORK, "cfg", "model"), "junction");
}
const scriptedMissing = [...new Set(history.steps.flatMap((s) => (s.calls ?? []).flatMap((c) => [...(c.out ?? "").matchAll(/(?:^|\s)([\w.-]+): command not found/gm)].map((m) => m[1]))))];
const present = scriptedMissing.filter((t) => ["", ".exe", ".cmd", ".bat"].some((ext) => existsSync(join(ENV.PATH, t + ext))));
if (present.length) {
  console.error(`The pinned PATH (${ENV.PATH}) has ${present.join(", ")}, which the history scripts as missing.`);
  process.exit(2);
}

const write = (rel, content) => { const p = join(PROJECT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p; };
const git = (...a) => {
  const r = spawnSync("git", a, { cwd: PROJECT, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
for (const [rel, content] of Object.entries(history.project.files)) write(rel, content);
git("init", "-q", "-b", "main");
git("config", "user.email", "dev@tally.test");
git("config", "user.name", "Dev");
git("add", "-A");
git("commit", "-q", "-m", "Initial");

const run = (argv, input) => {
  const r = spawnSync(process.execPath, [CLI, ...argv], { cwd: PROJECT, input: input ?? "", encoding: "utf8", env: ENV, windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`snout ${argv.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};
/** One hook event as the agent sends it. Claude Code runs `snout <command>`; Codex runs `snout hook codex <Event>`. */
const CLAUDE_COMMAND = { SessionStart: "session-start", UserPromptSubmit: "prompt-submit", PostToolUse: "post-tool", Stop: "stop" };
const hook = (agent, event, session, transcript, payload = {}) => {
  const input = JSON.stringify({ session_id: session, cwd: PROJECT, hook_event_name: event, transcript_path: transcript, ...(agent === "codex" ? { model: "stand-in" } : {}), ...payload });
  const out = run(agent === "codex" ? ["hook", "codex", event] : [CLAUDE_COMMAND[event]], input).trim();
  return out ? JSON.parse(out) : null;
};
const mcp = (tool, toolArgs) => {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gate3", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: toolArgs } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const reply = run(["mcp", PROJECT], lines).trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2);
  return { text: reply?.result?.content?.[0]?.text ?? "", error: !!reply?.result?.isError };
};

// The model loads once in `snout serve`; the hooks ask it for vectors. Warm it before anything is timed.
const BASE = `http://127.0.0.1:${ENV.SNOUT_PORT}/snout/v1`;
let serve = null;
let warmMs = null;
if (SEMANTIC) {
  serve = spawn(process.execPath, [CLI, "serve"], { cwd: PROJECT, env: ENV, stdio: "ignore", windowsHide: true });
  const t0 = performance.now();
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${BASE}/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: ["warm"] }) });
      if (r.ok) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  warmMs = Math.round(performance.now() - t0);
}

// ---------------------------------------------------------------- replaying the history

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

function replaySession(step) {
  const session = `${step.id.toLowerCase()}-${uid()}`;
  const agent = step.agent;
  const transcript = join(TRANSCRIPTS, agent === "codex" ? `rollout-${session}.jsonl` : `${session}.jsonl`);
  const ts = () => new Date().toISOString();
  const claude = (type, content) => appendFileSync(transcript, JSON.stringify({ type, sessionId: session, uuid: uid(), cwd: PROJECT, timestamp: ts(), message: { role: type, content, ...(type === "assistant" ? { id: `msg_${uid()}`, model: "stand-in", usage: { input_tokens: 3, output_tokens: 20 } } : {}) } }) + "\n");
  const rollout = (type, payload) => appendFileSync(transcript, JSON.stringify({ timestamp: ts(), type, payload }) + "\n");
  const toolUse = (name, input) => {
    const id = `call_${uid()}`;
    if (agent === "claude") claude("assistant", [{ type: "tool_use", id, name, input }]);
    else if (name === "Bash") rollout("response_item", { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: input.command }), call_id: id });
    else if (name === "Edit") rollout("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: id, input: `*** Begin Patch\n*** Update File: ${input.rel}\n@@\n+…\n*** End Patch` });
    else if (name === "TodoWrite") rollout("response_item", { type: "function_call", name: "update_plan", call_id: id, arguments: JSON.stringify({ plan: input.todos.map((t) => ({ step: t.content, status: t.status })) }) });
    return id;
  };
  const toolResult = (id, out, custom = false) => {
    if (agent === "claude") claude("user", [{ type: "tool_result", tool_use_id: id, content: out }]);
    else rollout("response_item", { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: id, output: out });
  };
  const bash = (command, out) => {
    const id = toolUse("Bash", { command });
    toolResult(id, out);
    hook(agent, "PostToolUse", session, transcript, { tool_name: "Bash", tool_input: { command }, tool_use_id: id, tool_response: agent === "claude" ? { stdout: out, stderr: "", interrupted: false, isImage: false } : out });
  };

  if (agent === "codex") rollout("session_meta", { id: session, cwd: PROJECT, originator: "stand-in" });
  hook(agent, "SessionStart", session, transcript, { source: "startup" });
  hook(agent, "UserPromptSubmit", session, transcript, { prompt: step.prompt });
  if (agent === "claude") claude("user", step.prompt);
  else rollout("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: step.prompt }] });
  for (const m of step.mcp ?? []) mcp(m.tool, m.args);
  for (const c of step.calls) {
    if (c.install) { write(c.install, c.content); continue; }
    if (c.edit) {
      const file = write(c.edit, c.content);
      const id = toolUse("Edit", { file_path: file, rel: c.edit, old_string: "", new_string: c.content });
      toolResult(id, `The file ${file} has been updated.`, true);
      continue;
    }
    if (c.todos) { toolResult(toolUse("TodoWrite", { todos: c.todos }), "Todos updated."); continue; }
    if (c.bash) bash(c.bash, c.out);
  }
  if (step.commit) {
    git("add", "-A");
    git("commit", "-q", "-m", step.commit);
    bash(`git add -A && git commit -m "${step.commit}"`, `[main ${git("rev-parse", "--short", "HEAD")}] ${step.commit}\n`);
  }
  if (agent === "claude") claude("assistant", [{ type: "text", text: step.final }]);
  else rollout("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: step.final }] });
  hook(agent, "Stop", session, transcript, agent === "codex" ? { last_assistant_message: step.final } : {});
}

for (const step of history.steps) {
  if (step.type === "session") replaySession(step);
  else if (step.type === "cli") run(step.args);
  else throw new Error(`unknown step type ${step.type}`);
}

// ---------------------------------------------------------------- asking

const context = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
const timed = (fn) => { const t0 = performance.now(); const v = fn(); return [v, Math.round(performance.now() - t0)]; };
const asked = prompts.map((p) => {
  const ask = (agent) => {
    const session = `q-${p.id.toLowerCase()}-${agent}-${uid()}`;
    const transcript = join(TRANSCRIPTS, `${session}.jsonl`);
    hook(agent, "SessionStart", session, transcript, { source: "startup" });
    return timed(() => context(hook(agent, "UserPromptSubmit", session, transcript, { prompt: p.prompt })));
  };
  const [delivery, deliveryMs] = ask("claude");
  const [deliveryCodex] = ask("codex");
  const [recall, recallMs] = timed(() => run(["recall", p.prompt]).trim());
  const [s, searchMs] = timed(() => mcp("snout_memory_search", { query: p.query }));
  return { p, out: { delivery, recall, search: s.error ? "" : s.text }, deliveryCodex, searchError: s.error ? s.text : undefined, ms: { delivery: deliveryMs, recall: recallMs, search: searchMs } };
});
if (serve) { await fetch(`${BASE}/shutdown`, { method: "POST" }).catch(() => {}); serve.kill(); }

// ---------------------------------------------------------------- scoring

const SILENT = { delivery: (t) => !t.trim(), recall: (t) => !t.trim() || /^No earlier session bears/.test(t), search: (t) => !t.trim() || /^Nothing in memory matches/.test(t) };
const tokens = (t) => Math.ceil(Buffer.byteLength(t) / 4);

/** Results in the order shown: each "- " line with the indented lines under it. */
function units(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) out.push(line);
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1] += `\n${line}`;
  }
  return out;
}

const NOTE = { delivery: /^- (?:convention|decision|gotcha|preference|command|fact): /, search: /^- o_[a-f0-9]{12}\s/ };
/**
 * Rule 1: a note shown points to the record behind it. A test command quotes the run's result, a
 * missing tool the error it gave, anything else says the user added, accepted, asked for or
 * repeated it. A session record is its own source: it carries its date and agent.
 */
function cited(path, unit) {
  if (path === "recall") return /^- \d{4}-\d{2}-\d{2} · (?:claude|codex)/.test(unit);
  if (path === "search" && /^- session:/.test(unit)) return /^- session:\S+\s+(?:claude|codex)\s+\d{4}-\d{2}-\d{2}/.test(unit);
  if (!NOTE[path].test(unit)) return true; // "where you left off": a session record with its agent and age in the heading
  if (/Run the tests with/.test(unit)) return /\b\d+ passed\b|\bpass \d+\b/.test(unit);
  if (/is not installed/.test(unit)) return /command not found|is not recognized/.test(unit);
  return /added by you|accepted by you|asked by you|you asked|you said it in/.test(unit);
}

const PATHS = ["delivery", "recall", "search"];
const rows = asked.map(({ p, out, deliveryCodex, searchError, ms }) => {
  const row = { id: p.id, prompt: p.prompt, query: p.query, paths: {}, agentsAgree: out.delivery === deliveryCodex, ms };
  for (const path of PATHS) {
    const text = out[path];
    const expect = p[path];
    const shown = !SILENT[path](text);
    const u = shown ? units(text) : [];
    const first = u[0] ?? "";
    const answered = Array.isArray(expect) ? shown && expect.some((k) => FACTS[k].re.test(first)) : expect === "silent" ? !shown : null;
    const bad = shown ? Object.entries(FACTS).filter(([, f]) => BAD.includes(f.class) && f.re.test(text)).map(([k, f]) => ({ fact: k, class: f.class })) : [];
    const uncited = u.filter((x) => !cited(path, x));
    row.paths[path] = { expect, shown, answered, bad, uncited, tokens: path === "delivery" ? tokens(text) : undefined, text, ...(path === "search" && searchError ? { error: searchError } : {}) };
  }
  return row;
});

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const summary = {};
for (const path of PATHS) {
  const r = rows.map((x) => x.paths[path]);
  const answerable = r.filter((x) => Array.isArray(x.expect));
  const silent = r.filter((x) => x.expect === "silent");
  const byClass = Object.fromEntries(BAD.map((c) => [c, rows.flatMap((x) => x.paths[path].bad.filter((b) => b.class === c).map((b) => `${x.id}:${b.fact}`))]));
  summary[path] = {
    answerFirst: { ok: answerable.filter((x) => x.answered).length, of: answerable.length },
    silence: { ok: silent.filter((x) => x.answered).length, of: silent.length },
    stale: byClass.stale, wrongScope: byClass["wrong-scope"], unsupported: byClass.unsupported,
    uncited: rows.flatMap((x) => x.paths[path].uncited.map((u) => `${x.id}: ${u.split("\n")[0].slice(0, 140)}`)),
    ...(path === "delivery" ? { tokensMedian: median(r.filter((x) => x.shown).map((x) => x.tokens)), tokensMax: Math.max(0, ...r.map((x) => x.tokens)) } : {}),
  };
}
const pct95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? 0; };
summary.timing = Object.fromEntries(PATHS.map((p) => [p, { medianMs: median(rows.map((r) => r.ms[p])), p95Ms: pct95(rows.map((r) => r.ms[p])) }]));
summary.agentsAgree = { ok: rows.filter((x) => x.agentsAgree).length, of: rows.length, differ: rows.filter((x) => !x.agentsAgree).map((x) => x.id) };

const pct = (o) => (o.of ? o.ok / o.of : 1);
const criteria = [
  ...PATHS.map((p) => [`${p}: right and current answer first >= 90%`, pct(summary[p].answerFirst) >= 0.9, `${summary[p].answerFirst.ok}/${summary[p].answerFirst.of}`]),
  ["stale facts shown: none", PATHS.every((p) => !summary[p].stale.length), PATHS.map((p) => `${p} ${summary[p].stale.length}`).join(", ")],
  ["facts shown without a checkable record: none", PATHS.every((p) => !summary[p].uncited.length && !summary[p].unsupported.length), PATHS.map((p) => `${p} ${summary[p].uncited.length} uncited + ${summary[p].unsupported.length} unsupported`).join(", ")],
  ["commands shown outside their project or folder: none", PATHS.every((p) => !summary[p].wrongScope.length), PATHS.map((p) => `${p} ${summary[p].wrongScope.length}`).join(", ")],
  ["delivery: median <= 150 tokens, max <= budget", summary.delivery.tokensMedian <= 150 && summary.delivery.tokensMax <= BUDGET, `median ${summary.delivery.tokensMedian}, max ${summary.delivery.tokensMax} (budget ${BUDGET})`],
  ...PATHS.map((p) => [`${p}: nothing shown on unanswerable prompts >= 90%`, pct(summary[p].silence) >= 0.9, `${summary[p].silence.ok}/${summary[p].silence.of}`]),
  ["Claude Code and Codex get the same delivery", summary.agentsAgree.ok === summary.agentsAgree.of, `${summary.agentsAgree.ok}/${summary.agentsAgree.of}`],
];
const pass = criteria.every((c) => c[1]);

const outFile = join(DIR, `results-${LABEL}.json`);
const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
writeFileSync(outFile, JSON.stringify({ label: LABEL, arm: SEMANTIC ? "semantic" : "words", warmMs, ranAt: new Date().toISOString(), snout: { head, dist: sha("dist/snout.mjs") }, freeze, pass, criteria: criteria.map(([name, ok, detail]) => ({ name, ok, detail })), summary, rows }, null, 1) + "\n");

console.log(`Gate 3 (${LABEL}, ${SEMANTIC ? `words + local model, warm-up ${warmMs} ms` : "words"}): ${pass ? "PASS" : "FAIL"}\n`);
console.log(`  time per call, median / p95: ${PATHS.map((p) => `${p} ${summary.timing[p].medianMs} / ${summary.timing[p].p95Ms} ms`).join(", ")}\n`);
for (const [name, ok, detail] of criteria) console.log(`  ${ok ? "pass" : "FAIL"}  ${name}: ${detail}`);
for (const path of PATHS) {
  const s = summary[path];
  const misses = rows.filter((x) => x.paths[path].answered === false).map((x) => x.id);
  console.log(`\n  ${path}: missed ${misses.join(" ") || "none"}`);
  for (const [k, list] of [["stale", s.stale], ["wrong scope", s.wrongScope], ["unsupported", s.unsupported]]) if (list.length) console.log(`    ${k}: ${list.join(" ")}`);
  if (s.uncited.length) console.log(`    uncited (${s.uncited.length}): ${[...new Set(s.uncited.map((u) => u.replace(/^P\d+: /, "")))].slice(0, 6).join(" | ")}`);
}
console.log(`\n  ${outFile}`);
process.exitCode = pass ? 0 : 1;
