// Compaction handoff: the working state since the last compaction, printed for the summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingState, handoffText } from "../dist/lib.mjs";

const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const prompt = (text) => ({ type: "user", message: { content: text } });

test("lists the request, changed and read files, the last test result and open to-dos since the last compaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-handoff-"));
  const rows = [
    prompt("old request before compaction"),
    use("a", "Edit", { file_path: join(dir, "old.py") }),
    { type: "system", subtype: "compact_boundary" },
    prompt("Fix the rounding bug in tax.py"),
    use("b", "Read", { file_path: join(dir, "src/tax.py") }),
    use("c", "Read", { file_path: join(dir, "src/cart.py") }),
    use("d", "Write", { file_path: "/tmp/scratch/repro.py" }),
    use("e", "Edit", { file_path: join(dir, "src/tax.py") }),
    use("f", "Bash", { command: "pytest tests/test_tax.py -q" }),
    result("f", "..F\n1 failed, 2 passed in 0.1s\n"),
    use("g", "TodoWrite", { todos: [{ content: "fix rounding", status: "completed" }, { content: "add regression test", status: "pending" }] }),
    { type: "user", isMeta: true, message: { content: "<system-reminder>ignore</system-reminder>" } },
  ];
  const file = join(dir, "t.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s = workingState(file, dir);
  assert.equal(s.request, "Fix the rounding bug in tax.py");
  assert.deepEqual(s.changed, ["src/tax.py", "/tmp/scratch/repro.py"], "project files first; nothing from before the compaction");
  assert.deepEqual(s.read, ["src/cart.py"], "a file also changed is listed once, as changed");
  assert.deepEqual(s.test, { command: "pytest tests/test_tax.py -q", result: "1 failed, 2 passed in 0.1s" });
  assert.deepEqual(s.todos, ["add regression test"]);
  const text = handoffText(s);
  assert.match(text, /^Keep this working state in the summary/);
  assert.match(text, /Last test run: `pytest tests\/test_tax.py -q` → 1 failed, 2 passed/);
  assert.ok(text.length < 2000);
  assert.equal(handoffText({ changed: [], read: [], todos: [] }), "", "nothing to hand over prints nothing");
});
