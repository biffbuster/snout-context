// Codex session files read for memory after compaction: the formats memory.test.mjs doesn't cover,
// shaped like real codex-cli and Codex desktop 0.153 records (`~/.codex/sessions`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSessionFacts, memoryText } from "../dist/lib.mjs";

const line = (type, payload) => ({ timestamp: "2026-10-13T10:00:00.000Z", type, payload });
const said = (text, kinds) => line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }], ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}) });
const call = (id, name, args) => line("response_item", { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const cell = (id, input) => line("response_item", { type: "custom_tool_call", call_id: id, name: "exec", input });
const output = (id, text) => line("response_item", { type: "function_call_output", call_id: id, output: text });
const cellOutput = (id, text) => line("response_item", { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text }] });

function rollout(rows) {
  const dir = mkdtempSync(join(tmpdir(), "snout-codex-"));
  const file = join(dir, "rollout-2026-10-13T10-00-00-s1.jsonl");
  writeFileSync(file, [line("session_meta", { id: "s1", cwd: dir }), ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, file };
}

test("codex: injected context is never the request, with or without Codex's metadata", () => {
  const { dir, file } = rollout([
    said("# AGENTS.md instructions for C:\\repo\n\n<INSTRUCTIONS>Always use tabs.</INSTRUCTIONS>"),
    said("<environment_context><cwd>C:\\repo</cwd></environment_context>"),
    said("\n# Files mentioned by the user:\n\n## money.js: C:/repo/src/money.js\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\nFix the rounding bug in src/money.js. Do not modify the existing tests.\n", ["user.text"]),
    line("compacted", { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Summary of the work so far" }] }] }),
    said("now also round the totals"),
  ]);
  const f = codexSessionFacts(file, dir);
  assert.equal(f.goal, "Fix the rounding bug in src/money.js. Do not modify the existing tests.");
  assert.equal(f.request, "now also round the totals", "the compaction's replayed history is not a request");
  assert.deepEqual(f.rules, ["Do not modify the existing tests."]);
});

test("codex desktop: shell_command, a freeform patch, and a node --test failure that keeps the error", () => {
  const { dir, file } = rollout([
    said("fix it"),
    call("a", "shell_command", { command: "pytest tests/test_money.py", workdir: "." }),
    output("a", "Exit code: 127\nOutput:\npytest: command not found"),
    line("response_item", { type: "custom_tool_call", call_id: "p", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/money.js\n@@\n-a\n+b\n*** Delete File: src/old.js\n*** End Patch" }),
    call("b", "shell_command", { command: "node --test test/money.test.js" }),
    output("b", "Exit code: 1\nOutput:\nTypeError: round is not a function\nℹ tests 4\nℹ pass 3\nℹ fail 1"),
  ]);
  const f = codexSessionFacts(file, dir);
  assert.deepEqual(f.changed, ["src/money.js"], "a deleted file is not one to look at again");
  assert.deepEqual(f.missing, [{ name: "pytest", evidence: "pytest: command not found" }]);
  assert.deepEqual(f.test, { command: "node --test test/money.test.js", result: "ℹ pass 3 · ℹ fail 1" });
  assert.deepEqual(f.error, { line: "TypeError: round is not a function", command: "node --test test/money.test.js" });
  assert.match(memoryText(f, [], dir), /Tests run here with: `node --test test\/money\.test\.js`/);
});

test("codex desktop: code-mode cells are read for commands, patches and the plan", () => {
  const { dir, file } = rollout([
    said("add the export"),
    cell("p", 'const p = await tools.update_plan({plan:[\n  {step:"Add the export",status:"in_progress"},\n  {step:"Write docs",status:"pending"}\n]}); text(p)'),
    cell("e", 'const patch = "*** Begin Patch\\n*** Add File: src/export.ts\\n+export {}\\n*** Update File: README.md\\n@@\\n-a\\n+b\\n*** End Patch";\nconst r = await tools.apply_patch(patch); text(r)'),
    cell("t", "const r = await tools.exec_command({\n  cmd: 'npm.cmd test',\n  shell: \"powershell\",\n  yield_time_ms: 30000\n});\ntext(r.output);"),
    cellOutput("t", "Tests:       12 passed, 12 total"),
  ]);
  const f = codexSessionFacts(file, dir);
  assert.deepEqual(f.todos, ["Add the export", "Write docs"]);
  assert.deepEqual(f.changed, ["README.md", "src/export.ts"]);
  assert.deepEqual(f.test, { command: "npm.cmd test", result: "Tests: 12 passed, 12 total" });
});

test("codex: the agent's last message is the session's outcome", () => {
  const { dir, file } = rollout([
    said("Fix the rounding bug in src/money.js"),
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking at money.js first." }] }),
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed: round half to even in money.js, since the ledger sums cents." }] }),
  ]);
  assert.equal(codexSessionFacts(file, dir).outcome, "Fixed: round half to even in money.js, since the ledger sums cents.");
});
