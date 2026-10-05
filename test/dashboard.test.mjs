import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { summarizeLedger, dailyAggregates } from "../dist/lib.mjs";

const CLI = new URL("../dist/snout.mjs", import.meta.url).pathname;

const row = (o) => ({
  ts: "2026-09-28T10:00:00.000Z", session: "s1", turn: 1, tool: "Read", path: "src/a.ts", tier: 0, rule: "unclassified",
  value: 2, confidence: 0, decision: "allow", mode: "enforce", reason: "", bytes: 0, tokensAvoidedEst: 0, tokensReadEst: 0,
  jevInputTokens: 0, latencyMs: 5, model: null, reversedByUser: false, ...o,
});

test("summary: held back counts denials and trims, in context counts what the agent got", () => {
  const s = summarizeLedger([
    row({ path: "src/a.ts", tokensReadEst: 1000 }),
    row({ path: "package-lock.json", rule: "lockfile", value: 0, decision: "deny", trimmed: true, tokensReadEst: 800, tokensAvoidedEst: 9000, ts: "2026-09-28T10:01:00.000Z" }),
    row({ path: "dist/x.min.js", rule: "minified", value: 0, decision: "deny", tokensAvoidedEst: 5000, client: "codex", session: "s2", ts: "2026-09-28T10:02:00.000Z" }),
    row({ path: "vendor/y.js", rule: "vendored", value: 1, observedOnly: true, tokensReadEst: 3000, tokensAvoidedEst: 3000 }),
    row({ rule: "tool-output", tool: "Grep", path: "", tokensReadEst: 400 }),
  ]);
  assert.equal(s.reads, 4);
  assert.equal(s.heldBack, 14000);
  assert.equal(s.inContext, 1000 + 800 + 3000);
  assert.equal(s.couldHoldBack, 3000);
  assert.equal(s.toolOutput, 400);
  assert.equal(s.gated, 2);
  assert.ok(Math.abs(s.savedShare - 14000 / (14000 + 4800 + 400)) < 1e-9);
  assert.deepEqual(s.byClient.map((c) => [c.key, c.heldBack]), [["claude", 9000], ["codex", 5000]]);
  assert.equal(s.byLabel[0].key, "lockfile");
  assert.equal(s.topHeld[0].key, "package-lock.json");
  assert.equal(s.recent[0].outcome, "would hold back"); // newest first: the observed vendored row came last
  assert.equal(s.recent.find((r) => r.path === "package-lock.json").outcome, "trimmed");
  assert.equal(s.sessions.length, 2);
  assert.equal(s.timeline.at(-1).heldBack, 14000);
  // The with/without chart: held-back files first, then the largest full reads, with the card's details.
  assert.deepEqual(s.files.map((f) => f.key).slice(0, 2), ["package-lock.json", "dist/x.min.js"]);
  const lock = s.files[0];
  assert.equal(lock.label, "lockfile");
  assert.equal(lock.trimmed, 1);
  assert.equal(lock.history[0].outcome, "trimmed");
  assert.ok(s.files.some((f) => f.key === "src/a.ts" && f.heldBack === 0));
});

test("summary: an overridden denial is not counted as held back", () => {
  const s = summarizeLedger([
    row({ path: "package-lock.json", rule: "lockfile", value: 0, decision: "deny", tokensAvoidedEst: 9000 }),
    row({ path: "package-lock.json", rule: "reversal", decision: "allow", tokensReadEst: 9000 }),
  ]);
  assert.equal(s.heldBack, 0);
  assert.equal(s.overridden, 1);
});

test("summary: image reads cost vision tokens, not bytes, even in old rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "snout-dash-img-"));
  mkdirSync(join(root, ".snout"));
  writeFileSync(join(root, ".snout/ledger.jsonl"), JSON.stringify(row({ path: "shot.png", rule: "binary-content", observedOnly: true, tokensReadEst: 272107, tokensAvoidedEst: 272107 })) + "\n");
  const { readDecisions } = await import("../dist/lib.mjs");
  const [r] = readDecisions(join(root, ".snout/ledger.jsonl"), 10);
  assert.equal(r.tokensReadEst, 1600);
});

