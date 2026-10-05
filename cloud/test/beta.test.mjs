import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.mjs";
import { createApp } from "../src/app.mjs";

let server, base, db;

before(async () => {
  db = await openDb("");
  let handle;
  server = createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`; // publicUrl must be the real origin for same-origin checks
  handle = createApp({ db, config: { sessionSecret: "t", devLogin: true, beta: true, admins: ["Boss"], betaAllow: ["Vip"], earlyAccess: true, publicUrl: base } });
});
after(async () => {
  server.close();
  await db.close();
});

async function req(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: base } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const signIn = async (login) => (await req(`/auth/dev?login=${login}`)).headers.get("set-cookie").split(";")[0];
const makeCodes = async (count, note) => (await req("/api/admin/beta-codes", { method: "POST", cookie: await signIn("boss"), body: { count, note } })).json;

test("beta: the free personal workspace is open to everyone; starting a team needs a code", async () => {
  const c = await signIn("stranger");
  const me = await req("/api/me", { cookie: c });
  assert.deepEqual([me.json.beta, me.json.user.approved, me.json.teams.length], [true, false, 1]);
  const personal = me.json.teams[0];
  assert.equal((await req(`/api/usage?team=${personal.id}`, { cookie: c })).status, 200);
  const start = await req("/api/device/start", { method: "POST", body: {} });
  assert.equal((await req("/api/device/approve", { method: "POST", cookie: c, body: { user_code: start.json.user_code, team_id: personal.id } })).status, 200, "CLI login to the free workspace works");
  const team = await req("/api/teams", { method: "POST", cookie: c, body: { name: "Nope" } });
  assert.equal(team.status, 403);
  assert.equal(team.json.beta, true);
});

test("codes are random, per person, single-use, and only admins can make them", async () => {
  const out = await makeCodes(3, "Acme");
  assert.equal(out.codes.length, 3);
  for (const c of out.codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(new Set(out.codes).size, 3);

  const a = await signIn("alice");
  // typed loosely: lowercase, no dashes
  assert.equal((await req("/api/beta/redeem", { method: "POST", cookie: a, body: { code: out.codes[0].toLowerCase().replace(/-/g, "") } })).status, 200);
  assert.equal((await req("/api/me", { cookie: a })).json.user.approved, true);
  assert.equal((await req("/api/teams", { method: "POST", cookie: a, body: { name: "Alice co" } })).status, 200, "a code unlocks teams");

  const b = await signIn("bob");
  const reuse = await req("/api/beta/redeem", { method: "POST", cookie: b, body: { code: out.codes[0] } });
  assert.equal(reuse.status, 400, "a code works once");
  assert.equal((await req("/api/beta/redeem", { method: "POST", cookie: b, body: { code: out.codes[1] } })).status, 200);

  const list = (await req("/api/admin/beta-codes", { cookie: await signIn("boss") })).json.codes;
  assert.deepEqual(list.filter((c) => c.note === "Acme").map((c) => c.redeemedBy).sort(), ["alice", "bob", null].sort());
  assert.ok(list.every((c) => c.hint.length === 4 && !("code" in c)), "the list never shows full codes");

  assert.equal((await req("/api/admin/beta-codes", { method: "POST", cookie: a, body: { count: 1 } })).status, 404, "non-admins can't make codes");
});

test("expired codes fail, and guessing is rate limited", async () => {
  const out = await makeCodes(1, "old");
  await db.query("update beta_codes set expires_at = now() - interval '1 day' where note = 'old'");
  const c = await signIn("late");
  assert.equal((await req("/api/beta/redeem", { method: "POST", cookie: c, body: { code: out.codes[0] } })).status, 400);

  const g = await signIn("guesser");
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await req("/api/beta/redeem", { method: "POST", cookie: g, body: { code: "AAAA-BBB" + i } })).status);
  assert.deepEqual(tries, [400, 400, 400, 400, 400, 429]);
});

test("the allowlist and a team invite from an approved member both let people in", async () => {
  assert.equal((await req("/api/me", { cookie: await signIn("vip") })).json.user.approved, true, "GitHub login on BETA_ALLOW");
  const lead = await signIn("boss"); // admins are always approved
  const team = await req("/api/teams", { method: "POST", cookie: lead, body: { name: "Beta team" } });
  const inv = await req(`/api/teams/${team.json.id}/invites`, { method: "POST", cookie: lead });
  assert.equal(inv.status, 200);
  const mate = await signIn("mate");
  assert.equal((await req("/api/me", { cookie: mate })).json.user.approved, false);
  await req(new URL(inv.json.url).pathname, { cookie: mate });
  const after = await req("/api/me", { cookie: mate });
  assert.equal(after.json.user.approved, true);
  assert.ok(after.json.teams.some((t) => t.name === "Beta team"));
});
