// The on-demand gate's own reading of a test run (bench/test-verdict.mjs), and Snout's, on the same
// outputs: a passing run of each runner the frozen sets use passes, and a failure anywhere fails it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerdict } from "../bench/test-verdict.mjs";
import { distillCard, PASSED } from "../dist/lib.mjs";

const card = (command, result) => ({ v: 1, id: "c", session: "s1", agent: "codex", started: "", updated: "", changed: [], rules: [], commits: [], test: { command, result } });

const GO_PASS = "ok  \tferrylog/internal/tickets\t0.412s\nok  \tferrylog/internal/fares\t(cached)\n?   \tferrylog/cmd\t[no test files]\n";
const GO_FAIL = "--- FAIL: TestBook (0.00s)\n    book_test.go:12: seat taken twice\nFAIL\nFAIL\tferrylog/internal/tickets\t0.31s\nok  \tferrylog/internal/fares\t0.20s\nFAIL\n";
const GO_BUILD = "# ferrylog/internal/tickets\ninternal/tickets/book.go:7:2: undefined: seats\nFAIL\tferrylog/internal/tickets [build failed]\nok  \tferrylog/internal/fares\t0.10s\nFAIL\n";
const GO_PANIC = "panic: runtime error: index out of range [3] with length 3\n\ngoroutine 7 [running]:\nFAIL\tferrylog/internal/tickets\t0.05s\n";

test("go test: passing packages pass; a failed test, a build failure or a panic anywhere fails, even above an ok line", () => {
  assert.equal(runVerdict("go test -race ./...", GO_PASS), "pass");
  assert.equal(runVerdict("go test ./...", GO_FAIL), "fail");
  assert.equal(runVerdict("go test ./...", GO_BUILD), "fail");
  assert.equal(runVerdict("go test ./...", GO_PANIC), "fail");
  assert.equal(runVerdict("go test ./cmd", "?   \tferrylog/cmd\t[no test files]\n"), "unknown", "nothing ran: not a pass");
});

test("Snout agrees on the Go result lines it keeps: a passing package is a pass and becomes the test command; a failing one never does", () => {
  for (const ok of ["ok  \tferrylog/internal/fares\t0.103s", "ok  ferrylog/internal/fares 0.103s", "ok  \tferrylog/internal/fares\t(cached)"]) {
    assert.ok(PASSED(ok), ok);
    assert.equal(distillCard(card("go test -race ./...", ok))[0]?.text, "Run the tests with: go test -race ./...", ok);
  }
  for (const bad of ["FAIL\tferrylog/internal/tickets\t0.31s", "FAIL\tferrylog/internal/tickets [build failed]", "--- FAIL: TestBook (0.00s)"]) {
    assert.ok(!PASSED(bad), bad);
    assert.deepEqual(distillCard(card("go test ./...", bad)), [], bad);
  }
});

test("the other runners in the frozen sets: each passing output passes, each failing one fails", () => {
  const cases = [
    ["npm test", "ℹ tests 3\nℹ pass 3\nℹ fail 0\n", "ℹ tests 3\nℹ pass 2\nℹ fail 1\n"],
    ["node --test", "ℹ pass 31\nℹ fail 0\n", "ℹ pass 30\nℹ fail 1\n"],
    ["npx vitest run", " Test Files  5 passed (5)\n      Tests  46 passed (46)\n", " Test Files  1 failed | 4 passed (5)\n      Tests  1 failed | 45 passed (46)\n"],
    ["pnpm test", "Tests:       24 passed, 24 total\n", "Tests:       2 failed, 22 passed, 24 total\n"],
    ["python -m pytest -q", "............ [100%]\n12 passed in 0.41s\n", "....F....... [100%]\nFAILED tests/test_a.py::test_x\n1 failed, 11 passed in 0.41s\n"],
    ["tox -q", "  py312: OK (3.21 seconds)\n  congratulations :) (3.30 seconds)\n", "  py312: FAIL code 1 (3.21 seconds)\n  evaluation failed :( (3.30 seconds)\n"],
    ["cargo test", "test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.21s\n", "test result: FAILED. 17 passed; 1 failed; 0 ignored\n"],
    ["deno test -A", "ok | 12 passed | 0 failed (45ms)\n", "FAILED | 11 passed | 1 failed (45ms)\n"],
  ];
  for (const [command, pass, fail] of cases) {
    assert.equal(runVerdict(command, pass), "pass", `${command} passing`);
    assert.equal(runVerdict(command, fail), "fail", `${command} failing`);
  }
  assert.equal(runVerdict("make check", "all good\n"), "unknown", "a runner it doesn't know is not counted as a pass");
});