function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("snout dashboard serves the page, a summary, and pushes new ledger rows live", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "snout-dash-"));
  mkdirSync(join(root, ".snout"));
  const ledger = join(root, ".snout/ledger.jsonl");
  appendFileSync(ledger, JSON.stringify(row({ tokensReadEst: 500 })) + "\n");

  const child = spawn(process.execPath, [CLI, "dashboard", "--no-open", "--port", "0", root], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const m = /127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}`)));
  });

  const page = await get(port, "/");
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /Kept out of context/);
  assert.doesNotMatch(page.body, /https?:\/\/(?!www\.w3\.org)/, "the page loads nothing from the network");

  const api = JSON.parse((await get(port, "/api/summary")).body);
  assert.equal(api.reads, 1);
  assert.equal(api.inContext, 500);

  assert.equal((await get(port, "/", "evil.example:80")).status, 403, "DNS rebinding: a foreign Host is refused");

  // Live: open the event stream, append a denial, and wait for a summary that includes it.
  const heldBack = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = "";
      let first = true;
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (!data) continue;
          const s = JSON.parse(data);
          if (first) {
            first = false;
            appendFileSync(ledger, JSON.stringify(row({ path: "yarn.lock", rule: "lockfile", value: 0, decision: "deny", tokensAvoidedEst: 7000 })) + "\n");
          } else if (s.heldBack > 0) {
            req.destroy();
            resolve(s.heldBack);
          }
        }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    req.end();
    setTimeout(() => reject(new Error("no live update within 5s")), 5000);
  });
  assert.equal(heldBack, 7000);
});

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("the dashboard's buttons need the page's key, and do what the CLI does", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "snout-dash-act-"));
  mkdirSync(join(root, ".snout"));
  appendFileSync(join(root, ".snout/ledger.jsonl"), JSON.stringify(row({ tokensReadEst: 500 })) + "\n");
  const child = spawn(process.execPath, [CLI, "dashboard", "--no-open", "--port", "0", root], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SNOUT_CONFIG_DIR: mkdtempSync(join(tmpdir(), "snout-cfg-")) } });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => { out += c; const m = /127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on("exit", (code) => reject(new Error(`exited ${code}`)));
  });
  const page = (await get(port, "/")).body;
  const key = /data-key="([^"]+)"/.exec(page)[1];
  assert.ok(key.length >= 24 && !page.includes("__SNOUT_KEY__"));

  assert.equal((await post(port, "/api/action", { type: "mode", value: "enforce" })).status, 403, "no key, no change");
  assert.equal((await post(port, "/api/action", { type: "mode", value: "enforce" }, { "x-snout-key": "x".repeat(key.length) })).status, 403);

  const on = await post(port, "/api/action", { type: "mode", value: "enforce" }, { "x-snout-key": key });
  assert.equal(on.status, 200);
  assert.equal(JSON.parse(readFileSync(join(root, ".snout/config.json"), "utf8")).mode, "enforce");
  assert.ok(existsSync(join(root, ".claude/settings.local.json")), "the gate is installed by the button too");

  assert.equal((await post(port, "/api/action", { type: "allow", path: "yarn.lock" }, { "x-snout-key": key })).status, 200);
  assert.ok(JSON.parse(readFileSync(join(root, ".snout/config.json"), "utf8")).alwaysAllow.includes("yarn.lock"));
  assert.equal((await post(port, "/api/action", { type: "allow", path: "../../etc/passwd" }, { "x-snout-key": key })).status, 500, "paths outside the project are refused");

  const summary = JSON.parse((await get(port, "/api/summary")).body);
  assert.equal(summary.meta.mode, "enforce");
  assert.equal(summary.meta.controls, true);
});

test("MCP results add up per server, across trims, repeat skips and untrimmed calls, and sync per server", () => {
  const rows = [
    row({ rule: "tool-output", tool: "mcp__github__list_issues", path: "mcp__github__list_issues", tokensReadEst: 2000 }),
    row({ rule: "mcp-output", tool: "mcp__github__search_code", path: "mcp: github › search_code", decision: "deny", trimmed: true, tokensReadEst: 1500, tokensAvoidedEst: 6000 }),
    row({ rule: "repeat-output", tool: "mcp__github__list_issues", path: "mcp: github › list_issues", decision: "deny", trimmed: true, tokensReadEst: 30, tokensAvoidedEst: 1970 }),
    row({ rule: "mcp-output", tool: "mcp__claude_ai_Linear__list", path: "mcp: claude_ai_Linear › list", decision: "deny", trimmed: true, tokensReadEst: 500, tokensAvoidedEst: 4500 }),
    row({ path: "src/a.ts", tokensReadEst: 1000 }),
  ];
  const s = summarizeLedger(rows);
  assert.deepEqual(s.byMcpServer.map((m) => [m.key, m.reads, m.inContext, m.heldBack]), [
    ["github", 3, 3530, 7970],
    ["claude_ai_Linear", 1, 500, 4500],
  ]);
  const days = dailyAggregates(rows);
  const gh = days.filter((d) => d.label === "mcp-github");
  assert.equal(gh.reduce((a, d) => a + d.reads, 0), 3);
  assert.equal(gh.reduce((a, d) => a + d.heldBack, 0), 7970);
  assert.ok(days.some((d) => d.label === "mcp-claude-ai-linear"), "server names become cloud-safe slugs");
  assert.ok(days.every((d) => /^[a-z0-9-]{1,32}$/.test(d.label)));
});
