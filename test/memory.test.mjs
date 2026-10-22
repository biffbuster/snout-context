// Session facts by fixed rules (test command, missing tools, instructions, errors). Memory cards are
// built from them. After a compaction Claude Code's own summary carries on; Snout adds nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFacts, codexSessionFacts, testCommand } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const prompt = (text) => ({ type: "user", message: { content: text } });

function session(dir) {
  const rows = [
    prompt("Issue 1: fix the HNF rank bug"),
    use("a", "Bash", { command: "pytest sympy/matrices" }),
    result("a", "/opt/conda/bin/python: No module named pytest"),
    use("b", "Bash", { command: "python bin/test sympy/matrices/tests/test_normalforms.py" }),
    result("b", "== tests finished: 12 passed, 1 skipped, in 0.4 seconds =="),
    use("c", "Bash", { command: "python bin/test sympy/polys" }),
    result("c", "Command did not complete within its 120s timeout and was moved to the background (ID: x1)."),
    use("d", "Edit", { file_path: join(dir, "sympy/matrices/normalforms.py") }),
    { type: "system", subtype: "compact_boundary" },
    { type: "user", isCompactSummary: true, message: { content: "This session is being continued..." } },
  ];
  const file = join(dir, "t.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

test("facts from before the compaction survive verbatim: the test command, what's missing, slow commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-mem-"));
  const f = sessionFacts(session(dir), dir);
  assert.deepEqual(f.test, { command: "python bin/test sympy/matrices/tests/test_normalforms.py", result: "== tests finished: 12 passed, 1 skipped, in 0.4 seconds ==" });
  assert.deepEqual(f.missing, [{ name: "pytest", evidence: "No module named pytest" }]);
  assert.deepEqual(f.slow, ["python bin/test sympy/polys"]);
  assert.deepEqual(f.changed, ["sympy/matrices/normalforms.py"]);
  assert.equal(f.request, "Issue 1: fix the HNF rank bug", "the compaction summary is not a request");
});

test("SessionStart after a compaction adds nothing: Claude Code's summary carries on", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-mem-cli-"));
  const transcript = session(dir);
  mkdirSync(join(dir, ".snout"), { recursive: true });
  writeFileSync(join(dir, ".snout", "config.json"), JSON.stringify({ mode: "enforce" }));
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s1", transcript_path: transcript, cwd: dir });
  const r = spawnSync(process.execPath, [CLI, "session-start"], { cwd: dir, input, encoding: "utf8", env: { ...process.env, SNOUT_MODE: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /additionalContext/);
});

test("only a real test-runner run counts as how tests run, not a script that mentions one", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-testcmd-"));
  // From the memory benchmark (2026-10-09): these were restored as "Tests run here with".
  assert.equal(testCommand(`python -W ignore -c "\nimport sympy\nfrom sympy import pycode\nprint(pycode(x))"`, dir), undefined);
  assert.equal(testCommand(`python -c "import sys, pytest; sys.exit(pytest.main(['-q']))"`, dir), undefined);
  assert.equal(testCommand(`cat > tests/fr/test_tmp.py <<'EOF'\nfrom django.test import TestCase\nimport unittest\nEOF`, dir), undefined);
  assert.equal(testCommand("grep -rn pytest setup.cfg", dir), undefined);
  assert.equal(testCommand("pip install pytest", dir), undefined);
  // The runner part is kept; scripts before it, cd into the project and output filters are not.
  assert.equal(testCommand(`python -W ignore -c "print(1)"; python -W ignore bin/test sympy/polys 2>&1 | tail -n 4`, dir), "python -W ignore bin/test sympy/polys");
  assert.equal(testCommand(`cd ${dir} && python -m pytest -q tests/test_ext_viewcode.py 2>&1 | tail -3`, dir), "python -m pytest -q tests/test_ext_viewcode.py");
  assert.equal(testCommand(`cd ${join(dir, "web")} && npm test`, dir), "cd web && npm test");
  assert.equal(testCommand(`python -m pytest ${dir}/tests/test_a.py -q`, dir), "python -m pytest tests/test_a.py -q");
  assert.equal(testCommand("DJANGO_SETTINGS_MODULE=x timeout 300 python tests/runtests.py dbshell --parallel 1", dir), "DJANGO_SETTINGS_MODULE=x timeout 300 python tests/runtests.py dbshell --parallel 1");
});

