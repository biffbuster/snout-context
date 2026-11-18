import test from "node:test";
import assert from "node:assert/strict";
import { diffFiles, minisweSessionFacts, minisweTask } from "../dist/lib.mjs";

// A mini-swe-agent trajectory in the shape VibeMemBench ships: the task in the first user message,
// commands in extra.actions, their output in the tool message with the same tool_call_id, the patch in exit.
const step = (id, command, reasoning = "") => ({ role: "assistant", content: "", reasoning_content: reasoning, extra: { actions: [{ command, tool_call_id: id }] } });
const out = (id, raw, returncode = 0) => ({ role: "tool", tool_call_id: id, content: `<returncode>${returncode}</returncode>\n<output>\n${raw}\n</output>`, extra: { raw_output: raw, returncode } });
const DIFF = "diff --git a/pkg/core.py b/pkg/core.py\n--- a/pkg/core.py\n+++ b/pkg/core.py\n@@ -10,6 +10,7 @@ class Search:\n+    x = 1\n";
const trajectory = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "<pr_description>\nConsider the following PR description:\nSearch by id lists every product\nMore detail here.\n</pr_description>\n\nWork in /testbed." },
  step("a", "cd /testbed && ls", "Let me look around the starting folder first."), out("a", "total 0"),
  step("b", "cd /pkg && grep -rn \"Traceback\" pkg/core.py", "The code is in /pkg; search it."), out("b", "pkg/core.py:3: # Traceback handling"),
  step("c", "cd /pkg && python3 -m pytest tests/test_core.py -q", "Run the tests."), out("c", "E   AssertionError: expected 1 product\n1 failed in 0.20s", 1),
  step("d", "cd /pkg && python3 -m pytest tests/test_core.py -q", "The search ignored the id because it was never popped from kwargs; fixed by popping it before the request."), out("d", "3 passed in 0.31s"),
  step("e", "cd /pkg && git diff > /testbed/patch.txt", "Now let me write the patch file."), out("e", ""),
  step("f", "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat /testbed/patch.txt", "Submitting."), out("f", DIFF),
  { role: "exit", content: DIFF, extra: { exit_status: "Submitted", submission: DIFF } },
];

test("a mini-swe-agent trajectory gives the same session facts Snout keeps for Claude Code and Codex", () => {
  const f = minisweSessionFacts(trajectory, "/testbed");
  assert.equal(minisweTask(trajectory[1].content), "Search by id lists every product\nMore detail here.");
  assert.match(f.goal, /^Search by id lists every product/);
  assert.deepEqual(f.test, { command: "cd /pkg && python3 -m pytest tests/test_core.py -q", result: "3 passed in 0.31s" });
  assert.deepEqual(f.changed, ["pkg/core.py"], "the files its submitted patch changed");
  assert.equal(f.recovered?.command, "cd /pkg && python3 -m pytest tests/test_core.py -q", "the failing test run before the passing one, not the grep that printed a matching line");
  assert.match(f.outcome ?? "", /never popped from kwargs/, "its last words about the fix, not the steps that wrote or submitted the patch");
  assert.deepEqual(diffFiles(DIFF), ["pkg/core.py"]);
});
