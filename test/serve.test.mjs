// The fast path: `snout serve` answers hook events over HTTP exactly as a hook process would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateEntries, squeezeEntries } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const PORT = String(47000 + Math.floor(Math.random() * 900));
const env = { ...process.env, SNOUT_PORT: PORT };
const base = `http://127.0.0.1:${PORT}/snout/v1`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "snout-serve-"));
  mkdirSync(join(dir, ".snout"));
  writeFileSync(join(dir, ".snout/config.json"), JSON.stringify({ mode: "enforce" }));
  const pkgs = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`node_modules/p${i}`, { version: "1.0.0" }]));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: pkgs }));
  return dir;
}
const read = (dir, id) => ({ session_id: "s", cwd: dir, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: id, tool_input: { file_path: join(dir, "package-lock.json") } });

test("serve answers a gate call like the hook process, refuses foreign hosts and non-JSON, and shuts down on request", async () => {
  spawnSync(process.execPath, [CLI, "serve", "--ensure"], { env, timeout: 5000 });
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
  spawnSync(process.execPath, [CLI, "serve", "--ensure"], { env, timeout: 5000 });
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
