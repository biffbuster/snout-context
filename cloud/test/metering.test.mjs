import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.mjs";
import { createApp, PLANS } from "../src/app.mjs";
// Free caps are lowered here so the tests can reach them cheaply.
Object.assign(PLANS.free, { members: 1, projects: 3, historyDays: 7, agentKeys: 1, agentRunsPerDay: 100 });


let server, base, db;
const meterEvents = [];
const checkoutParams = [];

async function fakeStripe(url, init) {
  const u = new URL(url);
  const params = new URLSearchParams(init.body || u.search);
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (u.pathname === "/v1/billing/meter_events") { meterEvents.push(params); return reply({ object: "billing.meter_event" }); }
  if (u.pathname === "/v1/prices") return reply({ data: [{ id: `price_${params.get("lookup_keys[0]")}` }] });
  if (u.pathname === "/v1/checkout/sessions") { checkoutParams.push(params); return reply({ url: "https://checkout.stripe.test/x" }); }
  return { ok: false, status: 404, json: async () => ({ error: { message: "no route" } }) };
}

before(async () => {
  db = await openDb("");
  let handle;
  server = createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  handle = createApp({ db, config: { publicUrl: base, sessionSecret: "t", devLogin: true, stripeKey: "sk_test_x", stripeWebhookSecret: "whsec_x", stripeFetch: fakeStripe } });
});
after(async () => {
  server.close();
  await db.close();
});

async function req(path, { method = "GET", body, cookie, token } = {}) {
  const res = await fetch(base + path, {
    method, redirect: "manual",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method !== "GET" && !token ? { origin: base } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const signIn = async (login) => (await req(`/auth/dev?login=${login}`)).headers.get("set-cookie").split(";")[0];
const today = new Date().toISOString().slice(0, 10);
const sync = (token, run) => req("/api/ingest", { method: "POST", token, body: { v: 1, project: { key: "abcdef0123456789", name: "ci-repo" }, run, days: [{ day: today, client: "claude", label: "lockfile", reads: 1, gated: 1, inContext: 10, heldBack: 900, couldHoldBack: 0 }] } });

test("a workspace key lets a cloud agent sync without a login; a run counts once however often it syncs", async () => {
  const owner = await signIn("wes");
  const team = (await req("/api/me", { cookie: owner })).json.teams[0].id;
  const k = await req(`/api/teams/${team}/keys`, { method: "POST", cookie: owner, body: { label: "GitHub Actions" } });
  assert.equal(k.status, 200);
  assert.match(k.json.key, /^snt_/);
  assert.equal(k.json.label, "github-actions");
  assert.equal((await req(`/api/teams/${team}/keys`, { method: "POST", cookie: owner, body: { label: "second" } })).status, 402, "free plan: one agent key");

  for (let i = 0; i < 3; i++) assert.equal((await sync(k.json.key, "a".repeat(32))).status, 200);
  assert.equal((await sync(k.json.key, "b".repeat(32))).status, 200);
  const keys = (await req(`/api/teams/${team}/keys`, { cookie: owner })).json;
  assert.equal(keys.runsThisMonth, 2, "two sessions, not four syncs");
  assert.equal(keys.keys[0].runsThisMonth, 2);
  assert.equal(keys.perDay, 100);

  const usage = (await req(`/api/usage?team=${team}`, { cookie: owner })).json;
  assert.ok(usage.byMember.some((m) => m.key === "agent:github-actions"), "agent runs show up as their own row");
  assert.equal((await req("/api/tokens", { cookie: owner })).json.tokens.length, 0, "workspace keys aren't listed as the owner's machines");

  const id = keys.keys[0].id;
  assert.equal((await req(`/api/teams/${team}/keys/${id}/revoke`, { method: "POST", cookie: owner })).status, 200);
  assert.equal((await sync(k.json.key, "c".repeat(32))).status, 401, "a revoked key stops syncing");
});

test("free teams are capped at 100 cloud-agent runs a day", async () => {
  const owner = await signIn("fay");
  const team = (await req("/api/me", { cookie: owner })).json.teams[0].id;
  const key = (await req(`/api/teams/${team}/keys`, { method: "POST", cookie: owner, body: { label: "ci" } })).json.key;
  const [tok] = await db.query("select id from tokens where team_id = $1 and kind = 'workspace'", [team]);
  for (let i = 0; i < 100; i++) await db.query("insert into agent_runs (team_id, token_id, run_hash) values ($1, $2, $3)", [team, tok.id, String(i).padStart(3, "0").padEnd(32, "e")]);
  const over = await sync(key, "f".repeat(32));
  assert.equal(over.status, 402);
  assert.equal(over.json.cap, "agent_runs");
  assert.equal((await sync(key, "005".padEnd(32, "e"))).status, 200, "a run already counted keeps syncing");
});

test("paid teams report each new run to Stripe once, and checkout includes the metered price", async () => {
  const owner = await signIn("gil");
  const teamId = Number((await req("/api/teams", { method: "POST", cookie: owner, body: { name: "Paid Co" } })).json.id);
  await db.query("update teams set plan = 'team', stripe_customer_id = 'cus_paid' where id = $1", [teamId]);
  const key = (await req(`/api/teams/${teamId}/keys`, { method: "POST", cookie: owner, body: { label: "codex-cloud" } })).json.key;
  const before = meterEvents.length;
  await sync(key, "1".repeat(32));
  await sync(key, "1".repeat(32));
  await sync(key, "2".repeat(32));
  await new Promise((r) => setTimeout(r, 50));
  const sent = meterEvents.slice(before);
  assert.equal(sent.length, 2, "two runs, two meter events");
  assert.equal(sent[0].get("event_name"), "snout_agent_run");
  assert.equal(sent[0].get("payload[stripe_customer_id]"), "cus_paid");
  assert.equal(sent[0].get("payload[value]"), "1");
  assert.equal(sent[0].get("identifier"), `${teamId}-${"1".repeat(32)}`, "Stripe dedupes retries on the identifier");

  await db.query("update teams set plan = 'free', stripe_customer_id = null where id = $1", [teamId]);
  await req("/api/billing/checkout", { method: "POST", cookie: owner, body: { team_id: teamId } });
  const co = checkoutParams.at(-1);
  assert.equal(co.get("line_items[1][price]"), "price_snout_agent_runs");
  assert.equal(co.get("line_items[1][quantity]"), null, "metered prices carry no quantity");
});
