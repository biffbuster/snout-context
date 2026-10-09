import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

function project() {
  const root = mkdtempSync(join(tmpdir(), "snout-cloud-"));
  mkdirSync(join(root, ".snout"));
  const row = (o) => JSON.stringify({ ts: new Date().toISOString(), session: "s", turn: 1, tool: "Read", path: "secret/customers.csv", tier: 0, rule: "lockfile", value: 0, confidence: 1, decision: "deny", mode: "enforce", reason: "`secret/customers.csv` is private", bytes: 1, tokensAvoidedEst: 5000, tokensReadEst: 0, jevInputTokens: 0, latencyMs: 1, model: null, reversedByUser: false, ...o });
  writeFileSync(join(root, ".snout/ledger.jsonl"), [row(), row({ path: "src/app.ts", rule: "unclassified", value: 2, decision: "allow", tokensAvoidedEst: 0, tokensReadEst: 700 })].join("\n") + "\n");
  return root;
}

const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("sync sends nothing before login, and --dry-run shows totals with no paths or reasons", () => {
  const root = project();
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  assert.match(run(["sync", root], { SNOUT_CONFIG_DIR: cfg }).stdout, /Not logged in/);
  const out = run(["sync", "--dry-run", root], { SNOUT_CONFIG_DIR: cfg }).stdout;
  const p = JSON.parse(out);
  assert.equal(p.v, 1);
  assert.match(p.project.key, /^[a-f0-9]{24}$/);
  assert.deepEqual(p.days.map((d) => [d.label, d.heldBack, d.inContext]).sort(), [["lockfile", 5000, 0], ["source", 0, 700]]);
  assert.doesNotMatch(out, /customers|secret|app\.ts|private/, "paths and reasons never leave the machine");
});

test("login runs the device flow, stores the token privately, and sync posts with it", async (t) => {
  const got = [];
  let polls = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    got.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const send = (s, j) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.url === "/api/device/start") return send(200, { device_code: "dev_x", user_code: "ABCD-EFGH", verify_url: "http://x/device?code=ABCD-EFGH", interval: 0.05, expires_in: 5 });
    if (req.url === "/api/device/poll") return ++polls < 2 ? send(428, { error: "pending" }) : send(200, { token: "snt_test", user: "alice", team: "alice" });
    if (req.url === "/api/ingest") return send(200, { accepted: 2 });
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  const env = { ...process.env, SNOUT_CONFIG_DIR: cfg };

  const login = await new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "login", "--no-open", "--url", url], { env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", () => resolve(out));
  });
  assert.match(login, /approve code ABCD-EFGH/);
  assert.match(login, /Logged in as alice/);
  const creds = join(cfg, "cloud.json");
  if (process.platform !== "win32") assert.equal(statSync(creds).mode & 0o777, 0o600);

  const root = project();
  const sync = await new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "sync", root], { env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", () => resolve(out));
  });
  assert.match(sync, /Synced 2 day-row/);
  const ingest = got.find((g) => g.url === "/api/ingest");
  assert.equal(ingest.auth, "Bearer snt_test");
  assert.equal(ingest.body.days.length, 2);
  assert.ok(existsSync(join(root, ".snout/cloud-sync.json")), "the sync is stamped so auto-sync can throttle");

  assert.match(run(["logout"], { SNOUT_CONFIG_DIR: cfg }).stdout, /Logged out/);
  assert.ok(!existsSync(creds));
});

test("a cloud agent syncs with SNOUT_TOKEN and no login, sending a hash of its session as the run", async (t) => {
  const got = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    got.push({ auth: req.headers.authorization, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: 2 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const root = project();
  writeFileSync(join(root, ".snout/state.json"), JSON.stringify({ session: "ci-run-42", turn: 1 }));
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "sync", root], { env: { ...process.env, SNOUT_TOKEN: "snt_workspace_key", SNOUT_CLOUD_URL: `http://127.0.0.1:${server.address().port}`, SNOUT_CONFIG_DIR: mkdtempSync(join(tmpdir(), "snout-cfg-")) } });
    let s = "";
    c.stdout.on("data", (d) => (s += d));
    c.on("exit", () => resolve(s));
  });
  assert.match(out, /Synced/);
  assert.equal(got[0].auth, "Bearer snt_workspace_key");
  assert.match(got[0].body.run, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(got[0].body), /ci-run-42/, "the session id itself is not sent");
});
