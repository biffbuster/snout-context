// Project memory restored after compaction: exact facts from the session and .snout/pins.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFacts, codexSessionFacts, readPins, memoryText, testCommand, readProgress } from "../dist/lib.mjs";

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
  const text = memoryText(f, [], dir);
  assert.match(text, /Tests run here with: `python bin\/test sympy\/matrices\/tests\/test_normalforms\.py`/);
  assert.match(text, /Not available here: pytest \(No module named pytest\)/);
  assert.match(text, /Ran past the 2-minute tool limit here .*`python bin\/test sympy\/polys`/);
});

test("pins come verbatim, and a re-read pin brings its file from disk, not an older copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-pins-"));
  mkdirSync(join(dir, ".snout"));
  writeFileSync(join(dir, "settings.py"), "DEBUG = False\nDB = 'postgres'\nSECRET_PATH = '/etc/x'\n");
  writeFileSync(join(dir, ".snout", "pins.md"), "# pins\n- `settings.py` — deploy config [re-read 2]\n- Never run migrations against prod\n- `gone.py` — removed [re-read 5]\n");
  const pins = readPins(dir, join(dir, ".snout"));
  assert.equal(pins.length, 3);
  const text = memoryText({ missing: [], slow: [], changed: [], todos: [] }, pins, dir);
  assert.match(text, /- `settings\.py` — deploy config\n {2}```\n {2}DEBUG = False\n {2}DB = 'postgres'\n {2}```/);
  assert.doesNotMatch(text, /SECRET_PATH/, "only the first N lines");
  assert.match(text, /- Never run migrations against prod/);
  assert.match(text, /not on disk now: gone\.py/);
});

test("a re-read pin never brings a credential file's contents into context", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-pin-secret-"));
  mkdirSync(join(dir, ".snout"));
  writeFileSync(join(dir, ".env"), "API_KEY=sk-live-123\n");
  writeFileSync(join(dir, ".env.example"), "API_KEY=\n");
  writeFileSync(join(dir, ".snout", "pins.md"), "- `.env` — keys [re-read 5]\n- `.env.example` — template [re-read 5]\n");
  const text = memoryText({ missing: [], slow: [], changed: [], todos: [] }, readPins(dir, join(dir, ".snout")), dir, { redact: ["**/.env", "**/.env.*"], redactExempt: ["**/.env.example"] });
  assert.doesNotMatch(text, /sk-live-123/);
  assert.match(text, /contents not restored: the file matches a credential pattern/);
  assert.match(text, /API_KEY=\n/, "an exempt template is still restored");
});

test("the restored block stays under its cap however long the session is", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-cap-"));
  const f = { request: "x".repeat(400), missing: [], slow: [], changed: Array.from({ length: 500 }, (_, i) => `src/file${i}.py`), todos: Array.from({ length: 50 }, (_, i) => `todo ${i}`) };
  assert.ok(memoryText(f, [], dir).length <= 6000);
});

test("instructions are never what the cap cuts, and the changed-file list takes the room that is left", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-cap-"));
  const rules = ["Never push to main without asking first.", "Always run the tests before you say a task is done.", "Actually, do push once the tests pass."];
  const f = { request: "x".repeat(400), rules, missing: [], slow: [], changed: Array.from({ length: 500 }, (_, i) => `src/module${i}/file${i}.py`), todos: [] };
  const text = memoryText(f, [], dir, undefined, "p".repeat(1500));
  assert.ok(text.length <= 6000);
  for (const r of rules) assert.ok(text.includes(r), `kept: ${r}`);
  assert.match(text, /where two conflict, the later one holds/);
  const listed = text.match(/Files changed this session: (.*) \(and (\d+) more\)/);
  assert.ok(listed, "says how many files did not fit");
  assert.ok(listed[1].split(", ").length > 12, "more than the old fixed 12 when there is room");
  assert.equal(listed[1].split(", ")[0], "src/module0/file0.py", "most recent first");
  assert.equal(listed[1].split(", ").length + Number(listed[2]), 500);
});

