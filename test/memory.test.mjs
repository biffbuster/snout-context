// Project memory restored after compaction: exact facts from the session and .snout/pins.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFacts, readPins, memoryText } from "../dist/lib.mjs";

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
  assert.ok(memoryText(f, [], dir).length <= 4000);
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
