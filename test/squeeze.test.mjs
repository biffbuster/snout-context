import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { squeeze, kindOf } from "../dist/lib.mjs";

const CLI = new URL("../dist/snout.mjs", import.meta.url).pathname;

const jestPass = () => [
  "> shop@1.0.0 test", "> jest", "",
  ...Array.from({ length: 8 }, (_, f) => [` PASS  src/module${f}.test.ts`, ...Array.from({ length: 25 }, (_, t) => `    \u001b[32m✓\u001b[39m handles case ${f}.${t} correctly (${t % 7} ms)`)]).flat(),
  "", "Test Suites: 8 passed, 8 total", "Tests:       200 passed, 200 total", "Snapshots:   0 total", "Time:        4.812 s", "Ran all test suites.",
].join("\n");

const npmInstall = () => [
  ...Array.from({ length: 40 }, (_, i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} ${i * 3}ms (cache miss)`),
  "npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.",
  "npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported",
  ...Array.from({ length: 30 }, (_, i) => `npm timing reifyNode:node_modules/dep-${i} Completed in ${i}ms`),
  "", "added 812 packages, and audited 813 packages in 14s", "", "142 packages are looking for funding", "  run `npm fund` for details", "", "found 0 vulnerabilities",
].join("\n");

const buildWarn = () => [
  "vite v6.0.1 building for production...", "transforming...",
  ...Array.from({ length: 60 }, () => "(!) Some chunks are larger than 500 kB after minification. Consider code splitting."),
  ...Array.from({ length: 80 }, (_, i) => `dist/assets/chunk-${i}.js   ${(i * 1.7).toFixed(2)} kB │ gzip: ${(i * 0.4).toFixed(2)} kB`),
  "✓ built in 7.21s",
].join("\n");

test("commands are recognised by family; everything else is left alone", () => {
  assert.equal(kindOf("npm test"), "test");
  assert.equal(kindOf("cd web && pnpm run test -- --ci"), "test");
  assert.equal(kindOf("python -m pytest -q tests/"), "test");
  assert.equal(kindOf("npm ci"), "install");
  assert.equal(kindOf("pnpm build"), "build");
  assert.equal(kindOf("npx tsc --noEmit"), "build");
  for (const c of ["git diff", "git log", "cat package.json", "ls -la", "npm run dev", "npm run lint"]) assert.equal(kindOf(c), null, c);
  assert.equal(kindOf("rg foo"), "search");
});

test("a green test run keeps the summary and drops the 200 passing lines", () => {
  const s = squeeze("test", jestPass(), ".snout/squeeze/x.log");
  assert.ok(s);
  assert.match(s.text, /Tests:\s+200 passed, 200 total/);
  assert.match(s.text, /Test Suites: 8 passed/);
  assert.doesNotMatch(s.text, /handles case 5\.5/);
  assert.doesNotMatch(s.text, /\u001b\[/, "colour codes are stripped");
  assert.match(s.text, /Full output: \.snout\/squeeze\/x\.log/);
  assert.ok(s.afterBytes < s.beforeBytes * 0.15, `cut to ${Math.round((s.afterBytes / s.beforeBytes) * 100)}%`);
});

test("an install keeps warnings and the result; a build collapses a repeated warning", () => {
  const i = squeeze("install", npmInstall(), "x.log");
  assert.match(i.text, /deprecated inflight/);
  assert.match(i.text, /deprecated glob/);
  assert.match(i.text, /added 812 packages/);
  assert.match(i.text, /found 0 vulnerabilities/);
  assert.doesNotMatch(i.text, /npm http fetch GET 200 https:\/\/registry\.npmjs\.org\/pkg-20/);

  const b = squeeze("build", buildWarn(), "x.log");
  assert.equal((b.text.match(/Some chunks are larger/g) || []).length, 1, "a warning repeated 60 times appears once");
  assert.match(b.text, /same line 59 more times/);
  assert.match(b.text, /built in 7\.21s/);
});

test("output past Claude Code's own limit is left to Claude Code", () => {
  const huge = jestPass() + "\n" + "x".repeat(40_000);
  assert.equal(squeeze("test", huge, "x.log"), null);
});

test("small or already-tight output is never touched", () => {
  assert.equal(squeeze("test", "Tests: 3 passed, 3 total\n", "x.log"), null);
  const tight = Array.from({ length: 200 }, (_, i) => `error TS2345: Argument of type 'X${i}' is not assignable (src/f${i}.ts:${i}:1)`).join("\n");
  assert.equal(squeeze("build", tight, "x.log"), null, "all lines are problems: nothing to cut");
});

function hook(root, payload, mode = "enforce") {
  mkdirSync(join(root, ".snout"), { recursive: true });
  writeFileSync(join(root, ".snout/config.json"), JSON.stringify({ mode }));
  const r = spawnSync(process.execPath, [CLI, "squeeze"], { input: JSON.stringify({ session_id: "s", cwd: root, hook_event_name: "PostToolUse", tool_name: "Bash", ...payload }), encoding: "utf8" });
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test("the hook replaces a green run's output with the Bash output shape, saves the full log, and records the saving", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-sq-"));
  const out = hook(root, { tool_input: { command: "npm test" }, tool_response: { stdout: jestPass(), stderr: "", interrupted: false, isImage: false, noOutputExpected: false } });
  const u = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.deepEqual(Object.keys(u).sort(), ["interrupted", "isImage", "noOutputExpected", "stderr", "stdout"]);
  assert.match(u.stdout, /Tests:\s+200 passed/);
  const logs = readdirSync(join(root, ".snout/squeeze"));
  assert.equal(logs.length, 1);
  assert.match(readFileSync(join(root, ".snout/squeeze", logs[0]), "utf8"), /handles case 5\.5/, "the full output is kept on disk");
  const row = JSON.parse(readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").pop());
  assert.equal(row.rule, "command-output");
  assert.ok(row.tokensAvoidedEst > 1000 && row.trimmed);
});

test("observe mode, other commands and interrupted runs pass through untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-sq-"));
  const resp = { stdout: jestPass(), stderr: "", interrupted: false, isImage: false };
  assert.equal(hook(root, { tool_input: { command: "npm test" }, tool_response: resp }, "observe"), null);
  assert.equal(hook(root, { tool_input: { command: "git log" }, tool_response: resp }), null);
  assert.equal(hook(root, { tool_input: { command: "npm test" }, tool_response: { ...resp, interrupted: true } }), null);
});
