import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.mjs";
import { createApp, PLANS } from "../src/app.mjs";
// Free caps are lowered here so the tests can reach them cheaply.
Object.assign(PLANS.free, { members: 1, projects: 3, historyDays: 7, agentKeys: 1, agentRunsPerDay: 100 });


let server, base, db;

before(async () => {
  db = await openDb(""); // PGlite in memory: the same SQL production runs on Postgres
  server = createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  var handle = createApp({ db, config: { publicUrl: base, sessionSecret: "test-secret", devLogin: true } });
});
after(async () => {
  server.close();
  await db.close();
});

async function req(path, { method = "GET", body, cookie, token, origin = base } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method !== "GET" && origin ? { origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}

async function signIn(login) {
  const r = await req(`/auth/dev?login=${login}`);
  assert.equal(r.status, 302);
  return r.headers.get("set-cookie").split(";")[0];
}

async function cliLogin(cookie, teamId) {
  const start = await req("/api/device/start", { method: "POST", body: {}, origin: null });
  assert.equal(start.status, 200);
  assert.match(start.json.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal((await req("/api/device/poll", { method: "POST", body: { device_code: start.json.device_code }, origin: null })).status, 428);
  const ok = await req("/api/device/approve", { method: "POST", cookie, body: { user_code: start.json.user_code, team_id: teamId } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const poll = await req("/api/device/poll", { method: "POST", body: { device_code: start.json.device_code }, origin: null });
  assert.equal(poll.status, 200);
  assert.match(poll.json.token, /^snt_/);
  assert.equal((await req("/api/device/poll", { method: "POST", body: { device_code: start.json.device_code }, origin: null })).status, 410, "a code yields one token");
  return poll.json.token;
}

const today = new Date().toISOString().slice(0, 10);
const payload = (days, key = "a1b2c3d4e5f6a7b8c9d0e1f2") => ({ v: 1, snout: "0.2.0", project: { key, name: "shopfront" }, days });
const row = (o) => ({ day: today, client: "claude", label: "lockfile", reads: 3, gated: 3, inContext: 900, heldBack: 60000, couldHoldBack: 0, ...o });

test("sign in, connect the CLI, sync, and read it back on the dashboard", async () => {
  const cookie = await signIn("alice");
  const me = await req("/api/me", { cookie });
  assert.equal(me.status, 200);
  const personal = me.json.teams.find((t) => t.personal);
  assert.equal(personal.name, "alice");

  const token = await cliLogin(cookie, personal.id);
  const sent = await req("/api/ingest", { method: "POST", token, body: payload([row(), row({ label: "source", gated: 0, inContext: 40000, heldBack: 0, reads: 20 }), row({ client: "codex", heldBack: 5000, inContext: 100 })]), origin: null });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));

  const u = await req(`/api/usage?team=${personal.id}&days=30`, { cookie });
  assert.equal(u.status, 200);
  assert.equal(u.json.totals.heldBack, 65000);
  assert.equal(u.json.totals.inContext, 41000);
  assert.equal(u.json.byProject[0].name, "shopfront");
  assert.deepEqual(u.json.byClient.map((c) => c.key), ["claude", "codex"]);
  assert.equal(u.json.series.at(-1).key, today);

  // A resync of the same day replaces it rather than adding to it.
  await req("/api/ingest", { method: "POST", token, body: payload([row({ heldBack: 1000 })]), origin: null });
  const again = await req(`/api/usage?team=${personal.id}`, { cookie });
  assert.equal(again.json.totals.heldBack, 1000);

  // Spend: measured usage per model, replaced per day like the totals.
  const spend = [{ day: today, client: "claude", model: "claude-opus-5-5", requests: 10, input: 100, cacheWrite: 1000, cacheRead: 50000, output: 2000, costUsd: 0.06 },
    { day: today, client: "codex", model: "gpt-6-astra", requests: 2, input: 10, cacheWrite: 0, cacheRead: 100, output: 50, costUsd: 0.0026 },
    { day: today, client: "claude", model: "claude-new-model", requests: 1, input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: null }];
  assert.equal((await req("/api/ingest", { method: "POST", token, body: { ...payload([row({ heldBack: 1000 })]), spend }, origin: null })).json.spend, 3);
  const sp = (await req(`/api/usage?team=${personal.id}`, { cookie })).json.spend;
  assert.ok(Math.abs(sp.costUsd - 0.0626) < 1e-9);
  assert.equal(sp.requests, 13);
  assert.equal(sp.byModel[0].key, "claude-opus-5-5");
  assert.deepEqual(sp.unpriced, ["claude-new-model"]);
  // The live view: today's totals, per-model today and 7-day spend, and who synced last.
  const live = (await req(`/api/usage?team=${personal.id}`, { cookie })).json;
  assert.equal(live.today.heldBack, 1000);
  assert.deepEqual([sp.byModel[0].client, sp.byModel[0].today.requests], ["claude", 10]);
  assert.ok(Math.abs(sp.byModel[0].weekCostUsd - 0.06) < 1e-9);
  assert.ok(Math.abs(sp.today.costUsd - 0.0626) < 1e-9);
  assert.deepEqual([live.activity[0].login, live.activity[0].project, live.activity[0].heldBack], ["alice", "shopfront", 1000]);
  assert.ok(Date.parse(live.lastSyncAt) > Date.now() - 60_000);
  await req("/api/ingest", { method: "POST", token, body: { ...payload([row({ heldBack: 1000 })]), spend: spend.slice(0, 1) }, origin: null });
  assert.equal((await req(`/api/usage?team=${personal.id}`, { cookie })).json.spend.requests, 10, "a resent day replaces its spend");
  assert.equal((await req("/api/ingest", { method: "POST", token, body: { ...payload([]), spend: [{ ...spend[0], model: "Robert'); drop" }] }, origin: null })).status, 400);

  // MCP servers sync as "mcp-<server>" labels: one bucket in the mix, and a per-server list.
  await req("/api/ingest", { method: "POST", token, body: payload([row({ heldBack: 1000 }), row({ label: "mcp-github", reads: 4, inContext: 3000, heldBack: 9000 }), row({ label: "mcp-linear", reads: 1, inContext: 500, heldBack: 0 })]), origin: null });
  const mcp = (await req(`/api/usage?team=${personal.id}`, { cookie })).json;
  assert.deepEqual(mcp.byMcp.map((m) => [m.key, m.reads, m.heldBack]), [["github", 4, 9000], ["linear", 1, 0]]);
  assert.deepEqual(mcp.byLabel.find((l) => l.key === "mcp"), { key: "mcp", reads: 5, inContext: 3500, heldBack: 9000, couldHoldBack: 0 });
  await req("/api/ingest", { method: "POST", token, body: payload([row({ heldBack: 1000 })]), origin: null });

  // Filters.
  const codex = await req(`/api/usage?team=${personal.id}&client=codex`, { cookie });
  assert.equal(codex.json.totals.reads, 0);
});

test("the ingest endpoint refuses bad tokens and malformed or oversized payloads", async () => {
  assert.equal((await req("/api/ingest", { method: "POST", token: "snt_nope", body: payload([row()]), origin: null })).status, 401);
  const cookie = await signIn("bob");
  const team = (await req("/api/me", { cookie })).json.teams[0].id;
  const token = await cliLogin(cookie, team);
  const bad = async (p) => (await req("/api/ingest", { method: "POST", token, body: p, origin: null })).status;
  assert.equal(await bad({ ...payload([row()]), v: 2 }), 400);
  assert.equal(await bad(payload([row()], "../etc")), 400);
  assert.equal(await bad(payload([row({ label: "<script>" })])), 400);
  assert.equal(await bad(payload([row({ reads: -1 })])), 400);
  assert.equal(await bad(payload([row({ day: "yesterday" })])), 400);
  assert.equal(await bad(payload(Array.from({ length: 2001 }, () => row()))), 400);
});

test("cookie writes from another origin are refused, and next never leaves the site", async () => {
  const cookie = await signIn("carol");
  const team = (await req("/api/me", { cookie })).json.teams[0].id;
  const start = await req("/api/device/start", { method: "POST", body: {}, origin: null });
  const cross = await req("/api/device/approve", { method: "POST", cookie, body: { user_code: start.json.user_code, team_id: team }, origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
    const r = await req(`/auth/dev?login=carol&next=${encodeURIComponent(next)}`);
    assert.equal(r.headers.get("location"), "/", next);
  }
  const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await req("/api/me", { cookie: tampered })).status, 401);
});

test("people see only their teams; a team pools members via an invite link; revoked logins stop syncing", async () => {
  const dan = await signIn("dan");
  const erin = await signIn("erin");
  const danPersonal = (await req("/api/me", { cookie: dan })).json.teams[0].id;
  assert.equal((await req(`/api/usage?team=${danPersonal}`, { cookie: erin })).status, 404, "another person's workspace is invisible");

  const team = await req("/api/teams", { method: "POST", cookie: dan, body: { name: "Shop" } });
  assert.equal(team.status, 200);
  const blocked = await req(`/api/teams/${team.json.id}/invites`, { method: "POST", cookie: dan });
  assert.equal(blocked.status, 402, "a free team is one person");
  assert.equal(blocked.json.cap, "members");
  await db.query("update teams set plan = 'team' where id = $1", [Number(team.json.id)]); // what the Stripe webhook will do
  const inv = await req(`/api/teams/${team.json.id}/invites`, { method: "POST", cookie: dan });
  assert.equal(inv.status, 200);
  const path = new URL(inv.json.url).pathname;
  assert.equal((await req(path)).status, 302, "signed out: sent to sign in first");
  const joined = await req(path, { cookie: erin });
  assert.equal(joined.headers.get("location"), `/?team=${team.json.id}`);
  assert.equal((await req(`/api/teams/${team.json.id}/invites`, { method: "POST", cookie: erin })).status, 403, "members cannot invite");

  const tDan = await cliLogin(dan, Number(team.json.id));
  const tErin = await cliLogin(erin, Number(team.json.id));
  await req("/api/ingest", { method: "POST", token: tDan, body: payload([row({ heldBack: 100 })]), origin: null });
  await req("/api/ingest", { method: "POST", token: tErin, body: payload([row({ heldBack: 200 })]), origin: null });
  const u = await req(`/api/usage?team=${team.json.id}`, { cookie: erin });
  assert.equal(u.json.totals.heldBack, 300, "same project key from two people: both counted, neither overwritten");
  assert.deepEqual(u.json.byMember.map((m) => m.key).sort(), ["dan", "erin"]);

  const list = await req("/api/tokens", { cookie: erin });
  const id = list.json.tokens.find((k) => k.team === "Shop").id;
  assert.equal((await req(`/api/tokens/${id}/revoke`, { method: "POST", cookie: dan })).status, 404, "only the owner of a login can revoke it");
  assert.equal((await req(`/api/tokens/${id}/revoke`, { method: "POST", cookie: erin })).status, 200);
  assert.equal((await req("/api/ingest", { method: "POST", token: tErin, body: payload([row()]), origin: null })).status, 401);
});

test("pages carry a strict CSP and the health check reports the engine", async () => {
  const r = await fetch(base + "/");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const hz = await req("/healthz");
  assert.equal(hz.json.engine, "pglite");
});

test("free plan caps: 3 projects, 7 days shown; the local tool is never capped", async () => {
  const cookie = await signIn("fran");
  const me = (await req("/api/me", { cookie })).json;
  const personal = me.teams[0];
  assert.deepEqual([personal.plan, personal.limits.projects, personal.limits.historyDays], ["free", 3, 7]);
  const token = await cliLogin(cookie, personal.id);
  const send = (key) => req("/api/ingest", { method: "POST", token, body: payload([row()], key), origin: null });
  for (const k of ["aaaaaaaa11", "bbbbbbbb22", "cccccccc33"]) assert.equal((await send(k)).status, 200);
  const fourth = await send("dddddddd44");
  assert.equal(fourth.status, 402);
  assert.equal(fourth.json.cap, "projects");
  assert.match(fourth.json.upgrade, /upgrade/);
  assert.equal((await send("aaaaaaaa11")).status, 200, "the first three keep syncing");

  const u = (await req(`/api/usage?team=${personal.id}&days=90`, { cookie })).json;
  assert.equal(u.days, 7);
  assert.deepEqual(u.capped, { historyDays: 7 });
  assert.equal(u.plan, "free");
});

test("savings split by model: the same day and file type keep a row per model", async () => {
  const cookie = await signIn("mona");
  const team = (await req("/api/me", { cookie })).json.teams[0].id;
  const token = await cliLogin(cookie, team);
  const r = await req("/api/ingest", { method: "POST", token, origin: null, body: payload([row({ model: "claude-opus-5-5", heldBack: 5000 }), row({ model: "claude-haiku-4-5", heldBack: 1000 }), row({ heldBack: 7 })], "c0ffee0123456789") });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const u = (await req(`/api/usage?team=${team}`, { cookie })).json;
  assert.deepEqual(u.byModel.map((m) => [m.key, m.heldBack]), [["claude-opus-5-5", 5000], ["claude-haiku-4-5", 1000], ["unknown", 7]]);
  assert.equal((await req("/api/ingest", { method: "POST", token, origin: null, body: payload([row({ model: "Bad Model!" })], "c0ffee0123456789") })).status, 400);
});
