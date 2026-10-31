#!/usr/bin/env node
/**
 * A stand-in for `claude -p` that costs nothing: the SWE-bench harness runs it with
 * SWE_FAKE_AGENT=1 to check everything around the agent before a paid run. It fires the hooks in
 * the workspace's .claude/settings.json the way Claude Code does (JSON on stdin, through Git Bash
 * on Windows), feeds them a large Read, a repeat of it and a long passing test run, applies the
 * gold patch from SWE_FAKE_PATCH, and prints Claude Code's JSON result with a nominal cost. For long
 * sessions (bench/swelong.mjs) it continues a session with --resume, works in the issue folder named
 * in .current, and before every second issue runs a compaction's hooks to see what Snout restores.
 *
 * What each hook answered is written to stderr, so a dry run shows whether Snout stepped in.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fakeMcpCalls } from "./fake-mcp.mjs";

const cwd = process.cwd();
// Long sessions (bench/swelong.mjs): --resume continues a session, and the issue's own folder is in
// .current (the session runs in the chain folder above it).
const resumed = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : null;
const given = process.argv.includes("--session-id") ? process.argv[process.argv.indexOf("--session-id") + 1] : null;
const session_id = resumed ?? given ?? randomUUID();
const work = existsSync(".current") ? readFileSync(".current", "utf8").trim() : cwd;
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
const issue = Number(/Issue (\d+) of \d+:/.exec(prompt)?.[1] ?? 0);
const settings = existsSync(".claude/settings.json") ? JSON.parse(readFileSync(".claude/settings.json", "utf8")) : {};
const hooks = settings.hooks ?? {};
const BASH = process.platform === "win32"
  ? process.env.CLAUDE_CODE_GIT_BASH_PATH || ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find(existsSync)
  : "bash";
const log = (s) => process.stderr.write(`[fake] ${s}\n`);
const answers = [];
// A transcript in Claude Code's format and place (the config folder's projects/), kept across
// --resume: a compaction's hooks restore from it and the harness prices the session from it.
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "claude-haiku-5-5";
const transcript_path = join(process.env.CLAUDE_CONFIG_DIR || join(tmpdir(), "snout-fake-claude"), "projects", "fake", `${session_id}.jsonl`);
mkdirSync(join(transcript_path, ".."), { recursive: true });
// Each assistant turn carries usage as the API returns it, the prompt growing by what was said.
let context = existsSync(transcript_path) ? Math.round(statSync(transcript_path).size / 4) : 0;
const row = (o) => appendFileSync(transcript_path, JSON.stringify({ sessionId: session_id, uuid: randomUUID(), cwd, ...o }) + "\n");
const record = (type, content) => {
  const usage = type === "assistant" ? { input_tokens: 3, cache_read_input_tokens: 20_000 + context, cache_creation_input_tokens: 400, output_tokens: 120 } : undefined;
  row({ type, message: { role: type, content, ...(usage ? { id: `msg_${randomUUID()}`, model, usage } : {}) } });
  context += Math.round(JSON.stringify(content).length / 4);
};

/** Every hook of `event` whose matcher (and `if` rule) fits the tool call; returns their parsed outputs. */
function fire(event, payload) {
  const outs = [];
  for (const entry of hooks[event] ?? []) {
    if (entry.matcher && payload.tool_name && !new RegExp(`^(?:${entry.matcher})$`).test(payload.tool_name)) continue;
    for (const h of entry.hooks ?? []) {
      if (h.type !== "command") continue;
      if (h.if) {
        const m = /^Bash\((\S+) \*\)$/.exec(h.if);
        if (m && !String(payload.tool_input?.command ?? "").startsWith(m[1] + " ")) continue;
      }
      const r = spawnSync(BASH, ["-c", h.command], { cwd, input: JSON.stringify({ session_id, transcript_path, cwd, hook_event_name: event, ...payload }), encoding: "utf8", timeout: (h.timeout ?? 60) * 1000 });
      if (r.status !== 0 && r.status !== 2) log(`${event} hook exited ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}`);
      let out = null;
      try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { log(`${event} hook printed non-JSON: ${r.stdout.slice(0, 120)}`); }
      outs.push(out);
    }
  }
  return outs;
}

/** The largest Python file, or in a repository without Python (bench/realrepo.mjs) the largest Go or TypeScript file. */
function biggestSource() {
  const best = { py: null, other: null };
  const walk = (d, depth) => {
    if (depth > 6) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        const k = e.name.endsWith(".py") ? "py" : /.(go|ts)$/.test(e.name) ? "other" : null;
        if (k) { const s = statSync(p).size; if (!best[k] || s > best[k].size) best[k] = { p, size: s }; }
      }
    }
  };
  walk(work, 0);
  return (best.py ?? best.other)?.p;
}