test("a wrong import path inside the project is not reported as a missing tool", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-modpath-"));
  mkdirSync(join(dir, "sympy"));
  const rows = [
    use("a", "Bash", { command: "python -c 'from sympy.core.evaluate import x'" }),
    result("a", "ModuleNotFoundError: No module named 'sympy.core.evaluate'"),
    use("b", "Bash", { command: "cd /tmp && python -c 'import sympy'" }),
    result("b", "ModuleNotFoundError: No module named 'sympy'"),
    use("c", "Bash", { command: "python -c 'import numpy'" }),
    result("c", "ModuleNotFoundError: No module named 'numpy'"),
    use("d", "Bash", { command: "python -W ignore -c 'import sympy.core.evaluate'; python bin/test sympy/core" }),
    result("d", "No module named 'sympy.core.evaluate'\ntests finished: 40 passed, in 2.0 seconds"),
  ];
  const file = join(dir, "t.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const f = sessionFacts(file, dir);
  assert.deepEqual(f.missing.map((m) => m.name), ["numpy"]);
  assert.equal(f.test?.command, "python bin/test sympy/core", "a wrong import path in the same command doesn't hide the test run");
});

test("a python script that mentions a runner is not squeezed as a test run", async () => {
  const { kindOf } = await import("../dist/lib.mjs");
  assert.equal(kindOf(`python -c "import pytest; pytest.main(['-q'])"`), null);
  assert.equal(kindOf(`python -c 'import os; os.system("make all")'`), null);
  assert.equal(kindOf("python -m pytest -q tests/test_a.py"), "test");
  assert.equal(kindOf(`grep -rn "def test" src`), "search");
  assert.equal(kindOf(`cd "my dir" && npm test`), "test");
});

test("the request is what the user asked, and only test runs count as slow", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-req-"));
  const rows = [
    prompt("Fix the factor bug in polys"),
    prompt("<pasted_content id=\"1\">Traceback ... 400 lines of log</pasted_content> why does this fail? [Image #3]"),
    prompt("YH**HJ)<<<U)<K','''''''''''''',,,,,,,,,[[[[[[[[0[[[{0[[[[00[O9"),
    use("a", "Bash", { command: "until grep -q done run.log; do sleep 60; done; tail -5 run.log" }),
    result("a", "Command did not complete within its 120s timeout and was moved to the background (ID: x1)."),
    use("b", "Bash", { command: "python -W ignore bin/test sympy/polys 2>&1 | tail -4" }),
    result("b", "Command did not complete within its 120s timeout and was moved to the background (ID: x2)."),
  ];
  const file = join(dir, "t.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const f = sessionFacts(file, dir);
  assert.equal(f.request, "why does this fail?", "pasted text and images dropped; stray keystrokes skipped");
  assert.deepEqual(f.slow, ["python -W ignore bin/test sympy/polys"]);
});

test("a held-down key or a pasted block that never closes is not the request", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-req2-"));
  const rows = [
    prompt("Make the dashboard interactive"),
    prompt("phbgg2222222kkkkkkkkkkkkkkkknXXXZZZZZY67B00H]888888888JJJJJJJJJJJJ"),
    prompt('<pasted_content id="9"> Labeled 20 files with a model, never closed'),
  ];
  const file = join(dir, "t.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(sessionFacts(file, dir).request, "Make the dashboard interactive");
});

test("the user's instructions come back verbatim, not the pasted issue or questions", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-mem-"));
  const file = join(dir, "t.jsonl");
  const rows = [
    prompt("You'll work through 3 issues. Do not modify the existing tests.\n\n<issue>\nNever call flush() here. Use dedent instead.\n</issue>"),
    prompt("Make sure the commit message is short. Should we push now?"),
    prompt("ok, also keep the README untouched."),
    prompt("Do not modify the existing tests."),
    { type: "attachment", attachment: { type: "queued_command", prompt: "Never push to main." } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const facts = sessionFacts(file, dir);
  assert.deepEqual(facts.rules, ["Make sure the commit message is short.", "ok, also keep the README untouched.", "Do not modify the existing tests.", "Never push to main."]);
  assert.equal(facts.request, "Never push to main.");
});

test("the first request and the last unresolved error come back; a passing run or a clean rerun clears the error", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-err-"));
  const write = (rows) => { const file = join(dir, "t.jsonl"); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return file; };
  const rows = [
    prompt("Fix the timezone bug in the scheduler, then make the docs build again."),
    use("a", "Bash", { command: "python repro.py" }),
    result("a", "Traceback (most recent call last):\n  File \"repro.py\", line 3, in <module>\n    run()\nValueError: naive datetime is not allowed"),
    use("b", "Bash", { command: "cat CHANGES.txt" }),
    result("b", "KeyError: fixed in 2.1"),
    prompt("Also keep the public API unchanged."),
  ];
  let f = sessionFacts(write(rows), dir);
  assert.deepEqual(f.error, { line: "ValueError: naive datetime is not allowed", command: "python repro.py" }, "a printed file is not an error");
  assert.equal(f.goal, "Fix the timezone bug in the scheduler, then make the docs build again.");
  assert.equal(f.request, "Also keep the public API unchanged.");

  rows.push(use("c", "Bash", { command: "python -m pytest tests/test_sched.py" }), result("c", "FAILED tests/test_sched.py::test_tz - AssertionError\n==== 1 failed, 4 passed in 0.3s ===="));
  f = sessionFacts(write(rows), dir);
  assert.equal(f.error?.line, "FAILED tests/test_sched.py::test_tz - AssertionError", "a failing test run is the error now");

  rows.push(use("d", "Bash", { command: "python -m pytest tests/test_sched.py" }), result("d", "==== 5 passed in 0.3s ===="));
  assert.equal(sessionFacts(write(rows), dir).error, undefined, "a passing test run clears it");

  rows.push(use("e", "Bash", { command: "python repro.py" }), result("e", "Traceback (most recent call last):\nValueError: naive datetime is not allowed"), use("f", "Bash", { command: "python repro.py" }), result("f", "ok"));
  assert.equal(sessionFacts(write(rows), dir).error, undefined, "the same command running clean clears it");
});

