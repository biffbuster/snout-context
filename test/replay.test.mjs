// snout replay: recorded tool calls through the real handlers, offline, without touching .snout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

test("replay finds what Snout would hold back and trim, carries it to later requests, and writes nothing to the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-replay-"));
  // Under Claude Code's 256 KB read limit, above which it refuses the read itself and Snout steps aside.
  const pkgs = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`node_modules/p${i}`, { version: "1.0.0" }]));
  const lock = JSON.stringify({ lockfileVersion: 3, packages: pkgs }, null, 2);
  writeFileSync(join(dir, "package-lock.json"), lock);
  writeFileSync(join(dir, "package.json"), "{}");
  const passing = Array.from({ length: 600 }, (_, i) => `test_case_${i} (tests.test_m.T) ... ok`).join("\n") + "\n----------------------------------------------------------------------\nRan 600 tests in 3.2s\n\nOK";
  const usage = (n) => ({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: n, output_tokens: 5 });
  const at = (o, i) => ({ ...o, cwd: dir, sessionId: "s1", timestamp: `2026-10-09T10:00:${String(i).padStart(2, "0")}Z` });
  const rows = [
    { type: "user", message: { content: "update the lockfile handling" } },
    { type: "assistant", requestId: "r1", message: { model: "claude-sonnet-5-5", usage: usage(20000), content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: join(dir, "package-lock.json") } }] } },
    { type: "user", toolUseResult: { type: "text", file: { filePath: join(dir, "package-lock.json"), content: lock, numLines: lock.split("\n").length, startLine: 1, totalLines: lock.split("\n").length } }, message: { content: [{ type: "tool_result", tool_use_id: "a", content: lock }] } },
    { type: "assistant", requestId: "r2", message: { model: "claude-sonnet-5-5", usage: usage(60000), content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "python -m unittest -v tests.test_m" } }] } },
    { type: "user", toolUseResult: { stdout: passing, stderr: "", interrupted: false, isImage: false }, message: { content: [{ type: "tool_result", tool_use_id: "b", content: passing }] } },
    { type: "assistant", requestId: "r3", message: { model: "claude-sonnet-5-5", usage: usage(30000), content: [{ type: "text", text: "done" }] } },
    { type: "assistant", requestId: "r4", message: { model: "claude-sonnet-5-5", usage: usage(30000), content: [{ type: "text", text: "done" }] } },
  ].map(at);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = spawnSync(process.execPath, [CLI, "replay", "--json", file], { cwd: dir, encoding: "utf8", env: { ...process.env, SNOUT_MODE: "" } });
  const { totals, sessions } = JSON.parse(out.stdout);
  const s = sessions[0];
  assert.equal(s.narrowed, 1, "the lockfile read is narrowed to its head");
  assert.equal(s.trimmed, 1, "the passing test output is trimmed");
  assert.ok(s.keptOut > 5000, `kept out ${s.keptOut}`);
  assert.ok(s.carried >= s.keptOut, "carried over the later requests");
  assert.equal(s.regrets, 0);
  assert.ok(totals.share > 0);
  assert.ok(!existsSync(join(dir, ".snout", "ledger.jsonl")), "the project's ledger is untouched");
});

test("pytest's verbose passing lines are trimmed like any other green run, failures kept", async () => {
  const { squeeze } = await import("../dist/lib.mjs");
  const lines = Array.from({ length: 400 }, (_, i) => `tests/test_m.py::test_case_${i} PASSED${" ".repeat(20)}[ ${Math.floor(i / 4)}%]`);
  lines.splice(200, 0, "tests/test_m.py::test_broken FAILED                    [ 50%]");
  const out = lines.join("\n") + "\n=========== 1 failed, 400 passed in 3.2s ===========";
  const s = squeeze("test", out, ".snout/squeeze/x.log");
  assert.ok(s, "squeezed");
  assert.match(s.text, /test_broken FAILED/);
  assert.match(s.text, /1 failed, 400 passed/);
  assert.ok(s.afterBytes < s.beforeBytes / 3, `${s.afterBytes} of ${s.beforeBytes}`);
});

test("compacting a long session earlier costs less; a session that never reaches the cap is unchanged", async () => {
  const { compactionWhatIf, COMPACTION_COSTS } = await import("../dist/lib.mjs");
  const dir = mkdtempSync(join(tmpdir(), "snout-whatif-"));
  // 200 requests growing by 2.5k tokens each from a 20k prefix: peaks at ~520k.
  const rows = Array.from({ length: 200 }, (_, i) => ({ type: "assistant", requestId: `r${i}`, message: { usage: { input_tokens: 10, cache_creation_input_tokens: i ? 2500 : 20000, cache_read_input_tokens: i ? 20000 + 2500 * (i - 1) : 0, output_tokens: 300 } } }));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const never = compactionWhatIf(file, Infinity, COMPACTION_COSTS.usual);
  assert.ok(Math.abs(never.change) < 1e-9, "no cap, no change");
  const at300 = compactionWhatIf(file, 300_000, COMPACTION_COSTS.usual);
  assert.ok(at300.compactions >= 1 && at300.change < -0.1, `${at300.change}`);
  assert.ok(at300.peak <= 300_000);
  const harsh = compactionWhatIf(file, 300_000, COMPACTION_COSTS.harsh);
  assert.ok(harsh.change > at300.change, "a lossier compaction saves less");
  assert.equal(compactionWhatIf(file, 600_000, COMPACTION_COSTS.usual).compactions, 0);
});
