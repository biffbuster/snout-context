import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture as shortFixture } from "../bench/ab.mjs";
import { makeFixture as longFixture } from "../bench/long.mjs";
import { shippedClaudeHooks } from "../bench/shipped-hooks.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const plugin = shippedClaudeHooks(repo, join(repo, "dist/snout.mjs"));
const settings = (dir) => JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")).hooks;

test("Claude benchmarks use the shipped plugin and the installed fast gate", () => {
  for (const [name, create] of [["short", (arm) => shortFixture(arm)], ["long", (arm) => longFixture(arm, "tax")]]) {
    const off = create("off"), on = create("enforce");
    try {
      const plain = settings(off), active = settings(on);
      assert.deepEqual(Object.keys(plain), ["PostToolUse"], `${name}: baseline has recording only`);
      for (const [event, entries] of Object.entries(plugin)) {
        assert.deepEqual(active[event]?.slice(0, entries.length), entries, `${name}: ${event} matches shipped plugin`);
      }
      assert.equal(active.PreToolUse.length, 1, `${name}: one fast gate entry`);
      assert.equal(active.PreToolUse[0].hooks[0].type, "http");
      assert.equal(active.PostToolUse.at(-1).hooks[0].type, "http", `${name}: fast output trimming`);
      assert.equal(active.SessionStart.at(-1).hooks[0].command.includes("serve --ensure"), true, `${name}: server starter`);
    } finally {
      for (const dir of [off, on]) {
        assert.equal(dirname(dir), tmpdir());
        assert.match(basename(dir), /^snout-(?:ab|long)-(?:off|enforce)-/);
        rmSync(dir, { recursive: true });
      }
    }
  }
});

test("a whole-run cap stops before any paid agent call and leaves resumable rows", () => {
  const cmd = [join(repo, "bench/ab.mjs"), "--tasks", "cart", "--n", "1", "--max-spend", "0.001"];
  const env = { ...process.env, CLAUDE_BIN: join(repo, "no-such-claude.exe") };
  const first = spawnSync(process.execPath, cmd, { cwd: repo, env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Stopped at .* run cap/);
  const file = first.stdout.match(/Full results: (.+)/)?.[1]?.trim();
  assert.ok(file);
  try {
    assert.equal(dirname(file), join(repo, "bench/ab-results"));
    assert.match(basename(file), /^run-\d+\.json$/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).rows, []);
    const resumed = spawnSync(process.execPath, [...cmd, "--resume", file], { cwd: repo, env, encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).rows, []);
  } finally {
    rmSync(file);
  }
});

test("Codex run cap stops before plan usage and rejects a dollar cap", () => {
  const cmd = [join(repo, "bench/ab.mjs"), "--agent", "codex", "--tasks", "cart", "--n", "1", "--max-runs", "0"];
  const env = { ...process.env, CODEX_CLI_JS: join(repo, "no-such-codex.js") };
  const first = spawnSync(process.execPath, cmd, { cwd: repo, env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Stopped after 0 run\(s\) by --max-runs/);
  const file = first.stdout.match(/Full results: (.+)/)?.[1]?.trim();
  assert.ok(file);
  try {
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).rows, []);
    const resumed = spawnSync(process.execPath, [...cmd, "--resume", file], { cwd: repo, env, encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).rows, []);
  } finally {
    rmSync(file);
  }
  const badCap = spawnSync(process.execPath, [...cmd, "--max-spend", "7"], { cwd: repo, env, encoding: "utf8" });
  assert.notEqual(badCap.status, 0);
  assert.match(badCap.stderr, /cannot cap ChatGPT-plan usage/);
});
