// The fast path: `snout serve` answers hook events over HTTP exactly as a hook process would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateEntries, installGate, refreshGate, squeezeEntries, starterEntries } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const PORT = String(47000 + Math.floor(Math.random() * 900));
const env = { ...process.env, SNOUT_PORT: PORT, SNOUT_CONFIG_DIR: mkdtempSync(join(tmpdir(), "snout-serve-cfg-")) };
const base = `http://127.0.0.1:${PORT}/snout/v1`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "snout-serve-"));
  mkdirSync(join(dir, ".snout"));
  writeFileSync(join(dir, ".snout/config.json"), JSON.stringify({ mode: "enforce" }));
  const pkgs = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`node_modules/p${i}`, { version: "1.0.0" }]));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: pkgs }));
  return dir;
}
/** `serve --ensure` waits a few seconds; a slow CI runner (Windows) can need longer to answer. */
async function ensureUp() {
  spawnSync(process.execPath, [CLI, "serve", "--ensure"], { env, timeout: 10000 });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("snout serve did not come up within 15 s");
}
const read = (dir, id) => ({ session_id: "s", cwd: dir, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: id, tool_input: { file_path: join(dir, "package-lock.json") } });

test("serve answers a gate call like the hook process, refuses foreign hosts and non-JSON, and shuts down on request", async () => {
  await ensureUp();
  const dir = project();
  try {
    const viaCli = JSON.parse(spawnSync(process.execPath, [CLI, "pre-tool"], { input: JSON.stringify(read(dir, "c1")), encoding: "utf8", env }).stdout);
    const res = await fetch(`${base}/pre-tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(read(dir, "h1")) });
    const viaHttp = await res.json();
    assert.equal(viaHttp.hookSpecificOutput.permissionDecision, viaCli.hookSpecificOutput.permissionDecision);
    assert.equal(viaHttp.hookSpecificOutput.permissionDecision, "deny");
    const rows = readFileSync(join(dir, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.decision === "deny" && r.latencyMs < 5000), "the server records a per-request latency, not its uptime");

    const plain = await fetch(`${base}/pre-tool`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(read(dir, "h2")) });
    assert.equal(plain.status, 404, "a body a web page could send without a preflight is refused");
    const health = await (await fetch(`${base}/health`)).json();
    assert.ok(health.version);
  } finally {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  }
});

test("a foreign Host header is refused (DNS rebinding)", async () => {
  await ensureUp();
  try {
    const { request } = await import("node:http");
    const status = await new Promise((done) => {
      const req = request({ host: "127.0.0.1", port: Number(PORT), path: "/snout/v1/health", headers: { host: `evil.example:${PORT}` } }, (r) => done(r.statusCode));
      req.on("error", () => done(0));
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  }
});

test("fast gate entries are HTTP hooks with the same filters as the command hooks", () => {
  const slow = gateEntries("/x/snout.mjs");
  const fast = gateEntries("/x/snout.mjs", true);
  assert.equal(fast.length, slow.length);
  for (let i = 0; i < fast.length; i++) {
    assert.equal(fast[i].matcher, slow[i].matcher);
    assert.deepEqual(fast[i].hooks.map((h) => h.if), slow[i].hooks.map((h) => h.if));
    assert.ok(fast[i].hooks.every((h) => h.type === "http" && /\/snout\/v1\/pre-tool$/.test(h.url)));
  }
  assert.ok(squeezeEntries("/x/snout.mjs", true).every((e) => e.hooks.every((h) => h.type === "http" && h.url.endsWith("/squeeze"))));
});

test("snout fast on installs HTTP gate hooks; off puts command hooks back", () => {
  const dir = project();
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir } });
  run("mode", "enforce");
  assert.match(run("fast", "on").stdout, /Fast hooks on/);
  let pre = JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")).hooks.PreToolUse;
  assert.ok(pre.every((e) => e.hooks.every((h) => h.type === "http")), "only HTTP gate hooks remain");
  run("fast", "off");
  pre = JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")).hooks.PreToolUse;
  assert.ok(pre.every((e) => e.hooks.every((h) => h.type === "command")), "back to command hooks, none left over");
});

test("a prompt brings back a fast-gate server that has gone, so gated calls don't fail until the next session", async () => {
  const dir = project();
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir } });
  run("mode", "enforce");
  run("fast", "on");
  await ensureUp();
  try {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
    let down = false;
    for (let i = 0; i < 50 && !down; i++) {
      try { await fetch(`${base}/health`); await new Promise((r) => setTimeout(r, 100)); } catch { down = true; }
    }
    assert.ok(down, "the server stopped");
    spawnSync(process.execPath, [CLI, "prompt-submit"], { cwd: dir, input: JSON.stringify({ session_id: "s", cwd: dir, hook_event_name: "UserPromptSubmit", prompt: "fix the build" }), encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir } });
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(up, "the prompt hook started the server again");
  } finally {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  }
});

async function waitHealth(want, tries = 150) {
  for (let i = 0; i < tries; i++) {
    const ok = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    if (ok === want) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("any tool call brings back a server that has gone mid-turn, without waiting for a prompt", async () => {
  const dir = project();
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir } });
  run("mode", "enforce");
  run("fast", "on");
  await ensureUp();
  try {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
    assert.ok(await waitHealth(false), "the server stopped");
    spawnSync(process.execPath, [CLI, "post-tool"], { cwd: dir, input: JSON.stringify({ session_id: "s", cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" }, tool_response: { stdout: "" } }), encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: dir } });
    assert.ok(await waitHealth(true), "the post-tool hook started the server again");
  } finally {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  }
});

test("the server outlives its idle time while a project's fast gate points at it, and exits once none does", async () => {
  const dir = project();
  const idleEnv = { ...env, CLAUDE_PROJECT_DIR: dir, SNOUT_SERVE_IDLE_MS: "300" };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8", env: idleEnv });
  run("mode", "enforce");
  run("fast", "on");
  await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  await waitHealth(false);
  run("serve", "--ensure");
  try {
    assert.ok(await waitHealth(true), "started");
    await new Promise((r) => setTimeout(r, 1500)); // five idle periods with no calls
    assert.ok(await fetch(`${base}/health`).then((r) => r.ok, () => false), "still up: the gate needs it");
    run("fast", "off");
    await new Promise((r) => setTimeout(r, 1000)); // quiet: a health check counts as a call
    assert.ok(!(await fetch(`${base}/health`).then((r) => r.ok, () => false)), "exits once no served project has the fast gate");
  } finally {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  }
});

test("the fast gate carries its own starter, so the server comes up even when the plugin's hooks never run", async () => {
  const dir = project();
  const settings = () => JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8")).hooks;
  installGate(dir, CLI, true);
  for (const ev of ["SessionStart", "UserPromptSubmit"]) assert.deepEqual(settings()[ev], starterEntries(CLI), `${ev} starts the server`);
  installGate(dir, CLI, true);
  assert.equal(settings().SessionStart.length, 1, "reinstalling does not stack starters");
  installGate(dir, CLI, false);
  assert.equal(settings().SessionStart, undefined, "a command gate needs no server");

  // A fast gate written before starters existed gets them at the next session start.
  installGate(dir, CLI, true);
  const s = JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8"));
  delete s.hooks.SessionStart;
  delete s.hooks.UserPromptSubmit;
  writeFileSync(join(dir, ".claude/settings.local.json"), JSON.stringify(s));
  assert.equal(refreshGate(dir, CLI), true);
  assert.deepEqual(settings().SessionStart, starterEntries(CLI));
  assert.ok(settings().PreToolUse.every((e) => e.hooks.every((h) => h.type === "http")), "and stays an HTTP gate");
  assert.equal(refreshGate(dir, CLI), false, "nothing to do the second time");

  // The starter's command, run as Claude Code would run it, brings the server up.
  await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  assert.ok(await waitHealth(false), "down");
  const [, cmd] = starterEntries(CLI)[0].hooks[0].command.match(/^node "(.+)" serve --ensure$/);
  spawnSync(process.execPath, [cmd, "serve", "--ensure"], { cwd: dir, input: "{}", env: { ...env, CLAUDE_PROJECT_DIR: dir } });
  try {
    assert.ok(await waitHealth(true), "the starter brought it up");
  } finally {
    await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
  }
});
