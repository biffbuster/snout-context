#!/usr/bin/env node
/**
 * A stand-in for `codex exec --json` that costs nothing: bench/realrepo.mjs runs it with
 * SWE_FAKE_AGENT=1 for the Codex steps of a chain, as bench/fake-claude.mjs stands in for Claude
 * Code. It fires the hooks in the workspace's .codex/hooks.json the way Codex does (JSON on stdin),
 * writes a session file in Codex's rollout format (so Snout's Stop hook makes the session's card
 * from it), runs a long passing test, leaves a plan with one step open, applies the gold patch from
 * SWE_FAKE_PATCH, and prints Codex's JSONL events with nominal token counts.
 *
 * What the SessionStart hook brought in is written to stderr, so a dry run shows whether notes from
 * the Claude Code steps reached Codex.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fakeMcpCalls } from "./fake-mcp.mjs";

const argv = process.argv.slice(2);
const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const cwd = at("-C") ?? process.cwd();
const prompt = argv.at(-1) ?? "";
const thread = randomUUID();
const log = (s) => process.stderr.write(`[fake-codex] ${s}\n`);
// The hooks Codex would run: the workspace's own, or (CODEX_HOOKS_FILE) the trusted checkout's that a workspace inside it inherits.
const hooksFile = process.env.CODEX_HOOKS_FILE || join(cwd, ".codex/hooks.json");
const hooks = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, "utf8")).hooks ?? {} : {};
const transcript_path = join(process.env.CODEX_HOME || join(tmpdir(), "snout-fake-codex"), "sessions", `rollout-${thread}.jsonl`);
mkdirSync(join(transcript_path, ".."), { recursive: true });
const rollout = (type, payload) => appendFileSync(transcript_path, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n");

function fire(event, payload) {
  const outs = [];
  for (const entry of hooks[event] ?? []) {
    if (entry.matcher && payload.tool_name && !new RegExp(entry.matcher).test(payload.tool_name)) continue;
    for (const h of entry.hooks ?? []) {
      if (h.type !== "command") continue;
      const r = spawnSync(h.command, { shell: true, cwd, input: JSON.stringify({ session_id: thread, transcript_path, cwd, hook_event_name: event, model: "fake-codex", ...payload }), encoding: "utf8", timeout: 60_000 });
      if (r.status !== 0 && r.status !== 2) log(`${event} hook exited ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}`);
      try { outs.push(r.stdout.trim() ? JSON.parse(r.stdout) : null); } catch { log(`${event} hook printed non-JSON: ${r.stdout.slice(0, 120)}`); }
    }
  }
  return outs;
}

let call = 0;
function shell(command, output) {
  const id = `call_${call++}`;
  fire("PreToolUse", { tool_name: "Bash", tool_input: { command }, tool_use_id: id });
  rollout("response_item", { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command }), call_id: id });
  rollout("response_item", { type: "function_call_output", call_id: id, output });
  const post = fire("PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_response: output, tool_use_id: id });
  log(`${command.slice(0, 40)}: ${post.some((o) => o?.hookSpecificOutput?.additionalContext || o?.decision) ? "trimmed" : "passed through"}`);
}

rollout("session_meta", { id: thread, cwd, originator: "fake-codex" });
const start = fire("SessionStart", { source: "startup" }).map((o) => o?.hookSpecificOutput?.additionalContext).filter(Boolean).join("\n");
log(start ? `session start brought in ${start.length} chars${/left off/.test(start) ? " (where the last session left off)" : ""}${/Run the tests with|Tests run here/.test(start) ? " (the test command)" : ""}` : "session start brought in nothing");
fire("UserPromptSubmit", { prompt });
rollout("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });

const fakeTestCommand = process.env.SWE_FAKE_TEST_COMMAND || "go test ./hugolib/...";
const passing = fakeTestCommand.startsWith("node --test")
  ? Array.from({ length: 300 }, (_, i) => `ok ${i + 1} - case ${i}`).join("\n") + "\n# tests 300\n# pass 300\n# fail 0\n"
  : Array.from({ length: 300 }, (_, i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`).join("\n") + "\nok  \tgithub.com/gohugoio/hugo/hugolib\t4.210s\n";
shell(fakeTestCommand, passing);
rollout("response_item", { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Find the cause", status: "completed" }, { step: "Add a regression test", status: "pending" }] }), call_id: `call_${call++}` });

if (process.env.SWE_FAKE_PATCH && existsSync(process.env.SWE_FAKE_PATCH)) {
  const patch = readFileSync(process.env.SWE_FAKE_PATCH, "utf8");
  // A workspace whose repository is kept outside it (SWE_FAKE_GIT_DIR) is patched through that repository.
  const gitArgs = process.env.SWE_FAKE_GIT_DIR ? ["--git-dir", process.env.SWE_FAKE_GIT_DIR, "--work-tree", cwd] : [];
  const r = spawnSync("git", [...gitArgs, "apply", "--whitespace=nowarn", process.env.SWE_FAKE_PATCH], { cwd, encoding: "utf8" });
  log(r.status === 0 ? "gold patch applied" : `gold patch failed: ${r.stderr.trim().slice(0, 200)}`);
  const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim());
  rollout("response_item", { type: "custom_tool_call", name: "apply_patch", input: files.map((f) => `*** Begin Patch\n*** Update File: ${f}\n*** End Patch`).join("\n"), call_id: `call_${call++}` });
}
// SWE_FAKE_MCP: tool calls a real agent might make on its MCP server, made before Stop (bench/fake-mcp.mjs).
for (const c of fakeMcpCalls()) {
  const id = `call_${call++}`;
  rollout("response_item", { type: "function_call", name: `mcp__snout__${c.name}`, arguments: JSON.stringify(c.arguments), call_id: id });
  rollout("response_item", { type: "function_call_output", call_id: id, output: c.text });
  log(`${c.name}: ${c.text.slice(0, 80)}`);
}
// SWE_FAKE_SAY: the closing summary a real agent writes, which Snout keeps as the session's outcome (bench/handoff-check.mjs).
rollout("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: process.env.SWE_FAKE_SAY || "fake codex: fixed it; the regression test is still to write." }] });
fire("Stop", {});

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "thread.started", thread_id: thread });
out({ type: "item.completed", item: { type: "agent_message", text: "fake codex: done" } });
out({ type: "turn.completed", usage: { input_tokens: 24_000, cached_input_tokens: 18_000, output_tokens: 600, reasoning_output_tokens: 200 } });
