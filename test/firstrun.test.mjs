import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const row = (o) => JSON.stringify({ ts: new Date().toISOString(), session: "s", turn: 1, tool: "Read", path: "src/a.ts", tier: 0, rule: "unclassified", value: 2, confidence: 0, decision: "allow", mode: "observe", reason: "", bytes: 1, tokensAvoidedEst: 0, tokensReadEst: 500, jevInputTokens: 0, latencyMs: 1, model: null, reversedByUser: false, ...o });

function project(mode, rows) {
  const root = mkdtempSync(join(tmpdir(), "snout-first-"));
  mkdirSync(join(root, ".snout"));
  writeFileSync(join(root, ".snout/config.json"), JSON.stringify({ mode }));
  writeFileSync(join(root, ".snout/ledger.jsonl"), rows.join("\n") + "\n");
  return root;
}
const start = (root) => JSON.parse(spawnSync(process.execPath, [CLI, "session-start"], { input: JSON.stringify({ session_id: "n", cwd: root, hook_event_name: "SessionStart" }), encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "no-logs-")), CODEX_HOME: mkdtempSync(join(tmpdir(), "no-logs-")) } }).stdout).systemMessage;

const observed = [row({}), row({ path: "src/b.ts" }), row({ path: "package-lock.json", rule: "lockfile", value: 0, observedOnly: true, tokensReadEst: 40000, tokensAvoidedEst: 40000 })];

test("observe mode: once there is something to report, the next session says what enforce would save, once", () => {
  const root = project("observe", observed);
  const first = start(root);
  assert.match(first, /Snout watched 3 reads; 1 of them would have been trimmed: in enforce mode it would have kept ~40\.0k tokens out of context/);
  assert.match(first, /snout mode enforce/);
  assert.match(start(root), /^Snout is on \(observe\)/, "never repeated");
});

test("no report in enforce mode, with too few reads, or when nothing would be trimmed", () => {
  assert.match(start(project("enforce", observed)), /^Snout is on \(enforce\)/);
  assert.match(start(project("observe", observed.slice(2))), /^Snout is on/);
  assert.match(start(project("observe", [row({}), row({}), row({})])), /^Snout is on/);
});
