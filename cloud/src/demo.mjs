/**
 * Sample data for local development: a team of eight with four projects, a month of syncs
 * across coding agents and models. Dev only (`npm run dev:demo`); never runs in production.
 *
 * Numbers follow the shapes Snout measures in real sessions: most reads are source and pass
 * through, and the savings come from command output, long docs and logs, MCP results,
 * repeats and generated files.
 */
import { createHash } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const devGithubId = (login) => -parseInt(sha256(login).slice(0, 12), 16);

const PEOPLE = [
  { login: "dev", weight: 1.0 },
  { login: "maya-chen", weight: 1.4 },
  { login: "jordan-ellis", weight: 1.1 },
  { login: "sam-okafor", weight: 0.9 },
  { login: "priya-raman", weight: 1.2 },
  { login: "leo-martins", weight: 0.6 },
  { login: "ana-kowalski", weight: 0.8 },
  { login: "chris-yamada", weight: 0.4 },
];
const PROJECTS = [
  { key: "demo-web", name: "web-app", weight: 1.3 },
  { key: "demo-api", name: "payments-api", weight: 1.0 },
  { key: "demo-infra", name: "infra", weight: 0.5 },
  { key: "demo-mobile", name: "mobile", weight: 0.7 },
];
// Each person has a main agent and model; some use a second.
const SETUPS = [
  [["claude", "claude-opus-5-5"], ["claude", "claude-haiku-4-5"]],
  [["claude", "claude-sonnet-5-5"]],
  [["codex", "gpt-5.3-codex"]],
  [["claude", "claude-sonnet-5-5"], ["cursor", "claude-sonnet-5-5"]],
  [["claude", "claude-opus-5-5"]],
  [["gemini", "gemini-3-pro"]],
  [["cursor", "gpt-5.2"]],
  [["claude", "claude-haiku-4-5"]],
];
// label → [reads per day, tokens per read, share kept out]
const LABELS = {
  source: [60, 1800, 0],
  "command-output": [14, 5200, 0.82],
  "long-doc": [3, 14000, 0.7],
  "long-log": [1.5, 30000, 0.88],
  "repeat-read": [6, 2600, 0.95],
  "repeat-output": [3, 3000, 0.95],
  generated: [2, 9000, 0.9],
  lockfile: [0.8, 40000, 0.92],
  vendored: [1, 7000, 0.85],
  minified: [0.3, 25000, 0.9],
  "mcp-linear": [4, 6000, 0.6],
  "mcp-github": [3, 4500, 0.5],
  "mcp-sentry": [1, 9000, 0.65],
};
// $ per million tokens: input, cache write, cache read, output
const PRICE = {
  "claude-opus-5-5": [4, 5, 0.2, 20],
  "claude-sonnet-5-5": [2, 2.5, 0.2, 10],
  "claude-haiku-4-5": [1, 1.25, 0.1, 5],
  "gpt-5.3-codex": [1.75, 0, 0.175, 14],
  "gpt-5.2": [1.75, 0, 0.175, 14],
  "gemini-3-pro": [2, 0, 0.2, 12],
};

/** Deterministic noise so every restart shows the same month. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export async function seedDemo(db) {
  const [exists] = await db.query("select id from teams where name = 'Acme Engineering'");
  if (exists) return;
  const rand = rng(7);
  const users = [];
  for (const p of PEOPLE) {
    const [u] = await db.query(
      `insert into users (github_id, login, name, approved_at) values ($1, $2, $3, now())
       on conflict (github_id) do update set approved_at = now() returning id`,
      [devGithubId(p.login), p.login, p.login],
    );
    users.push({ ...p, id: Number(u.id) });
  }
  const [team] = await db.query("insert into teams (name, plan, seats) values ('Acme Engineering', 'team', 10) returning id");
  for (const [i, u] of users.entries()) {
    await db.query("insert into memberships (team_id, user_id, role) values ($1, $2, $3)", [team.id, u.id, i === 0 ? "owner" : i === 1 ? "admin" : "member"]);
  }
  const projects = [];
  for (const p of PROJECTS) {
    const [row] = await db.query("insert into projects (team_id, key, name) values ($1, $2, $3) returning id", [team.id, sha256(p.key), p.name]);
    projects.push({ ...p, id: Number(row.id) });
  }

  const today = new Date();
  for (let back = 29; back >= 0; back--) {
    const d = new Date(today.getTime() - back * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    const weekday = d.getUTCDay() % 6 !== 0;
    // Adoption grows over the month: more of the team on Snout, more of each session trimmed.
    const ramp = 0.55 + 0.45 * ((29 - back) / 29);
    for (const [ui, u] of users.entries()) {
      if (!weekday && rand() > 0.25) continue;
      if (rand() > 0.85) continue; // a day off
      for (const pr of projects) {
        if (rand() > pr.weight * 0.55) continue;
        for (const [client, model] of SETUPS[ui]) {
          const scale = u.weight * pr.weight * (0.6 + rand() * 0.8) * (client === SETUPS[ui][0][0] && model === SETUPS[ui][0][1] ? 1 : 0.35);
          let inCtx = 0;
          let held = 0;
          const usage = [];
          for (const [label, [perDay, size, keep]] of Object.entries(LABELS)) {
            const reads = Math.round(perDay * scale * (0.5 + rand()));
            if (!reads) continue;
            const total = reads * size * (0.7 + rand() * 0.6);
            const k = keep * ramp;
            const heldBack = Math.round(total * k);
            const inContext = Math.round(total - heldBack);
            const gated = k ? Math.max(1, Math.round(reads * Math.min(1, k + 0.1))) : 0;
            inCtx += inContext;
            held += heldBack;
            usage.push([label, reads, gated, inContext, heldBack]);
          }
          for (const [label, reads, gated, inContext, heldBack] of usage) {
            await db.query(
              `insert into usage_daily (team_id, project_id, user_id, day, client, label, model, reads, gated, in_context, held_back, could_hold_back)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0)`,
              [team.id, pr.id, u.id, day, client, label, model, reads, gated, inContext, heldBack],
            );
          }
          // Context is re-sent every turn: billed input is many times what was read once.
          const turns = 18 + Math.round(rand() * 30);
          const requests = turns * (1 + Math.round(rand() * 2));
          const cacheRead = Math.round(inCtx * turns * 0.55);
          const cacheWrite = Math.round(inCtx * 1.1);
          const input = Math.round(inCtx * 0.25 + requests * 1200);
          const output = Math.round(requests * (500 + rand() * 900));
          const [pi, pw, pc, po] = PRICE[model];
          const cost = (input * pi + cacheWrite * pw + cacheRead * pc + output * po) / 1e6;
          await db.query(
            `insert into spend_daily (team_id, project_id, user_id, day, client, model, requests, input, cache_write, cache_read, output, cost_usd)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             on conflict (team_id, project_id, user_id, day, client, model) do update set requests = spend_daily.requests + excluded.requests,
               input = spend_daily.input + excluded.input, cache_write = spend_daily.cache_write + excluded.cache_write,
               cache_read = spend_daily.cache_read + excluded.cache_read, output = spend_daily.output + excluded.output,
               cost_usd = spend_daily.cost_usd + excluded.cost_usd`,
            [team.id, pr.id, u.id, day, client, model, requests, input, cacheWrite, cacheRead, output, cost],
          );
        }
      }
    }
  }
}
