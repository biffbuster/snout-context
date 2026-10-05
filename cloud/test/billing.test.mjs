import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { openDb } from "../src/db.mjs";
import { createApp, PLANS } from "../src/app.mjs";
// Free caps are lowered here so the tests can reach them cheaply.
Object.assign(PLANS.free, { members: 1, projects: 3, historyDays: 7, agentKeys: 1, agentRunsPerDay: 100 });


let server, base, db;
const calls = [];
const WHSEC = "whsec_test_secret";

/** A stand-in for api.stripe.com that answers the calls Snout makes. */
async function fakeStripe(url, init) {
  const u = new URL(url);
  const params = new URLSearchParams(init.body || u.search);
  calls.push({ method: init.method, path: u.pathname, params });
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (u.pathname === "/v1/prices") return reply({ data: [{ id: `price_${params.get("lookup_keys[0]")}` }] });
  if (u.pathname === "/v1/checkout/sessions") return reply({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
  if (u.pathname === "/v1/billing_portal/sessions") return reply({ url: "https://billing.stripe.test/p_1" });
  if (u.pathname.startsWith("/v1/subscriptions/")) return reply(sub({ quantity: 3 }));
  return { ok: false, status: 404, json: async () => ({ error: { message: "no route" } }) };
}

let teamId;
const sub = ({ status = "active", quantity = 3 } = {}) => ({
  id: "sub_1", customer: "cus_1", status, current_period_end: 1_900_000_000,
  items: { data: [{ quantity }] }, metadata: { team_id: String(teamId) },
});

before(async () => {
  db = await openDb("");
  let handle;
  server = createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  handle = createApp({ db, config: { publicUrl: base, sessionSecret: "t", devLogin: true, stripeKey: "sk_test_x", stripeWebhookSecret: WHSEC, stripeFetch: fakeStripe } });
});
after(async () => {
  server.close();
  await db.close();
});

async function req(path, { method = "GET", body, cookie, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method, redirect: "manual",
    headers: { ...(body || raw ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: base } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const signIn = async (login) => (await req(`/auth/dev?login=${login}`)).headers.get("set-cookie").split(";")[0];
const webhook = (event, secret = WHSEC, t = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(event);
  const sig = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return req("/api/stripe/webhook", { method: "POST", raw, headers: { "stripe-signature": `t=${t},v1=${sig}` } });
};

test("checkout sells seats for a team; the webhook makes it paid; the portal manages it", async () => {
  const owner = await signIn("olga");
  teamId = Number((await req("/api/teams", { method: "POST", cookie: owner, body: { name: "Acme" } })).json.id);
  assert.equal((await req(`/api/teams/${teamId}/invites`, { method: "POST", cookie: owner })).status, 402, "free team: one person");

  const co = await req("/api/billing/checkout", { method: "POST", cookie: owner, body: { team_id: teamId, interval: "year" } });
  assert.equal(co.status, 200);
  assert.equal(co.json.url, "https://checkout.stripe.test/cs_1");
  const made = calls.find((c) => c.path === "/v1/checkout/sessions").params;
  assert.equal(made.get("mode"), "subscription");
  assert.equal(made.get("line_items[0][price]"), "price_snout_team_yearly");
  assert.equal(made.get("line_items[0][adjustable_quantity][enabled]"), "true");
  assert.equal(made.get("client_reference_id"), String(teamId));

  assert.equal((await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", client_reference_id: String(teamId) } } })).status, 200);
  const m = (await req(`/api/teams/${teamId}/members`, { cookie: owner })).json;
  assert.deepEqual([m.plan, m.seats, m.billingStatus, m.billed], ["team", 3, "active", true]);

  const p = await req("/api/billing/portal", { method: "POST", cookie: owner, body: { team_id: teamId } });
  assert.equal(p.json.url, "https://billing.stripe.test/p_1");
});

test("seats cap invites; buying more lifts it; cancelling returns the team to free", async () => {
  const owner = await signIn("olga");
  const joinAs = async (login) => {
    const inv = await req(`/api/teams/${teamId}/invites`, { method: "POST", cookie: owner });
    if (inv.status !== 200) return inv.status;
    return (await req(new URL(inv.json.url).pathname, { cookie: await signIn(login) })).status;
  };
  assert.equal(await joinAs("pat"), 302);
  assert.equal(await joinAs("quinn"), 302);
  assert.equal(await joinAs("ray"), 402, "3 of 3 seats used");

  await webhook({ type: "customer.subscription.updated", data: { object: sub({ quantity: 5 }) } });
  assert.equal(await joinAs("ray"), 302, "more seats, more room");

  await webhook({ type: "customer.subscription.deleted", data: { object: sub({ status: "canceled" }) } });
  const m = (await req(`/api/teams/${teamId}/members`, { cookie: owner })).json;
  assert.deepEqual([m.plan, m.billingStatus], ["free", "canceled"]);
});

test("the webhook rejects forged, stale and unsigned events", async () => {
  const ev = { type: "customer.subscription.updated", data: { object: sub({ quantity: 99 }) } };
  assert.equal((await webhook(ev, "whsec_wrong")).status, 400);
  assert.equal((await webhook(ev, WHSEC, Math.floor(Date.now() / 1000) - 600)).status, 400, "older than five minutes");
  assert.equal((await req("/api/stripe/webhook", { method: "POST", raw: JSON.stringify(ev) })).status, 400);
  const m = (await req(`/api/teams/${teamId}/members`, { cookie: await signIn("olga") })).json;
  assert.notEqual(m.seats, 99);
});

test("owners manage members: roles, removal (which revokes their logins), and leaving", async () => {
  const owner = await signIn("olga");
  const pat = await signIn("pat");
  const list = async () => (await req(`/api/teams/${teamId}/members`, { cookie: owner })).json.members;
  const idOf = async (login) => (await list()).find((x) => x.login === login).id;

  assert.equal((await req(`/api/teams/${teamId}/members/${await idOf("quinn")}/remove`, { method: "POST", cookie: pat })).status, 403, "members can't remove");
  assert.equal((await req(`/api/billing/checkout`, { method: "POST", cookie: pat, body: { team_id: teamId } })).status, 403, "members can't buy");

  // Pat has a CLI login for the team; removing Pat revokes it.
  const start = await req("/api/device/start", { method: "POST", body: {} });
  await req("/api/device/approve", { method: "POST", cookie: pat, body: { user_code: start.json.user_code, team_id: teamId } });
  const tok = (await req("/api/device/poll", { method: "POST", body: { device_code: start.json.device_code } })).json.token;
  assert.equal((await req(`/api/teams/${teamId}/members/${await idOf("pat")}/remove`, { method: "POST", cookie: owner })).status, 200);
  assert.ok(!(await list()).some((x) => x.login === "pat"));
  const ingest = await fetch(base + "/api/ingest", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ v: 1, project: { key: "abcdef012345", name: "x" }, days: [] }) });
  assert.equal(ingest.status, 401, "a removed member's machine can't sync into the team");

  const olgaId = await idOf("olga");
  assert.equal((await req(`/api/teams/${teamId}/members/${olgaId}/role`, { method: "POST", cookie: owner, body: { role: "member" } })).status, 400, "the last owner stays an owner");
  assert.equal((await req(`/api/teams/${teamId}/leave`, { method: "POST", cookie: owner })).status, 400, "the last owner can't just leave");
  assert.equal((await req(`/api/teams/${teamId}/members/${await idOf("quinn")}/role`, { method: "POST", cookie: owner, body: { role: "owner" } })).status, 200);
  assert.equal((await req(`/api/teams/${teamId}/leave`, { method: "POST", cookie: owner })).status, 200, "with another owner, leaving works");
});