function tool(name, input, response) {
  const pre = fire("PreToolUse", { tool_name: name, tool_input: input });
  const deny = pre.find((o) => o?.hookSpecificOutput?.permissionDecision === "deny");
  if (deny) { answers.push(`${name}: denied`); log(`${name} denied: ${deny.hookSpecificOutput.permissionDecisionReason.slice(0, 120)}`); return; }
  const id = `toolu_${randomUUID().replace(/-/g, "")}`;
  record("assistant", [{ type: "tool_use", id, name, input }]);
  const post = fire("PostToolUse", { tool_name: name, tool_input: input, tool_response: response, tool_use_id: id });
  const upd = post.find((o) => o?.hookSpecificOutput?.updatedToolOutput);
  const shown = upd ? upd.hookSpecificOutput.updatedToolOutput : response;
  record("user", [{ type: "tool_result", tool_use_id: id, content: typeof shown === "string" ? shown : shown.stdout ?? shown.file?.content ?? JSON.stringify(shown) }]);
  answers.push(`${name}: ${upd ? "trimmed" : "passed"}`);
  log(`${name} ${upd ? `trimmed to ${JSON.stringify(upd.hookSpecificOutput.updatedToolOutput).length} chars from ${JSON.stringify(response).length}` : "passed through"}`);
}

fire("SessionStart", { source: resumed ? "resume" : "startup" });
// Every second issue of a long session, a compaction as Claude Code runs one: PreCompact, then
// SessionStart with source "compact", whose additionalContext is what Snout restores.
if (resumed && issue % 2 === 0) {
  fire("PreCompact", { trigger: "auto", custom_instructions: "" });
  row({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 20_000 + context } });
  row({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation (stand-in summary)." } });
  context = 0;
  const restored = fire("SessionStart", { source: "compact" }).map((o) => o?.hookSpecificOutput?.additionalContext).filter(Boolean);
  answers.push(`compaction: ${restored.length ? "restored" : "nothing restored"}`);
  log(`compaction before issue ${issue}: ${restored.length ? `Snout restored ${restored.join("").length} chars` : "nothing restored"}`);
}
fire("UserPromptSubmit", { prompt });
record("user", prompt);

const big = biggestSource();
if (big) {
  const content = readFileSync(big, "utf8");
  const lines = content.split("\n");
  const resp = { type: "text", file: { filePath: big, content, numLines: lines.length, startLine: 1, totalLines: lines.length } };
  tool("Read", { file_path: big }, resp);
  tool("Read", { file_path: big }, resp); // the repeat
  log(`read ${relative(work, big)} (${lines.length} lines) twice`);
}
const fakeTestCommand = process.env.SWE_FAKE_TEST_COMMAND || "python -m pytest -v tests/test_mod.py";
const passing = fakeTestCommand.startsWith("node --test")
  ? Array.from({ length: 300 }, (_, i) => `ok ${i + 1} - case ${i}`).join("\n") + "\n# tests 300\n# pass 300\n# fail 0\n"
  : Array.from({ length: 300 }, (_, i) => `tests/test_mod.py::test_case_${i} PASSED`).join("\n") + "\n============ 300 passed in 4.21s ============\n";
tool("Bash", { command: fakeTestCommand }, { stdout: passing, stderr: "", interrupted: false, isImage: false });

if (process.env.SWE_FAKE_PATCH && existsSync(process.env.SWE_FAKE_PATCH)) {
  const r = spawnSync("git", ["apply", "--whitespace=nowarn", process.env.SWE_FAKE_PATCH], { cwd: work, encoding: "utf8" });
  log(r.status === 0 ? "gold patch applied" : `gold patch failed: ${r.stderr.trim().slice(0, 200)}`);
  // The edits, as Edit calls in the transcript, so a restore can name the files changed.
  for (const m of readFileSync(process.env.SWE_FAKE_PATCH, "utf8").matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const file_path = join(work, m[1].trim());
    record("assistant", [{ type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "")}`, name: "Edit", input: { file_path, old_string: "", new_string: "" } }]);
  }
}
// SWE_FAKE_MCP: tool calls a real agent might make on its MCP server, made before Stop (bench/fake-mcp.mjs).
for (const c of fakeMcpCalls()) {
  const id = `toolu_${randomUUID().replace(/-/g, "")}`;
  record("assistant", [{ type: "tool_use", id, name: `mcp__snout__${c.name}`, input: c.arguments }]);
  record("user", [{ type: "tool_result", tool_use_id: id, content: c.text }]);
  log(`${c.name}: ${c.text.slice(0, 80)}`);
}
// SWE_FAKE_SAY: the closing summary a real agent writes, which Snout keeps as the session's outcome (bench/handoff-check.mjs).
if (process.env.SWE_FAKE_SAY) record("assistant", [{ type: "text", text: process.env.SWE_FAKE_SAY }]);
// SWE_FAKE_AUTO_MEMORY_DIR: Claude Code's own memory for this folder (bench/handoff-check.mjs, ownMemory).
// The stand-in keeps its closing summary there, so a dry run shows what each session starts from.
if (process.env.SWE_FAKE_AUTO_MEMORY_DIR && process.env.SWE_FAKE_SAY) {
  mkdirSync(process.env.SWE_FAKE_AUTO_MEMORY_DIR, { recursive: true });
  appendFileSync(join(process.env.SWE_FAKE_AUTO_MEMORY_DIR, "MEMORY.md"), `- ${process.env.SWE_FAKE_SAY}\n`);
}
fire("Stop", {});

process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: `fake agent: ${answers.join(", ")}`, session_id, num_turns: 4,
  total_cost_usd: 0.001, usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 50 },
}));