test("in a transcript too long to read whole, the first request still comes from its start", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-long-"));
  const filler = JSON.stringify(result("x", "y".repeat(64 * 1024)));
  const lines = [JSON.stringify(prompt("Port the billing module to the new payments API.")), ...Array(260).fill(filler), JSON.stringify(prompt("Now update the changelog."))];
  const file = join(dir, "t.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  const f = sessionFacts(file, dir);
  assert.equal(f.goal, "Port the billing module to the new payments API.");
  assert.equal(f.request, "Now update the changelog.");
});

test("Codex rollout gives the same test and missing-tool facts; SessionStart after a compaction adds nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-codex-mem-"));
  mkdirSync(join(dir, ".snout"));
  const file = join(dir, "rollout.jsonl");
  const call = (id, cmd) => ({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd }) } });
  const output = (id, text) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: text } });
  writeFileSync(file, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the HNF rank bug" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for fixture\n<INSTRUCTIONS>Do not commit</INSTRUCTIONS>" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions"] } } },
    call("a", "pytest sympy/matrices"), output("a", "No module named pytest"),
    call("b", "python bin/test sympy/matrices/tests/test_normalforms.py"), output("b", "== tests finished: 12 passed, 1 skipped =="),
    { type: "compacted", payload: {} },
  ].map(JSON.stringify).join("\n") + "\n");
  writeFileSync(join(dir, ".snout", "config.json"), JSON.stringify({ mode: "enforce" }));
  const facts = codexSessionFacts(file, dir);
  assert.equal(facts.request, "Fix the HNF rank bug");
  assert.equal(facts.test.command, "python bin/test sympy/matrices/tests/test_normalforms.py");
  assert.deepEqual(facts.missing, [{ name: "pytest", evidence: "No module named pytest" }]);
  const r = spawnSync(process.execPath, [CLI, "hook", "codex", "SessionStart"], { cwd: dir, input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s1", transcript_path: file, cwd: dir }), encoding: "utf8", env: { ...process.env, SNOUT_MODE: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /additionalContext/);
});

test("current Codex CommandExecution rollout records give exact command results", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-codex-current-"));
  const file = join(dir, "rollout.jsonl");
  const command = (cmd, output) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["pwsh.exe", "-Command", cmd], status: "completed", aggregated_output: output } } });
  writeFileSync(file, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the HNF rank bug" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for fixture\n<INSTRUCTIONS>Do not commit</INSTRUCTIONS>" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions"] } } },
    command("python -m pytest sympy/matrices", "No module named pytest"),
    command("npm test", "Tests: 12 passed, 1 skipped"),
    command("node --test --test-isolation=none test/bash.test.mjs", "ℹ tests 13\nℹ pass 13\nℹ fail 0"),
    { type: "compacted", payload: {} },
  ].map(JSON.stringify).join("\n") + "\n");
  const facts = codexSessionFacts(file, dir);
  assert.deepEqual(facts.test, { command: "node --test --test-isolation=none test/bash.test.mjs", result: "ℹ pass 13" });
  assert.deepEqual(facts.missing, [{ name: "pytest", evidence: "No module named pytest" }]);
});

test("a background-task notice is not the user's request or instruction", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-notice-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, [
    prompt("Fix the flaky upload test"),
    prompt("<task-notification>\n<summary>stopped</summary>\n<note>Do not start it again on your own, even if the work seems to need it.</note>\n</task-notification>"),
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const f = sessionFacts(file, dir);
  assert.equal(f.request, "Fix the flaky upload test");
  assert.deepEqual(f.rules, []);
});