test("SessionStart after a compaction adds the facts to context when Snout is on, and nothing in observe", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-mem-cli-"));
  const transcript = session(dir);
  const run = (mode) => {
    mkdirSync(join(dir, ".snout"), { recursive: true });
    writeFileSync(join(dir, ".snout", "config.json"), JSON.stringify({ mode }));
    const input = JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s1", transcript_path: transcript, cwd: dir });
    return spawnSync(process.execPath, [CLI, "session-start"], { cwd: dir, input, encoding: "utf8", env: { ...process.env, SNOUT_MODE: "" } }).stdout;
  };
  const on = JSON.parse(run("enforce"));
  assert.equal(on.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(on.hookSpecificOutput.additionalContext, /Tests run here with: `python bin\/test/);
  const off = run("observe");
  assert.doesNotMatch(off, /additionalContext/);
});

test("with SNOUT_DIR the restore asks for progress notes where Snout keeps its records", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-mem-dir-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "snout-mem-out-"));
  const transcript = session(dir);
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s1", transcript_path: transcript, cwd: dir });
  const out = JSON.parse(spawnSync(process.execPath, [CLI, "session-start"], { cwd: dir, input, encoding: "utf8", env: { ...process.env, SNOUT_MODE: "enforce", SNOUT_DIR: elsewhere } }).stdout);
  assert.ok(out.hookSpecificOutput.additionalContext.includes(`Keep \`${join(elsewhere, "progress.md").replace(/\\/g, "/")}\` current`));
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

test("the agent's progress notes come back first after a compaction; notes from before this session don't", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-progress-"));
  const snout = join(dir, ".snout");
  mkdirSync(snout);
  writeFileSync(join(snout, "progress.md"), "Goal: keep y - 1 in factor(extension=I)\nApproach: split off the content with dmp_primitive\nFailed: dmp_raise made y the main variable\nNext: run test_factortools only");
  const since = Date.now() - 60_000;
  const progress = readProgress(snout, since);
  const text = memoryText({ missing: [], slow: [], changed: ["a.py"], todos: [] }, [], dir, undefined, progress);
  assert.ok(text.indexOf("Approach: split off the content") < text.indexOf("Files changed"), "progress before the facts");
  assert.match(text, /Keep `\.snout\/progress\.md` current/);
  const old = (Date.now() - 3_600_000) / 1000;
  utimesSync(join(snout, "progress.md"), old, old);
  assert.equal(readProgress(snout, since), undefined, "a file last written before the session began is someone else's work");
  // The ask survives the cap.
  const long = memoryText({ request: "x".repeat(400), missing: [], slow: [], changed: Array.from({ length: 500 }, (_, i) => `src/f${i}.py`), todos: [] }, [], dir, undefined, "p".repeat(5000));
  assert.ok(long.length <= 6000);
  assert.match(long, /Keep `\.snout\/progress\.md` current.*next compaction\.$/);
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
  assert.match(memoryText(facts, [], dir), /Your instructions this session, verbatim[^\n]*\n- Make sure the commit message is short\./);
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
  const text = memoryText(f, [], dir);
  assert.match(text, /Last error, not yet followed by a passing run: ValueError: naive datetime is not allowed \(from `python repro\.py`\)/);
  assert.match(text, /First request this session: Fix the timezone bug/);
  assert.match(text, /Current request: Also keep the public API unchanged\./);

  rows.push(use("c", "Bash", { command: "python -m pytest tests/test_sched.py" }), result("c", "FAILED tests/test_sched.py::test_tz - AssertionError\n==== 1 failed, 4 passed in 0.3s ===="));
  f = sessionFacts(write(rows), dir);
  assert.equal(f.error?.line, "FAILED tests/test_sched.py::test_tz - AssertionError", "a failing test run is the error now");

  rows.push(use("d", "Bash", { command: "python -m pytest tests/test_sched.py" }), result("d", "==== 5 passed in 0.3s ===="));
  assert.equal(sessionFacts(write(rows), dir).error, undefined, "a passing test run clears it");

  rows.push(use("e", "Bash", { command: "python repro.py" }), result("e", "Traceback (most recent call last):\nValueError: naive datetime is not allowed"), use("f", "Bash", { command: "python repro.py" }), result("f", "ok"));
  assert.equal(sessionFacts(write(rows), dir).error, undefined, "the same command running clean clears it");
  assert.doesNotMatch(memoryText(sessionFacts(write([prompt("Make the docs build again.")]), dir), [], dir), /First request/, "one request is not repeated");
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

test("Codex rollout restores the same test and missing-tool facts at SessionStart", () => {
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
  writeFileSync(join(dir, ".snout", "pins.md"), "- `.env` — credentials [re-read 5]\n");
  writeFileSync(join(dir, ".env"), "API_KEY=secret-do-not-restore\n");
  const facts = codexSessionFacts(file, dir);
  assert.equal(facts.request, "Fix the HNF rank bug");
  assert.equal(facts.test.command, "python bin/test sympy/matrices/tests/test_normalforms.py");
  assert.deepEqual(facts.missing, [{ name: "pytest", evidence: "No module named pytest" }]);
  const run = (mode) => {
    writeFileSync(join(dir, ".snout", "config.json"), JSON.stringify({ mode }));
    return spawnSync(process.execPath, [CLI, "hook", "codex", "SessionStart"], { cwd: dir, input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s1", transcript_path: file, cwd: dir }), encoding: "utf8", env: { ...process.env, SNOUT_MODE: "" } });
  };
  const on = run("enforce");
  assert.equal(on.status, 0, on.stderr);
  const context = JSON.parse(on.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Tests run here with: `python bin\/test/);
  assert.match(context, /Not available here: pytest/);
  assert.doesNotMatch(context, /secret-do-not-restore/);
  assert.match(context, /contents not restored: the file matches a credential pattern/);
  const off = run("observe");
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /additionalContext/);
});

test("current Codex CommandExecution rollout records restore exact command results", () => {
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
