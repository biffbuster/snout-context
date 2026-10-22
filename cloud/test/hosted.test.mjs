import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.mjs";
import { createApp } from "../src/app.mjs";
import { dayRange, teamView } from "../src/views.mjs";

let server, base, db;

before(async () => {
  db = await openDb(""); // PGlite in memory
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
  return { status: res.status, json, text, headers: res.headers };
}

const signIn = async (login) => (await req(`/auth/dev?login=${login}`)).headers.get("set-cookie").split(";")[0];

/** `snout login`'s device flow, approved in the browser by `cookie`. */
async function cliLogin(cookie, teamId) {
  const start = await req("/api/device/start", { method: "POST", body: {}, origin: null });
  assert.equal((await req("/api/device/approve", { method: "POST", cookie, body: { user_code: start.json.user_code, team_id: Number(teamId) } })).status, 200);
  return (await req("/api/device/poll", { method: "POST", body: { device_code: start.json.device_code }, origin: null })).json.token;
}

const today = new Date().toISOString().slice(0, 10);

test("signed out, every way in leads to the sign-in page, which offers dev sign-in here", async () => {
  assert.equal((await req("/")).headers.get("location"), "/login");
  assert.equal((await req("/app?team=3")).headers.get("location"), "/login?next=%2Fapp%3Fteam%3D3");
  const login = await req("/login");
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(login.text, /Sign in to Snout Cloud/);
  assert.doesNotMatch(login.text, /__SNOUT_ICON__/, "the Snout mark is filled in");
  assert.deepEqual((await req("/auth/config")).json, { github: false, dev: true });
  assert.equal((await req("/api/boot")).status, 401);
  assert.equal((await req("/api/team")).status, 401);
});

test("dev sign-in lands on the dashboard, which boots as hosted with the connect command", async () => {
  const signedIn = await req(`/auth/dev?login=hana&next=${encodeURIComponent("/app")}`);
  assert.equal(signedIn.headers.get("location"), "/app");
  const cookie = signedIn.headers.get("set-cookie").split(";")[0];
  assert.equal((await req("/login", { cookie })).headers.get("location"), "/app", "already signed in");
  assert.equal((await req("/", { cookie })).headers.get("location"), "/app");
  const app = await req("/app", { cookie });
  assert.equal(app.status, 200);
  assert.doesNotMatch(app.text, /__SNOUT_KEY__/, "no local action key in the hosted page");

  const boot = await req("/api/boot", { cookie });
  assert.equal(boot.status, 200);
  assert.equal(boot.json.host, "hosted");
  assert.equal(boot.json.controls, false);
  assert.equal(boot.json.hosted.user.login, "hana");
  assert.equal(boot.json.hosted.teams.length, 1);
  assert.equal(boot.json.hosted.teams[0].personal, true);
  assert.equal(boot.json.hosted.connect, `npx usesnout login --url ${base}`);
  assert.equal(boot.json.cloud.lastSync, null, "no machine yet: the page shows Connect a machine");
});

test("a synced machine shows up in the team view; other people's teams stay invisible", async () => {
  const cookie = await signIn("ivan");
  const team = (await req("/api/boot", { cookie })).json.hosted.team;
  const token = await cliLogin(cookie, team);
  const row = (o) => ({ day: today, client: "claude", label: "lockfile", model: "claude-sonnet-5-5", reads: 3, gated: 3, inContext: 900, heldBack: 60000, couldHoldBack: 0, ...o });
  const spend = (o) => ({ day: today, client: "claude", model: "claude-sonnet-5-5", requests: 10, input: 1000, cacheWrite: 2000, cacheRead: 30000, output: 500, costUsd: 0.25, ...o });
  const sent = await req("/api/ingest", {
    method: "POST", token, origin: null,
    body: { v: 1, snout: "0.3.2", project: { key: "aa11bb22cc33dd44ee55ff66", name: "shopfront" },
      days: [row(), row({ label: "mcp-github", heldBack: 4000, inContext: 100 }), row({ client: "codex", model: "gpt-5.1-codex", label: "source", heldBack: 0, inContext: 5000 })],
      spend: [spend(), spend({ client: "codex", model: "gpt-5.1-codex", costUsd: null })] },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));

  const v = (await req(`/api/team?team=${team}&days=7`, { cookie })).json;
  assert.equal(v.team.id, team);
  assert.equal(v.days, 7);
  assert.equal(v.series.length, 7);
  assert.equal(v.series.at(-1).day, today);
  assert.equal(v.totals.keptOut, 64000);
  assert.equal(v.totals.inContext, 6000);
  assert.equal(v.spend.requests, 20);
  assert.equal(v.spend.costUsd, 0.25);
  assert.deepEqual(v.spend.unpriced, ["gpt-5.1-codex"]);
  assert.deepEqual(v.byClient.map((c) => c.key), ["claude", "codex"]);
  assert.deepEqual(v.byMember.map((m) => [m.key, m.clients.sort().join(",")]), [["ivan", "claude,codex"]]);
  assert.deepEqual(v.byProject.map((p) => p.name), ["shopfront"]);
  assert.deepEqual(v.byMcp.map((m) => [m.key, m.keptOut]), [["github", 4000]]);
  assert.ok(v.byLabel.some((l) => l.key === "mcp"), "MCP servers count as one bucket in the label mix");
  assert.equal(v.machines.length, 1);
  assert.equal(v.machines[0].mine, true);
  assert.equal(v.machines[0].kind, "cli");
  assert.ok(v.lastSyncAt, "the ingest stamps the login");
  assert.ok((await req(`/api/boot?team=${team}`, { cookie })).json.cloud.lastSync);

  const other = await signIn("judy");
  const theirs = (await req(`/api/team?team=${team}`, { cookie: other })).json;
  assert.notEqual(theirs.team.id, team, "asking for someone else's team shows your own");
  assert.equal(theirs.totals.reads, 0);
});

test("the team view zero-fills days and sorts by spend, then by what was kept out", () => {
  assert.deepEqual(dayRange("2026-10-20", 3), ["2026-10-18", "2026-10-19", "2026-10-20"]);
  const u = (o) => ({ day: "2026-10-20", project: "1", login: "a", client: "claude", label: "lockfile", model: "", reads: 1, gated: 1, inContext: 0, heldBack: 10, couldHoldBack: 0, ...o });
  const v = teamView({
    team: { id: "1", name: "a", personal: true, plan: "free", role: "owner", members: 1 }, days: 3, capped: null, today: "2026-10-20", now: "2026-10-20T12:00:00Z",
    usage: [u(), u({ login: "b", heldBack: 50, day: "2026-10-18" })],
    spend: [{ day: "2026-10-19", project: "1", login: "a", client: "claude", model: "opus", requests: 2, tokens: 100, cacheRead: 50, costUsd: 1 }],
    projects: [{ id: "1", name: "web" }], users: [{ login: "a", name: "Ana", avatar: null, agent: false }, { login: "b", name: null, avatar: null, agent: true }],
    machines: [], lastSyncAt: null,
  });
  assert.deepEqual(v.series.map((d) => [d.keptOut, d.costUsd]), [[50, 0], [0, 1], [10, 0]]);
  assert.deepEqual(v.byMember.map((m) => [m.key, m.name, m.agent]), [["a", "Ana", false], ["b", "b", true]]);
  assert.deepEqual(v.byModel.map((m) => m.key), ["opus"], "savings rows from before models were recorded are not a model");
  assert.equal(v.byProject[0].name, "web");
});

test("a failed GitHub return lands on the sign-in page with the reason, not a JSON error", async () => {
  const r = await req("/auth/github/callback?state=stale&code=x");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/login\?error=login%20expired/);
});

test("pages reached under another name for this server move to PUBLIC_URL, so the sign-in cookie survives", async () => {
  const { request } = await import("node:http");
  const { port } = new URL(base);
  const location = await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/login?next=%2Fapp", headers: { host: `localhost:${port}` } }, (res) => { res.resume(); resolve(res.headers.location); }).on("error", reject).end();
  });
  assert.equal(location, `${base}/login?next=%2Fapp`);
});
