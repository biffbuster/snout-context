/**
 * Snout Cloud's HTTP surface. No framework: a handful of routes over node:http.
 *
 *   Browser (cookie session):  /, /device, /auth/*, /invite/:token, /api/me, /api/usage,
 *                              /api/tokens, /api/teams, /api/device/approve
 *   CLI (no auth → bearer):    /api/device/start, /api/device/poll, /api/ingest
 *
 * What is stored is what `snout sync` sends: per-day totals by project, coding agent and
 * label. The service never receives file contents, paths or reasons.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const PAGES = {
  app: readFileSync(new URL("../public/app.html", import.meta.url), "utf8"),
  device: readFileSync(new URL("../public/device.html", import.meta.url), "utf8"),
};

const SESSION_DAYS = 30;
const DEVICE_MINUTES = 10;
const INVITE_DAYS = 7;
const MAX_BODY = 512 * 1024;
const MAX_DAY_ROWS = 2000;

/**
 * What each plan includes. The local tool is free and unlimited everywhere; these caps apply
 * only to the hosted dashboard. Free history is capped in what is SHOWN, not what is kept,
 * so upgrading reveals the full history at once.
 */
export const PLANS = {
  // Free covers everyone, small teams included: what it stores is a few rows per person per day.
  // Team is for large teams that want more people, a year of history and unmetered keys.
  free: { members: 10, projects: 1000, historyDays: 90, agentKeys: 3, agentRunsPerDay: 500, agentRunsIncluded: 0 },
  team: { members: 1000, projects: 1000, historyDays: 365, agentKeys: 100, agentRunsPerDay: Infinity, agentRunsIncluded: 5000 },
};
const planOf = (t) => PLANS[t?.plan] ?? PLANS.free;

/** MCP servers sync as labels "mcp-<server>": one "mcp" bucket in the label mix, and a per-server list. */
function splitMcp(rows) {
  const byLabel = [];
  const byMcp = [];
  let mcp = null;
  for (const r of rows) {
    if (!String(r.key).startsWith("mcp-") || r.key === "mcp-output") { byLabel.push(r); continue; }
    byMcp.push({ ...r, key: r.key.slice(4) });
    mcp ??= { key: "mcp", reads: 0, inContext: 0, heldBack: 0, couldHoldBack: 0 };
    for (const k of ["reads", "inContext", "heldBack", "couldHoldBack"]) if (typeof r[k] === "number") mcp[k] += r[k];
  }
  if (mcp) byLabel.push(mcp);
  byLabel.sort((a, b) => b.heldBack - a.heldBack || b.inContext - a.inContext);
  return { byLabel, byMcp };
}
const MODEL = /^[a-z0-9][a-z0-9.:_-]{0,63}$/;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const secret = (prefix) => prefix + b64u(randomBytes(32));
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
/**
 * Crockford-style base32 without look-alikes (no I, L, O, U): 8 chars = 40 bits, about 10^12.
 * With 5 tries per user and 20 per address every 10 minutes, even a thousand addresses would
 * need years to hit one of a hundred live codes.
 */
