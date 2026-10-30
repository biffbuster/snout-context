// The dashboard's pages, end to end: a project with Snout's ledger and one Claude Code transcript,
// served by `snout dashboard`, read through /api/*. Every root is a temp folder; nothing leaves the machine.
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const SESSION = "0d5c1f3e-1111-4222-8333-944445555666";
const at = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString();

function call(port, method, path, body, headers = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => done({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on("error", fail);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const api = async (port, path) => {
  const r = await call(port, "GET", path);
  assert.equal(r.status, 200, `${path}: ${r.text}`);
  return r.json();
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "snout-pages-"));
  const claude = mkdtempSync(join(tmpdir(), "snout-claude-"));
  const codex = mkdtempSync(join(tmpdir(), "snout-codex-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  mkdirSync(join(root, ".snout"));
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  const slug = resolve(root).replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(claude, "projects", slug), { recursive: true });
  const base = { sessionId: SESSION, cwd: root, version: "2.1.0", gitBranch: "main", entrypoint: "cli" };
  const lines = [
    { ...base, type: "user", timestamp: at(10), uuid: "u1", message: { role: "user", content: 'fix the build <pasted_content id="p1">error log</pasted_content>' } },
    { ...base, type: "assistant", timestamp: at(9.9), uuid: "a1", requestId: "req1", message: { id: "m1", model: "claude-opus-5-5", role: "assistant", usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000, output_tokens: 500 }, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(root, "package-lock.json") } }] } },
    { ...base, type: "user", timestamp: at(9.8), uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "trimmed by snout" }] } },
    { ...base, type: "assistant", timestamp: at(9.7), uuid: "a2", requestId: "req2", message: { id: "m2", model: "claude-opus-5-5", role: "assistant", usage: { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 21000, output_tokens: 100 }, content: [{ type: "text", text: "Done." }] } },
    { ...base, type: "system", subtype: "turn_duration", timestamp: at(9.6), durationMs: 24000 },
  ];
  writeFileSync(join(claude, "projects", slug, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const row = (o) => ({ ts: at(9.85), session: SESSION, turn: 1, tool: "Read", path: "package-lock.json", tier: 0, rule: "unclassified", value: 2, confidence: 0, decision: "allow", mode: "enforce", reason: "", bytes: 0, tokensAvoidedEst: 0, tokensReadEst: 0, jevInputTokens: 0, latencyMs: 5, model: null, reversedByUser: false, ...o });
  writeFileSync(join(root, ".snout/ledger.jsonl"), [
    row({ rule: "lockfile", value: 0, decision: "deny", trimmed: true, tokensAvoidedEst: 9000, tokensReadEst: 40 }),
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Memory as agents get it: the session-start line, then one search and one fetch through Snout's MCP server.
  writeFileSync(join(root, ".snout/recall.jsonl"), [
    { ts: at(10.5), session: SESSION, kind: "hint", unfinished: "s0", tokensEst: 90 },
    { ts: at(9.95), session: SESSION, kind: "search", asked: "build error", shown: ["session:s0"], tokensEst: 60 },
    { ts: at(9.9), session: SESSION, kind: "fetch", asked: "session:s0", shown: ["session:s0"], tokensEst: 120 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(root, ".snout/config.json"), JSON.stringify({ mode: "enforce" }));
  writeFileSync(join(root, ".snout/errors.jsonl"), [
    { ts: at(60 * 24 * 10), where: "squeeze log", error: "EPERM: operation not permitted, rename" },
    { ts: at(30), where: "hook", error: "recent failure" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { root, env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, SNOUT_CONFIG_DIR: cfg } };
}

async function serve(t) {
  const f = fixture();
  const child = spawn(process.execPath, [CLI, "dashboard", "--no-open", "--port", "0", f.root], { stdio: ["ignore", "pipe", "pipe"], env: f.env });
  t.after(() => child.kill());
  const port = await new Promise((done, fail) => {
    let out = "";
    child.stdout.on("data", (c) => { out += c; const m = /127\.0\.0\.1:(\d+)/.exec(out); if (m) done(Number(m[1])); });
    child.on("exit", (code) => fail(new Error(`exited ${code}`)));
  });
  return { ...f, port };
}

test("dashboard pages read the agent's log and Snout's ledger, and count savings once", async (t) => {
  const { port } = await serve(t);
  const boot = await api(port, "/api/boot");
  assert.equal(boot.host, undefined, "the dashboard is local only");
  assert.equal(boot.controls, true);
  assert.equal(boot.project.current, true);

  const o = await api(port, "/api/overview?range=24h");
  assert.equal(o.usage.requests, 2, "two model requests in the transcript");
  assert.ok(o.usage.costUsd > 0, "billed cost at list price");
  assert.equal(o.snout.keptOut, 9000);
  const inputRate = o.savedUsd / 9000 * 1e6;
  assert.ok(inputRate > 0 && inputRate < 100, "kept out is priced once, at the model's input rate");
  assert.equal(o.snout.couldKeepOut, 0, "enforce mode has nothing in would-keep-out");

  const [s] = await api(port, "/api/sessions?range=24h");
  assert.equal(s.id, SESSION);
  assert.equal(s.client, "claude");
  assert.ok(!/pasted_content/.test(s.title), `prompt wrappers are stripped: ${s.title}`);
  assert.match(s.title, /fix the build/);

  const tr = await api(port, `/api/trace?id=${SESSION}`);
  const kinds = new Set(tr.nodes.map((n) => n.kind));
  for (const k of ["prompt", "request", "read"]) assert.ok(kinds.has(k), `trace has a ${k} node`);
  const snout = tr.nodes.find((n) => n.path && n.path.endsWith("package-lock.json") && n.keptOut === 9000);
  assert.ok(snout, "Snout's decision hangs under the Read it acted on");
  const read = tr.nodes.find((n) => n.kind === "read");
  assert.equal(snout.parent, read.id);

  const detail = await api(port, `/api/session?id=${SESSION}`);
  assert.equal(detail.turns[0].checked, 1, "the turn's one tool call passed Snout's hooks");
  assert.equal(detail.turns[0].keptOut, 9000);
  assert.ok(Array.isArray(detail.passed), "what passed through whole is listed by reason");

  const agents = await api(port, "/api/agents?range=24h");
  const main = agents.agents.find((a) => a.client === "claude" && a.role === "main");
  assert.equal(main.sessions, 1);
  assert.equal(main.keptOut, 9000);
  assert.ok(!agents.agents.some((a) => a.client === "codex" && a.status === "connected"), "no Codex logs, no Codex connection");

  const integ = await api(port, "/api/integrations");
  assert.ok(!integ.some((i) => i.id === "agent:codex" && i.status === "connected"));
  assert.ok(!integ.some((i) => i.id === "service:cloud"), "there is no hosted sync");

  const priv = await api(port, "/api/privacy");
  assert.ok(priv.local.network.every((n) => !n.on), "nothing is sent by default");

  const an = await api(port, "/api/analytics?range=24h");
  assert.equal(an.byModel.reduce((a, m) => a + m.keptOut, 0), 9000, "kept out is not counted twice across models");
  assert.deepEqual(an.retention, { compactions: 0, hints: 1, searches: 1, opened: 1, notesShown: 0 });
  const memory = tr.nodes.filter((n) => n.kind === "brief" || n.kind === "recall").map((n) => [n.label, n.detail]);
  assert.deepEqual(memory, [["Memory pointer", "One line: earlier sessions are on record and how to search them; one left work unfinished"], ["Memory search", '"build error": 1 record shown'], ["Memory fetch", "Opened session:s0"]]);
});

test("Snout's corner animation is served from the dashboard itself, and the page allows only that", async (t) => {
  const { port } = await serve(t);
  const img = await call(port, "GET", "/snout-mascot.webp");
  assert.equal(img.status, 200);
  const page = await new Promise((done, fail) => {
    request({ host: "127.0.0.1", port, path: "/", headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); done(res); }).on("error", fail).end();
  });
  const csp = page.headers["content-security-policy"];
  assert.match(csp, /img-src 'self' data:/, "images: this server and inline only");
  assert.match(csp, /default-src 'none'/);
});

test("settings change only allowed keys, only with the page's key", async (t) => {
  const { port, root } = await serve(t);
  const key = /data-key="([^"]+)"/.exec((await call(port, "GET", "/")).text)[1];
  const cfg = () => JSON.parse(readFileSync(join(root, ".snout/config.json"), "utf8"));
  assert.equal((await call(port, "POST", "/api/action", { type: "set", key: "repeatReads", value: false })).status, 403);
  assert.equal((await call(port, "POST", "/api/action", { type: "set", key: "repeatReads", value: false }, { "x-snout-key": key })).status, 200);
  assert.equal(cfg().repeatReads, false);
  assert.notEqual((await call(port, "POST", "/api/action", { type: "set", key: "sizeCapBytes", value: 1 }, { "x-snout-key": key })).status, 200, "keys outside the list are refused");
  assert.notEqual((await call(port, "POST", "/api/action", { type: "set", key: "mode", value: "yolo" }, { "x-snout-key": key })).status, 200, "values outside the list are refused");
  assert.equal(cfg().mode, "enforce");
  assert.equal((await call(port, "POST", "/api/action", { type: "allow", path: "package-lock.json" }, { "x-snout-key": key })).status, 200);
  assert.ok(cfg().alwaysAllow.includes("package-lock.json"));
  assert.equal((await call(port, "POST", "/api/action", { type: "unallow", path: "package-lock.json" }, { "x-snout-key": key })).status, 200);
  assert.ok(!cfg().alwaysAllow.includes("package-lock.json"));
  const settings = await api(port, "/api/settings");
  assert.equal(settings.values.repeatReads, false);
  assert.deepEqual(settings.health.recent.map((e) => e.where), ["hook"], "only the last week's errors are listed");
  assert.equal(settings.health.older, 1, "older errors are counted, not listed");
});