const BETA_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BETA_DAYS = 30;
const betaCode = () => {
  const s = [...randomBytes(8)].map((x) => BETA_ALPHABET[x & 31]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
};
/** What a person typed, reduced to the code: case, spaces and dashes don't matter. */
const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 32);
const userCode = () => {
  const b = randomBytes(8);
  const s = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function createApp({ db, config }) {
  const cfg = {
    publicUrl: (config.publicUrl || "http://localhost:8787").replace(/\/+$/, ""),
    sessionSecret: config.sessionSecret || b64u(randomBytes(32)),
    githubClientId: config.githubClientId || "",
    githubClientSecret: config.githubClientSecret || "",
    devLogin: !!config.devLogin,
    fetch: config.fetch || fetch,
    /** Stripe: the secret key enables billing; the webhook secret verifies Stripe's events. */
    stripeKey: config.stripeKey || "",
    stripeWebhookSecret: config.stripeWebhookSecret || "",
    stripeFetch: config.stripeFetch || config.fetch || fetch,
    trustProxy: !!config.trustProxy,
    ipPerMinute: Number(config.ipPerMinute) || 600,
    /** Until billing is live, new teams can start on the team plan (EARLY_ACCESS=1). */
    earlyAccess: !!config.earlyAccess,
    /** Where "Upgrade" goes: a Stripe payment link now, Checkout later. */
    upgradeUrl: config.upgradeUrl || "",
    /**
     * Private beta for teams: with `beta` on, anyone can use their free personal workspace,
     * but starting a team needs approval — an access code, the allowlist, or being an admin.
     * Accepting a team invite needs nothing.
     */
    beta: !!config.beta,
    betaAllow: new Set((config.betaAllow || []).map((l) => l.toLowerCase())),
    /** GitHub logins that can create beta codes. Admins are always approved. */
    admins: new Set((config.admins || []).map((l) => l.toLowerCase())),
  };
  const origin = new URL(cfg.publicUrl).origin;
  const secure = cfg.publicUrl.startsWith("https://");
  const limits = new Map();

  // --- plumbing -----------------------------------------------------------------------

  /** The client's address; behind a trusted proxy, the first hop it recorded. */
  const clientIp = (req) => (cfg.trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;

  function limit(key, max, windowMs) {
    const now = Date.now();
    const l = limits.get(key);
    if (!l || l.reset < now) {
      limits.set(key, { n: 1, reset: now + windowMs });
      if (limits.size > 50_000) for (const [k, v] of limits) if (v.reset < now) limits.delete(k);
      return;
    }
    if (++l.n > max) throw new HttpError(429, "too many requests");
  }

  const cookies = (req) =>
    Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));

  function cookie(name, value, maxAgeSec) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
  }

  const sign = (payload) => createHmac("sha256", cfg.sessionSecret).update(payload).digest("base64url");

  function sessionCookie(userId) {
    const payload = b64u(JSON.stringify({ u: userId, e: Date.now() + SESSION_DAYS * 86_400_000 }));
    return cookie("snout_session", `${payload}.${sign(payload)}`, SESSION_DAYS * 86_400);
  }

  function sessionUser(req) {
    const raw = cookies(req).snout_session;
    if (!raw) return null;
    const [payload, mac] = raw.split(".");
    if (!payload || !mac) return null;
    const want = Buffer.from(sign(payload));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
      return e > Date.now() ? Number(u) : null;
    } catch {
      return null;
    }
  }

  async function me(req) {
    const id = sessionUser(req);
    if (!id) throw new HttpError(401, "sign in");
    const [u] = await db.query("select id, login, name, avatar, approved_at from users where id = $1", [id]);
    if (!u) throw new HttpError(401, "sign in");
    u.admin = cfg.admins.has(u.login.toLowerCase());
    u.approved = !cfg.beta || u.admin || !!u.approved_at || cfg.betaAllow.has(u.login.toLowerCase());
    delete u.approved_at;
    return u;
  }

  const approve = (userId) => db.query("update users set approved_at = coalesce(approved_at, now()) where id = $1", [userId]);

  /**
   * One code, one person: codes are random (40 bits), single-use, expire in BETA_DAYS, and
   * are stored only as hashes. Attempts are limited per user and per address, so guessing is
   * hopeless even before the entropy.
   */
  async function redeemBeta(req, res) {
    sameOrigin(req);
    const u = await me(req);
    limit(`beta:${u.id}`, 5, 10 * 60_000);
    limit(`beta-ip:${clientIp(req)}`, 20, 10 * 60_000);
    const code = normalizeCode((await body(req)).code);
    if (code.length !== 8) throw new HttpError(400, "That code isn't valid.");
    const used = await db.query(
      "update beta_codes set redeemed_by = $1, redeemed_at = now() where code_hash = $2 and redeemed_at is null and expires_at > now() returning note",
      [u.id, sha256(code)],
    );
    if (!used.length) throw new HttpError(400, "That code isn't valid, or it was already used.");
    await approve(u.id);
    json(res, 200, { ok: true });
  }

  function admin(u) {
    if (!u.admin) throw new HttpError(404, "not found");
  }

  async function createBetaCodes(req, res) {
    sameOrigin(req);
    const u = await me(req);
    admin(u);
    const b = await body(req);
    const n = Math.min(50, Math.max(1, Number(b.count) || 1));
    const note = String(b.note || "").slice(0, 120);
    const codes = Array.from({ length: n }, betaCode);
    for (const c of codes) {
      await db.query(`insert into beta_codes (code_hash, hint, note, created_by, expires_at) values ($1, $2, $3, $4, now() + interval '${BETA_DAYS} days')`, [sha256(normalizeCode(c)), c.slice(-4), note, u.id]);
    }
    // Shown once. Only hashes are kept.
    json(res, 200, { codes, expiresInDays: BETA_DAYS });
  }

  async function listBetaCodes(req, res) {
    const u = await me(req);
    admin(u);
    const rows = await db.query(
      `select c.hint, c.note, c.created_at as "createdAt", c.expires_at as "expiresAt", c.redeemed_at as "redeemedAt", r.login as "redeemedBy"
       from beta_codes c left join users r on r.id = c.redeemed_by order by c.created_at desc limit 200`,
    );
    json(res, 200, { codes: rows });
  }

  /** Cookie-authenticated writes must come from our own pages. SameSite=Lax is the first wall. */
  function sameOrigin(req) {
    if (req.headers.origin !== origin) throw new HttpError(403, "cross-origin request refused");
  }

  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, "body too large");
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      throw new HttpError(400, "invalid json");
    }
  }

  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(obj));
  };
  const redirect = (res, to, headers = {}) => {
    res.writeHead(302, { location: to, "cache-control": "no-store", ...headers });
    res.end();
  };
  const page = (res, name) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      // Browsers remember to use HTTPS for a year; only sent when the site is served over HTTPS.
      ...(secure ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(PAGES[name]);
  };
  /** Only same-site relative paths: `next` must never become an open redirect. */
  const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : "/");

  async function membership(userId, teamId) {
    const [m] = await db.query("select role from memberships where team_id = $1 and user_id = $2", [teamId, userId]);
    if (!m) throw new HttpError(404, "no such team");
    return m.role;
  }

  // --- accounts -----------------------------------------------------------------------

  /** Finds or creates the user, and gives a new one a personal team to sync into. */
  async function upsertUser({ githubId, login, name, avatar }) {
    return db.tx(async (q) => {
      const [u] = await q(
        `insert into users (github_id, login, name, avatar) values ($1, $2, $3, $4)
         on conflict (github_id) do update set login = excluded.login, name = excluded.name, avatar = excluded.avatar
         returning id, (xmax = 0) as created`,
        [githubId, login, name, avatar],
      );
      const [has] = await q("select 1 from memberships m join teams t on t.id = m.team_id where m.user_id = $1 and t.personal", [u.id]);
      if (!has) {
        const [t] = await q("insert into teams (name, personal) values ($1, true) returning id", [login]);
        await q("insert into memberships (team_id, user_id, role) values ($1, $2, 'owner')", [t.id, u.id]);
      }
      return Number(u.id);
    });
  }

  async function githubStart(req, res, url) {
    if (!cfg.githubClientId) throw new HttpError(503, "GitHub login is not configured (GITHUB_CLIENT_ID)");
    const state = b64u(randomBytes(16));
    const next = safeNext(url.searchParams.get("next"));
    const to = new URL("https://github.com/login/oauth/authorize");
    to.searchParams.set("client_id", cfg.githubClientId);
    to.searchParams.set("redirect_uri", `${cfg.publicUrl}/auth/github/callback`);
    to.searchParams.set("scope", "read:user");
    to.searchParams.set("state", state);
    redirect(res, to.toString(), { "set-cookie": cookie("snout_oauth", `${state}|${next}`, 600) });
  }

  async function githubCallback(req, res, url) {
    const [state, next] = (cookies(req).snout_oauth || "").split("|");
    if (!state || state !== url.searchParams.get("state")) throw new HttpError(400, "login expired; try again");
    const tokenRes = await cfg.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: cfg.githubClientId, client_secret: cfg.githubClientSecret, code: url.searchParams.get("code"), redirect_uri: `${cfg.publicUrl}/auth/github/callback` }),
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new HttpError(400, "GitHub refused the login");
    const gh = await (await cfg.fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${access_token}`, "user-agent": "snout-cloud", accept: "application/vnd.github+json" } })).json();
    if (!gh || typeof gh.id !== "number") throw new HttpError(400, "GitHub returned no user");
    const id = await upsertUser({ githubId: gh.id, login: String(gh.login).slice(0, 64), name: gh.name ? String(gh.name).slice(0, 120) : null, avatar: typeof gh.avatar_url === "string" ? gh.avatar_url : null });
    redirect(res, safeNext(next), { "set-cookie": [sessionCookie(id), cookie("snout_oauth", "", 0)] });
  }

  async function devLogin(req, res, url) {
    if (!cfg.devLogin) throw new HttpError(404, "not found");
    const login = (url.searchParams.get("login") || "dev").replace(/[^a-z0-9-]/gi, "").slice(0, 32) || "dev";
    // A stable negative id keeps dev users apart from real GitHub ids.
    const githubId = -parseInt(sha256(login).slice(0, 12), 16);
    const id = await upsertUser({ githubId, login, name: login, avatar: null });
    redirect(res, safeNext(url.searchParams.get("next")), { "set-cookie": sessionCookie(id) });
  }

  // --- CLI login (device flow) --------------------------------------------------------

  async function deviceStart(req, res) {
    limit(`ds:${clientIp(req)}`, 20, 60_000);
    const device = secret("dev_");
    const code = userCode();
    await db.query("delete from device_codes where expires_at < now()");
    await db.query(`insert into device_codes (device_hash, user_code, expires_at) values ($1, $2, now() + interval '${DEVICE_MINUTES} minutes')`, [sha256(device), code]);
    json(res, 200, { device_code: device, user_code: code, verify_url: `${cfg.publicUrl}/device?code=${code}`, interval: 3, expires_in: DEVICE_MINUTES * 60 });
  }

  async function devicePoll(req, res) {
    limit(`dp:${clientIp(req)}`, 120, 60_000);
    const { device_code } = await body(req);
    if (typeof device_code !== "string") throw new HttpError(400, "device_code required");
    const out = await db.tx(async (q) => {
      const [d] = await q("select * from device_codes where device_hash = $1 for update", [sha256(device_code)]);
      if (!d) return [404, { error: "unknown code" }];
      if (new Date(d.expires_at) < new Date() || d.status === "used") return [410, { error: "expired" }];
      if (d.status !== "approved") return [428, { error: "pending" }];
      const token = secret("snt_");
      await q("insert into tokens (user_id, team_id, hash, label) values ($1, $2, $3, $4)", [d.user_id, d.team_id, sha256(token), `CLI, ${new Date().toISOString().slice(0, 10)}`]);
      await q("update device_codes set status = 'used' where device_hash = $1", [d.device_hash]);
      const [u] = await q("select login from users where id = $1", [d.user_id]);
      const [t] = await q("select name from teams where id = $1", [d.team_id]);
      return [200, { token, user: u.login, team: t.name }];
    });
    json(res, out[0], out[1]);
  }

  async function deviceApprove(req, res) {
    sameOrigin(req);
    const u = await me(req);
    const { user_code, team_id } = await body(req);
    await membership(u.id, team_id);
    const rows = await db.query(
      "update device_codes set status = 'approved', user_id = $1, team_id = $2 where user_code = $3 and status = 'pending' and expires_at > now() returning user_code",
      [u.id, team_id, String(user_code || "").toUpperCase()],
    );
    if (!rows.length) throw new HttpError(410, "That code expired or was already used. Run `snout login` again.");
    json(res, 200, { ok: true });
  }

  // --- ingest -------------------------------------------------------------------------

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const SLUG = /^[a-z0-9-]{1,32}$/;
  const count = (n) => Number.isSafeInteger(n) && n >= 0 && n < 1e13;

  function validate(p) {
    if (!p || p.v !== 1) throw new HttpError(400, "unsupported payload version");
    if (!p.project || !/^[a-f0-9]{8,64}$/.test(p.project.key || "")) throw new HttpError(400, "project.key must be a hex id");
    const name = String(p.project.name || "project").slice(0, 80);
    if (!Array.isArray(p.days) || p.days.length > MAX_DAY_ROWS) throw new HttpError(400, `days must be an array of at most ${MAX_DAY_ROWS}`);
    for (const d of p.days) {
      if (!d || !DAY.test(d.day) || !SLUG.test(d.client) || !SLUG.test(d.label)) throw new HttpError(400, "bad day row");
      if (d.model === undefined || d.model === null) d.model = "";
      if (d.model !== "" && !MODEL.test(d.model)) throw new HttpError(400, "bad day model");
      for (const k of ["reads", "gated", "inContext", "heldBack", "couldHoldBack"]) if (!count(d[k])) throw new HttpError(400, `bad ${k}`);
    }
    const spend = p.spend ?? [];
    if (!Array.isArray(spend) || spend.length > MAX_DAY_ROWS) throw new HttpError(400, `spend must be an array of at most ${MAX_DAY_ROWS}`);
    for (const r of spend) {
      if (!r || !DAY.test(r.day) || !SLUG.test(r.client) || !MODEL.test(r.model)) throw new HttpError(400, "bad spend row");
      for (const k of ["requests", "input", "cacheWrite", "cacheRead", "output"]) if (!count(r[k])) throw new HttpError(400, `bad spend ${k}`);
      if (r.costUsd !== null && !(typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0 && r.costUsd < 1e9)) throw new HttpError(400, "bad costUsd");
    }
    const run = typeof p.run === "string" && /^[a-f0-9]{16,64}$/.test(p.run) ? p.run : null;
    return { key: p.project.key, name, days: p.days, spend, run };
  }

  async function ingest(req, res) {
    const auth = req.headers.authorization || "";
    const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const [tok] = raw ? await db.query("select id, user_id, team_id, kind from tokens where hash = $1 and revoked_at is null", [sha256(raw)]) : [];
    if (!tok) throw new HttpError(401, "invalid token");
    limit(`in:${tok.id}`, 60, 60_000);
    const p = validate(await body(req));
    if (tok.kind === "workspace") await meterRun(tok, p.run);
    await db.tx(async (q) => {
      // Free plan: a fourth project is refused; the three it has keep syncing.
      const [team] = await q("select plan from teams where id = $1", [tok.team_id]);
      const cap = planOf(team).projects;
      const [known] = await q("select 1 from projects where team_id = $1 and key = $2", [tok.team_id, p.key]);
      if (!known) {
        const [{ n }] = await q("select count(*)::int as n from projects where team_id = $1", [tok.team_id]);
        if (n >= cap) throw capError("projects", `The free plan syncs ${cap} projects. Upgrade to Team to add ${p.name}.`);
      }
      const [proj] = await q(
        "insert into projects (team_id, key, name) values ($1, $2, $3) on conflict (team_id, key) do update set name = excluded.name returning id",
        [tok.team_id, p.key, p.name],
      );
      // Totals replace: a resent day overwrites itself, and a label that vanished is dropped.
      const days = [...new Set(p.days.map((d) => d.day))];
      if (days.length) await q("delete from usage_daily where team_id = $1 and project_id = $2 and user_id = $3 and day = any($4::date[])", [tok.team_id, proj.id, tok.user_id, days]);
      for (let i = 0; i < p.days.length; i += 500) {
        const chunk = p.days.slice(i, i + 500);
        const params = [];
        const values = chunk.map((d, j) => {
          params.push(tok.team_id, proj.id, tok.user_id, d.day, d.client, d.label, d.model, d.reads, d.gated, d.inContext, d.heldBack, d.couldHoldBack);
          const b = j * 12;
          return `(${Array.from({ length: 12 }, (_, k) => `$${b + k + 1}`).join(",")})`;
        });
        await q(`insert into usage_daily (team_id, project_id, user_id, day, client, label, model, reads, gated, in_context, held_back, could_hold_back) values ${values.join(",")}`, params);
      }
      const spendDays = [...new Set(p.spend.map((r) => r.day))];
      if (spendDays.length) await q("delete from spend_daily where team_id = $1 and project_id = $2 and user_id = $3 and day = any($4::date[])", [tok.team_id, proj.id, tok.user_id, spendDays]);
      for (let i = 0; i < p.spend.length; i += 500) {
        const chunk = p.spend.slice(i, i + 500);
        const params = [];
        const values = chunk.map((r, j) => {
          params.push(tok.team_id, proj.id, tok.user_id, r.day, r.client, r.model, r.requests, r.input, r.cacheWrite, r.cacheRead, r.output, r.costUsd);
          const b = j * 12;
          return `(${Array.from({ length: 12 }, (_, k) => `$${b + k + 1}`).join(",")})`;
        });
        await q(`insert into spend_daily (team_id, project_id, user_id, day, client, model, requests, input, cache_write, cache_read, output, cost_usd) values ${values.join(",")}`, params);
      }
      await q("update tokens set last_used_at = now() where id = $1", [tok.id]);
    });
    json(res, 200, { accepted: p.days.length, spend: p.spend.length });
  }

  function capError(cap, message) {
    return new HttpError(402, message, { cap, upgrade: cfg.upgradeUrl || `${cfg.publicUrl}/?upgrade=1` });
  }

  // --- dashboard API ------------------------------------------------------------------

  async function apiMe(req, res) {
    const u = await me(req);
    const teams = await db.query(
      `select t.id, t.name, t.personal, t.plan, m.role, (select count(*)::int from memberships x where x.team_id = t.id) as members
       from teams t join memberships m on m.team_id = t.id where m.user_id = $1 order by t.personal desc, t.name`,
      [u.id],
    );
    for (const t of teams) t.limits = planOf(t);
    json(res, 200, { user: u, teams, beta: cfg.beta, upgradeUrl: cfg.upgradeUrl || null, cliCommand: "npx usesnout login" });
  }

  async function apiUsage(req, res, url) {
    const u = await me(req);
    const team = Number(url.searchParams.get("team"));
    await membership(u.id, team);
    const [teamRow] = await db.query("select plan from teams where id = $1", [team]);
    const limits = planOf(teamRow);
    const asked = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const days = Math.min(asked, limits.historyDays);
    const where = ["d.team_id = $1", "d.day > (now() at time zone 'utc')::date - $2::int"];
    const params = [team, days];
    const project = url.searchParams.get("project");
    const client = url.searchParams.get("client");
    if (project) where.push(`d.project_id = $${params.push(Number(project))}`);
    if (client) where.push(`d.client = $${params.push(client)}`);
    const w = where.join(" and ");
    const sums = "sum(d.reads)::float8 as reads, sum(d.gated)::float8 as gated, sum(d.in_context)::float8 as \"inContext\", sum(d.held_back)::float8 as \"heldBack\", sum(d.could_hold_back)::float8 as \"couldHoldBack\"";
    const sw = w.replace(/\bd\./g, "s.");
    const ssum = "sum(s.requests)::float8 as requests, sum(s.input + s.cache_write + s.cache_read + s.output)::float8 as tokens, sum(s.cache_read)::float8 as \"cacheRead\", coalesce(sum(s.cost_usd), 0)::float8 as \"costUsd\"";
    const [spendTotals, spendSeries, spendByModel, spendByProject, spendByMember, unpriced] = await Promise.all([
      db.query(`select ${ssum} from spend_daily s where ${sw}`, params),
      db.query(`select to_char(s.day, 'YYYY-MM-DD') as key, ${ssum} from spend_daily s where ${sw} group by s.day order by s.day`, params),
      db.query(`select s.model as key, ${ssum} from spend_daily s where ${sw} group by s.model order by 5 desc, 3 desc`, params),
      db.query(`select s.project_id::text as key, ${ssum} from spend_daily s where ${sw} group by s.project_id`, params),
      db.query(`select u.login as key, ${ssum} from spend_daily s join users u on u.id = s.user_id where ${sw} group by u.login`, params),
      db.query(`select distinct s.model from spend_daily s where ${sw} and s.cost_usd is null`, params),
    ]);
    const [totals, series, byProject, byClient, byLabel, byModelSaved, byMember, projects, clients] = await Promise.all([
      db.query(`select ${sums} from usage_daily d where ${w}`, params),
      db.query(`select to_char(d.day, 'YYYY-MM-DD') as key, ${sums} from usage_daily d where ${w} group by d.day order by d.day`, params),
      db.query(`select p.id::text as key, p.name, ${sums} from usage_daily d join projects p on p.id = d.project_id where ${w} group by p.id, p.name order by 6 desc, 5 desc`, params),
      db.query(`select d.client as key, ${sums} from usage_daily d where ${w} group by d.client order by 5 desc, 4 desc`, params),
      db.query(`select d.label as key, ${sums} from usage_daily d where ${w} group by d.label order by 5 desc, 4 desc`, params),
      db.query(`select case when d.model = '' then 'unknown' else d.model end as key, ${sums} from usage_daily d where ${w} group by 1 order by 5 desc, 4 desc`, params),
      db.query(`select u.login as key, u.avatar, ${sums} from usage_daily d join users u on u.id = d.user_id where ${w} group by u.login, u.avatar order by 7 desc, 6 desc`, params),
      db.query("select id::text as id, name from projects where team_id = $1 order by name", [team]),
      db.query("select distinct client from usage_daily where team_id = $1 order by client", [team]),
    ]);
    // Live view: today, per-model spend with today and 7-day figures, and who synced most recently.
    const recent = `${w} and d.day >= (now() at time zone 'utc')::date - 1`;
    const [today, spendToday, modelRows, activity, [last]] = await Promise.all([
      db.query(`select ${sums} from usage_daily d where ${w} and d.day = (now() at time zone 'utc')::date`, params),
      db.query(`select ${ssum} from spend_daily s where ${sw} and s.day = (now() at time zone 'utc')::date`, params),
      db.query(`select s.model as key, s.client, sum(s.requests)::float8 as requests, sum(s.input + s.cache_write + s.cache_read + s.output)::float8 as tokens,
          sum(s.input + s.cache_write + s.cache_read)::float8 as input, sum(s.output)::float8 as output, coalesce(sum(s.cost_usd), 0)::float8 as "costUsd",
          coalesce(sum(s.requests) filter (where s.day = (now() at time zone 'utc')::date), 0)::float8 as "todayRequests",
          coalesce(sum(s.input + s.cache_write + s.cache_read + s.output) filter (where s.day = (now() at time zone 'utc')::date), 0)::float8 as "todayTokens",
          coalesce(sum(s.cost_usd) filter (where s.day = (now() at time zone 'utc')::date), 0)::float8 as "todayCost",
          coalesce(sum(s.cost_usd) filter (where s.day > (now() at time zone 'utc')::date - 7), 0)::float8 as "weekCost"
        from spend_daily s where ${sw} group by s.model, s.client`, params),
      db.query(`select u.login, u.avatar, u.is_agent as agent, p.name as project, d.client, max(d.updated_at) as at,
          coalesce(sum(d.reads) filter (where d.day = (now() at time zone 'utc')::date), 0)::float8 as reads,
          coalesce(sum(d.in_context) filter (where d.day = (now() at time zone 'utc')::date), 0)::float8 as "inContext",
          coalesce(sum(d.held_back) filter (where d.day = (now() at time zone 'utc')::date), 0)::float8 as "heldBack"
        from usage_daily d join users u on u.id = d.user_id join projects p on p.id = d.project_id
        where ${recent} group by u.login, u.avatar, u.is_agent, p.name, d.client order by at desc limit 12`, params),
      db.query(`select max(d.updated_at) as at from usage_daily d where ${recent}`, params),
    ]);
    const models = new Map();
    for (const r of modelRows) {
      const m = models.get(r.key) ?? { key: r.key, client: r.client, top: 0, requests: 0, tokens: 0, input: 0, output: 0, costUsd: 0, today: { requests: 0, tokens: 0, costUsd: 0 }, weekCostUsd: 0 };
      if (r.requests > m.top) { m.top = r.requests; m.client = r.client; }
      for (const k of ["requests", "tokens", "input", "output", "costUsd"]) m[k] += r[k];
      m.today.requests += r.todayRequests; m.today.tokens += r.todayTokens; m.today.costUsd += r.todayCost; m.weekCostUsd += r.weekCost;
      models.set(r.key, m);
    }
    const spendModels = [...models.values()].map(({ top, ...m }) => m).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
    const tday = today[0] || {};
    for (const k of ["reads", "gated", "inContext", "heldBack", "couldHoldBack"]) tday[k] = tday[k] || 0;
    const sday = spendToday[0] || {};
    const t = totals[0] || {};
    for (const k of ["reads", "gated", "inContext", "heldBack", "couldHoldBack"]) t[k] = t[k] || 0;
    const st = spendTotals[0] || {};
    for (const k of ["requests", "tokens", "cacheRead", "costUsd"]) st[k] = st[k] || 0;
    const spendOf = (list, key) => Object.fromEntries(list.map((r) => [r.key, r]))[key] ?? null;
    for (const p of byProject) p.spend = spendOf(spendByProject, p.key);
    for (const m of byMember) m.spend = spendOf(spendByMember, m.key);
    json(res, 200, {
      days, plan: teamRow?.plan ?? "free", limits, capped: asked > days ? { historyDays: limits.historyDays } : null,
      totals: t, series, byProject, byClient, ...splitMcp(byLabel), byModel: byModelSaved, byMember, projects, clients: clients.map((c) => c.client),
      spend: { ...st, series: spendSeries, byModel: spendModels.length ? spendModels : spendByModel, unpriced: unpriced.map((u) => u.model), today: { requests: sday.requests || 0, tokens: sday.tokens || 0, costUsd: sday.costUsd || 0 } },
      today: tday, activity, lastSyncAt: last?.at ?? null, now: new Date().toISOString(),
    });
  }

  async function apiTokens(req, res) {
    const u = await me(req);
    const rows = await db.query(
      `select k.id::text as id, k.label, t.name as team, k.created_at as "createdAt", k.last_used_at as "lastUsedAt"
       from tokens k join teams t on t.id = k.team_id where k.user_id = $1 and k.kind = 'cli' and k.revoked_at is null order by k.created_at desc`,
      [u.id],
    );
    json(res, 200, { tokens: rows });
  }

  async function revokeToken(req, res, id) {
    sameOrigin(req);
    const u = await me(req);
    const rows = await db.query("update tokens set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null returning id", [Number(id), u.id]);
    if (!rows.length) throw new HttpError(404, "no such token");
    json(res, 200, { ok: true });
  }

  async function createTeam(req, res) {
    sameOrigin(req);
    const u = await me(req);
    // The free personal workspace is open to everyone. During the beta, starting a team takes
    // a personal access code (joining one by invite does not).
    if (!u.approved) throw new HttpError(403, "Teams are invite-only during the beta. Enter your access code to start one.", { beta: true });
    const name = String((await body(req)).name || "").trim().slice(0, 60);
    if (!name) throw new HttpError(400, "name required");
    const id = await db.tx(async (q) => {
      // A new team starts free (one member) until it upgrades; during early access, on the team plan.
      const [t] = await q("insert into teams (name, plan) values ($1, $2) returning id", [name, cfg.earlyAccess ? "team" : "free"]);
      await q("insert into memberships (team_id, user_id, role) values ($1, $2, 'owner')", [t.id, u.id]);
      return t.id;
    });
    json(res, 200, { id: String(id) });
  }

  async function createInvite(req, res, teamId) {
    sameOrigin(req);
    const u = await me(req);
    if ((await membership(u.id, Number(teamId))) !== "owner") throw new HttpError(403, "only an owner can invite");
    const [t] = await db.query("select personal, plan, seats, (select count(*)::int from memberships m where m.team_id = teams.id) as members from teams where id = $1", [Number(teamId)]);
    if (t.personal) throw new HttpError(400, "a personal workspace has no members; create a team");
    seatCheck(t);
    const token = secret("inv_");
    await db.query(`insert into invites (token_hash, team_id, created_by, expires_at) values ($1, $2, $3, now() + interval '${INVITE_DAYS} days')`, [sha256(token), Number(teamId), u.id]);
    json(res, 200, { url: `${cfg.publicUrl}/invite/${token}`, expiresInDays: INVITE_DAYS });
  }

  async function acceptInvite(req, res, token) {
    const id = sessionUser(req);
    if (!id) return redirect(res, `/?signin=1&next=${encodeURIComponent(`/invite/${token}`)}`);
    const [inv] = await db.query("select team_id from invites where token_hash = $1 and expires_at > now()", [sha256(token)]);
    if (!inv) throw new HttpError(410, "This invite expired. Ask for a new one.");
    const [t] = await db.query("select plan, seats, (select count(*)::int from memberships m where m.team_id = teams.id) as members, exists(select 1 from memberships m where m.team_id = teams.id and m.user_id = $2) as already from teams where id = $1", [inv.team_id, id]);
    if (!t.already) seatCheck(t, "This team is full. Ask its owner to add seats.");
    await db.query("insert into memberships (team_id, user_id) values ($1, $2) on conflict do nothing", [inv.team_id, id]);
    await approve(id); // invited by an approved member: that is the beta's front door
    redirect(res, `/?team=${inv.team_id}`);
  }

  /**
   * A team may add people while it has room: the free plan holds up to its member cap; a paid team holds its
   * purchased seats; an early-access team (team plan, no subscription) is unlimited.
   */
  function seatCheck(t, fullMessage) {
    if (t.plan !== "team") {
      if (t.members >= planOf(t).members) throw capError("members", fullMessage || `The free plan holds ${planOf(t).members} people. Larger teams need the Team plan.`);
      return;
    }
    if (t.seats && t.members >= t.seats) throw capError("seats", fullMessage || `All ${t.seats} seats are in use. Add seats in Billing to invite more people.`);
  }

  async function owner(req, teamId) {
    sameOrigin(req);
    const u = await me(req);
    if ((await membership(u.id, Number(teamId))) !== "owner") throw new HttpError(403, "only an owner can do that");
    return u;
  }

  // --- team management ----------------------------------------------------------------

  async function listMembers(req, res, teamId) {
    const u = await me(req);
    await membership(u.id, Number(teamId));
    const rows = await db.query(
      `select u.id::text as id, u.login, u.avatar, m.role, m.created_at as "joinedAt",
              (select max(k.last_used_at) from tokens k where k.user_id = u.id and k.team_id = m.team_id and k.revoked_at is null) as "lastSync"
       from memberships m join users u on u.id = m.user_id where m.team_id = $1 order by m.role desc, u.login`,
      [Number(teamId)],
    );
    const [t] = await db.query("select plan, seats, billing_status as \"billingStatus\", current_period_end as \"periodEnd\", stripe_customer_id is not null as billed from teams where id = $1", [Number(teamId)]);
    json(res, 200, { members: rows, me: String(u.id), plan: t.plan, seats: t.seats, billingStatus: t.billingStatus, periodEnd: t.periodEnd, billed: t.billed, billingEnabled: !!cfg.stripeKey });
  }

  /** Removing someone also revokes their CLI logins for this team, so their machines stop syncing into it. */
  async function removeMember(req, res, teamId, userId) {
    const u = await owner(req, teamId);
    if (String(u.id) === String(userId)) throw new HttpError(400, "to leave a team, use Leave team");
    await db.tx(async (q) => {
      const gone = await q("delete from memberships where team_id = $1 and user_id = $2 returning user_id", [Number(teamId), Number(userId)]);
      if (!gone.length) throw new HttpError(404, "not a member");
      await q("update tokens set revoked_at = now() where team_id = $1 and user_id = $2 and revoked_at is null", [Number(teamId), Number(userId)]);
    });
    json(res, 200, { ok: true });
  }

  async function setRole(req, res, teamId, userId) {
    await owner(req, teamId);
    const role = String((await body(req)).role || "");
    if (role !== "owner" && role !== "member") throw new HttpError(400, "role must be owner or member");
    await db.tx(async (q) => {
      const [m] = await q("select role from memberships where team_id = $1 and user_id = $2", [Number(teamId), Number(userId)]);
      if (!m) throw new HttpError(404, "not a member");
      if (m.role === "owner" && role === "member") {
        const [{ n }] = await q("select count(*)::int as n from memberships where team_id = $1 and role = 'owner'", [Number(teamId)]);
        if (n <= 1) throw new HttpError(400, "a team needs at least one owner");
      }
      await q("update memberships set role = $3 where team_id = $1 and user_id = $2", [Number(teamId), Number(userId), role]);
    });
    json(res, 200, { ok: true });
  }

  async function leaveTeam(req, res, teamId) {
    sameOrigin(req);
    const u = await me(req);
    const role = await membership(u.id, Number(teamId));
    const [t] = await db.query("select personal from teams where id = $1", [Number(teamId)]);
    if (t.personal) throw new HttpError(400, "you can't leave your personal workspace");
    await db.tx(async (q) => {
      if (role === "owner") {
        const [{ n }] = await q("select count(*)::int as n from memberships where team_id = $1 and role = 'owner'", [Number(teamId)]);
        if (n <= 1) throw new HttpError(400, "make someone else an owner before you leave");
      }
      await q("delete from memberships where team_id = $1 and user_id = $2", [Number(teamId), u.id]);
      await q("update tokens set revoked_at = now() where team_id = $1 and user_id = $2 and revoked_at is null", [Number(teamId), u.id]);
    });
    json(res, 200, { ok: true });
  }

  // --- cloud agents: workspace keys and run metering ------------------------------------

  /**
   * One run of a cloud agent (CI, Claude Code on the web, Codex cloud) is one session, however
   * many times it syncs: the CLI sends a hash of its session id, and a run counts once. Free
   * teams get agentRunsPerDay; paid teams report each new run to Stripe's meter, whose
   * graduated price includes the first 5,000 a month.
   */
  async function meterRun(tok, runHash) {
    const run = runHash || sha256(`${tok.id}:${Math.floor(Date.now() / 60_000)}`).slice(0, 32);
    const [t] = await db.query("select plan, stripe_customer_id from teams where id = $1", [tok.team_id]);
    const [seen] = await db.query("select 1 from agent_runs where team_id = $1 and run_hash = $2", [tok.team_id, run]);
    if (seen) return;
    const cap = planOf(t).agentRunsPerDay;
    if (Number.isFinite(cap)) {
      const [{ n }] = await db.query("select count(*)::int as n from agent_runs where team_id = $1 and day = (now() at time zone 'utc')::date", [tok.team_id]);
      if (n >= cap) throw capError("agent_runs", `The free plan meters ${cap} cloud-agent runs a day. Upgrade to Team for 5,000 a month included.`);
    }
    const added = await db.query("insert into agent_runs (team_id, token_id, run_hash) values ($1, $2, $3) on conflict do nothing returning run_hash", [tok.team_id, tok.id, run]);
    if (added.length && t.plan === "team" && t.stripe_customer_id && cfg.stripeKey) {
      // Stripe dedupes on `identifier`, so a retried sync never bills a run twice. Billing
      // hiccups never block a sync; they're logged and the run stays recorded here.
      stripe("POST", "billing/meter_events", { event_name: "snout_agent_run", identifier: `${tok.team_id}-${run}`, payload: { stripe_customer_id: t.stripe_customer_id, value: 1 } })
        .catch((err) => process.stderr.write(`${new Date().toISOString()} meter event failed: ${err.message}\n`));
    }
  }

  async function createKey(req, res, teamId) {
    const u = await owner(req, teamId);
    const label = String((await body(req)).label || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
    const [t] = await db.query("select plan from teams where id = $1", [Number(teamId)]);
    const [{ n }] = await db.query("select count(*)::int as n from tokens where team_id = $1 and kind = 'workspace' and revoked_at is null", [Number(teamId)]);
    if (n >= planOf(t).agentKeys) throw capError("agent_keys", `The free plan has ${planOf(t).agentKeys} cloud-agent key. Upgrade to Team for more.`);
    const key = secret("snt_");
    await db.tx(async (q) => {
      // Each key reports as its own "person", so the dashboard splits laptops from agents.
      const [agent] = await q("insert into users (login, name, is_agent) values ($1, $2, true) returning id", [`agent:${label}`, label]);
      await q("insert into tokens (user_id, team_id, hash, label, kind, created_by) values ($1, $2, $3, $4, 'workspace', $5)", [agent.id, Number(teamId), sha256(key), label, u.id]);
    });
    json(res, 200, { key, label, env: "SNOUT_TOKEN" });
  }

  async function listKeys(req, res, teamId) {
    const u = await me(req);
    await membership(u.id, Number(teamId));
    const keys = await db.query(
      `select k.id::text as id, k.label, k.created_at as "createdAt", k.last_used_at as "lastUsedAt",
              (select count(*)::int from agent_runs r where r.token_id = k.id and r.day >= date_trunc('month', (now() at time zone 'utc')::date)) as "runsThisMonth"
       from tokens k where k.team_id = $1 and k.kind = 'workspace' and k.revoked_at is null order by k.created_at`,
      [Number(teamId)],
    );
    const [t] = await db.query("select plan from teams where id = $1", [Number(teamId)]);
    const [{ month, today }] = await db.query(
      "select count(*) filter (where day >= date_trunc('month', (now() at time zone 'utc')::date))::int as month, count(*) filter (where day = (now() at time zone 'utc')::date)::int as today from agent_runs where team_id = $1",
      [Number(teamId)],
    );
    const l = planOf(t);
    json(res, 200, { keys, runsThisMonth: month, runsToday: today, included: l.agentRunsIncluded, perDay: Number.isFinite(l.agentRunsPerDay) ? l.agentRunsPerDay : null, maxKeys: l.agentKeys });
  }

  async function revokeKey(req, res, teamId, keyId) {
    await owner(req, teamId);
    const rows = await db.query("update tokens set revoked_at = now() where id = $1 and team_id = $2 and kind = 'workspace' and revoked_at is null returning id", [Number(keyId), Number(teamId)]);
    if (!rows.length) throw new HttpError(404, "no such key");
    json(res, 200, { ok: true });
  }

  // --- billing (Stripe) ----------------------------------------------------------------

  /** Stripe's form-encoded API, without an SDK: nested keys like line_items[0][price]. */
  async function stripe(method, path, params) {
    if (!cfg.stripeKey) throw new HttpError(503, "billing is not configured yet");
    const form = new URLSearchParams();
    const add = (prefix, v) => {
      if (v === undefined || v === null) return;
      if (typeof v === "object") for (const [k, x] of Object.entries(v)) add(prefix ? `${prefix}[${k}]` : k, x);
      else form.append(prefix, String(v));
    };
    add("", params || {});
    const url = `https://api.stripe.com/v1/${path}${method === "GET" && params ? `?${form}` : ""}`;
    const res = await cfg.stripeFetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.stripeKey}`, "content-type": "application/x-www-form-urlencoded", "stripe-version": "2024-06-20" },
      body: method === "GET" ? undefined : form.toString(),
    });
    const out = await res.json();
    if (!res.ok) throw new HttpError(502, `Stripe: ${out?.error?.message || res.status}`);
    return out;
  }

  const PRICE_KEYS = { month: "snout_team_monthly", year: "snout_team_yearly" };

  async function checkout(req, res) {
    const b = await body(req);
    const teamId = Number(b.team_id);
    const u = await owner(req, teamId);
    const [t] = await db.query("select personal, stripe_customer_id, (select count(*)::int from memberships m where m.team_id = teams.id) as members from teams where id = $1", [teamId]);
    if (t.personal) throw new HttpError(400, "create a team to subscribe; your personal workspace stays free");
    const interval = b.interval === "year" ? "year" : "month";
    const prices = await stripe("GET", "prices", { lookup_keys: [PRICE_KEYS[interval]], active: true });
    const price = prices.data?.[0];
    if (!price) throw new HttpError(503, "the Team price isn't set up in Stripe");
    const metered = (await stripe("GET", "prices", { lookup_keys: ["snout_agent_runs"], active: true })).data?.[0];
    const back = `${cfg.publicUrl}/?team=${teamId}`;
    const session = await stripe("POST", "checkout/sessions", {
      mode: "subscription",
      line_items: [
        { price: price.id, quantity: Math.max(1, t.members), adjustable_quantity: { enabled: true, minimum: 1, maximum: 1000 } },
        // Cloud-agent runs: 5,000 a month included, then metered (graduated tiers on the price).
        ...(metered ? [{ price: metered.id }] : []),
      ],
      client_reference_id: String(teamId),
      metadata: { team_id: String(teamId) },
      subscription_data: { metadata: { team_id: String(teamId) } },
      ...(t.stripe_customer_id ? { customer: t.stripe_customer_id } : {}),
      allow_promotion_codes: true,
      success_url: `${back}&billing=success`,
      cancel_url: `${back}&billing=cancelled`,
    });
    json(res, 200, { url: session.url });
  }

  async function portal(req, res) {
    const b = await body(req);
    await owner(req, Number(b.team_id));
    const [t] = await db.query("select stripe_customer_id from teams where id = $1", [Number(b.team_id)]);
    if (!t?.stripe_customer_id) throw new HttpError(400, "this team has no subscription yet");
    const s = await stripe("POST", "billing_portal/sessions", { customer: t.stripe_customer_id, return_url: `${cfg.publicUrl}/?team=${b.team_id}` });
    json(res, 200, { url: s.url });
  }

  async function rawBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, "body too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">. Five minutes of tolerance. */
  function verifyStripe(payload, header) {
    if (!cfg.stripeWebhookSecret) throw new HttpError(503, "webhook secret not configured");
    const parts = Object.fromEntries(String(header || "").split(",").map((kv) => kv.split("=")).filter((p) => p.length === 2));
    const sigs = String(header || "").split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
    const t = Number(parts.t);
    if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(400, "bad signature");
    const want = Buffer.from(createHmac("sha256", cfg.stripeWebhookSecret).update(`${t}.${payload}`).digest("hex"));
    if (!sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), want))) throw new HttpError(400, "bad signature");
  }

  /** A subscription's state, applied to its team. Active or trialing is paid; ended is free. */
  async function applySubscription(sub, teamIdHint) {
    const teamId = Number(sub.metadata?.team_id || teamIdHint);
    const paid = ["active", "trialing", "past_due"].includes(sub.status);
    const seats = sub.items?.data?.[0]?.quantity ?? null;
    const params = [sub.id, typeof sub.customer === "string" ? sub.customer : sub.customer?.id, seats, sub.status, sub.current_period_end ? new Date(sub.current_period_end * 1000) : null, paid ? "team" : "free"];
    const where = teamId ? "id = $7" : "stripe_subscription_id = $1";
    if (teamId) params.push(teamId);
    await db.query(
      `update teams set stripe_subscription_id = $1, stripe_customer_id = coalesce($2, stripe_customer_id), seats = $3, billing_status = $4, current_period_end = $5, plan = $6 where ${where}`,
      params,
    );
  }

  async function stripeWebhook(req, res) {
    const payload = await rawBody(req);
    verifyStripe(payload, req.headers["stripe-signature"]);
    const event = JSON.parse(payload);
    const o = event.data?.object ?? {};
    if (event.type === "checkout.session.completed" && o.mode === "subscription" && o.subscription) {
      const sub = await stripe("GET", `subscriptions/${o.subscription}`);
      await applySubscription(sub, o.client_reference_id || o.metadata?.team_id);
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted" || event.type === "customer.subscription.created") {
      await applySubscription(o);
    } else if (event.type === "invoice.payment_failed" && o.subscription) {
      await db.query("update teams set billing_status = 'past_due' where stripe_subscription_id = $1", [o.subscription]);
    }
    json(res, 200, { received: true });
  }

  // --- router -------------------------------------------------------------------------

  return async function handle(req, res) {
    const url = new URL(req.url || "/", cfg.publicUrl);
    const route = `${req.method} ${url.pathname}`;
    try {
      // A ceiling per address across the whole app, under the per-endpoint limits. It stops
      // scripted abuse; a volumetric flood needs a CDN in front (Cloudflare), not app code.
      if (route !== "GET /healthz") limit(`ip:${clientIp(req)}`, cfg.ipPerMinute, 60_000);
      if (route === "GET /healthz") {
        // Railway stamps each build with its source, so a deploy can be traced to a commit.
        const e = process.env;
        return json(res, 200, { ok: true, engine: db.engine, ...(e.RAILWAY_GIT_COMMIT_SHA ? { repo: `${e.RAILWAY_GIT_REPO_OWNER}/${e.RAILWAY_GIT_REPO_NAME}`, commit: e.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) } : {}) });
      }
      if (route === "GET /") return page(res, "app");
      if (route === "GET /device") return page(res, "device");
      if (route === "GET /auth/github") return await githubStart(req, res, url);
      if (route === "GET /auth/github/callback") return await githubCallback(req, res, url);
      if (route === "GET /auth/dev") return await devLogin(req, res, url);
      if (route === "GET /auth/config") return json(res, 200, { github: !!cfg.githubClientId, dev: cfg.devLogin });
      if (route === "POST /auth/logout") {
        sameOrigin(req);
        return json(res, 200, { ok: true }, { "set-cookie": cookie("snout_session", "", 0) });
      }
      if (route === "POST /api/device/start") return await deviceStart(req, res);
      if (route === "POST /api/device/poll") return await devicePoll(req, res);
      if (route === "POST /api/device/approve") return await deviceApprove(req, res);
      if (route === "POST /api/ingest") return await ingest(req, res);
      if (route === "GET /api/me") return await apiMe(req, res);
      if (route === "POST /api/beta/redeem") return await redeemBeta(req, res);
      if (route === "POST /api/admin/beta-codes") return await createBetaCodes(req, res);
      if (route === "GET /api/admin/beta-codes") return await listBetaCodes(req, res);
      if (route === "GET /api/usage") return await apiUsage(req, res, url);
      if (route === "GET /api/tokens") return await apiTokens(req, res);
      if (route === "POST /api/teams") return await createTeam(req, res);
      let m;
      if (req.method === "POST" && (m = /^\/api\/tokens\/(\d+)\/revoke$/.exec(url.pathname))) return await revokeToken(req, res, m[1]);
      if (req.method === "POST" && (m = /^\/api\/teams\/(\d+)\/invites$/.exec(url.pathname))) return await createInvite(req, res, m[1]);
      if (req.method === "GET" && (m = /^\/api\/teams\/(\d+)\/members$/.exec(url.pathname))) return await listMembers(req, res, m[1]);
      if (req.method === "POST" && (m = /^\/api\/teams\/(\d+)\/members\/(\d+)\/remove$/.exec(url.pathname))) return await removeMember(req, res, m[1], m[2]);
      if (req.method === "POST" && (m = /^\/api\/teams\/(\d+)\/members\/(\d+)\/role$/.exec(url.pathname))) return await setRole(req, res, m[1], m[2]);
      if (req.method === "POST" && (m = /^\/api\/teams\/(\d+)\/leave$/.exec(url.pathname))) return await leaveTeam(req, res, m[1]);
      if (req.method === "GET" && (m = /^\/api\/teams\/(\d+)\/keys$/.exec(url.pathname))) return await listKeys(req, res, m[1]);
      if (req.method === "POST" && (m = /^\/api\/teams\/(\d+)\/keys$/.exec(url.pathname))) return await createKey(req, res, m[1]);
      if (req.method === "POST" && (m = /^\/api\/teams\/(\d+)\/keys\/(\d+)\/revoke$/.exec(url.pathname))) return await revokeKey(req, res, m[1], m[2]);
      if (route === "POST /api/billing/checkout") return await checkout(req, res);
      if (route === "POST /api/billing/portal") return await portal(req, res);
      if (route === "POST /api/stripe/webhook") return await stripeWebhook(req, res);
      if (req.method === "GET" && (m = /^\/invite\/(inv_[A-Za-z0-9_-]{20,})$/.exec(url.pathname))) return await acceptInvite(req, res, m[1]);
      json(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) process.stderr.write(`${new Date().toISOString()} ${route} ${err.stack || err}\n`);
      if (!res.headersSent) json(res, status, { error: status === 500 ? "internal error" : err.message, ...(err.extra ?? {}) });
      else res.end();
    }
  };
}
