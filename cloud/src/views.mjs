// @ts-check
/**
 * The hosted dashboard's numbers: synced rows in, the `TeamView` the page renders out. Pure, so
 * it is tested without a database, and type-checked against src/dashboard/api.ts (the same
 * contract the local dashboard uses), so a field cannot drift between server and page.
 *
 * @typedef {import("../../src/dashboard/api.js").TeamView} TeamView
 * @typedef {import("../../src/dashboard/api.js").TeamTotals} TeamTotals
 * @typedef {import("../../src/dashboard/api.js").TeamSpend} TeamSpend
 * @typedef {import("../../src/dashboard/api.js").TeamSlice} TeamSlice
 * @typedef {import("../../src/dashboard/api.js").TeamMember} TeamMember
 * @typedef {import("../../src/dashboard/api.js").TeamClient} TeamClient
 * @typedef {import("../../src/dashboard/api.js").TeamMachine} TeamMachine
 * @typedef {import("../../src/dashboard/api.js").HostedTeam} HostedTeam
 *
 * @typedef {{ day: string, project: string, login: string, client: string, label: string, model: string, reads: number, gated: number, inContext: number, heldBack: number, couldHoldBack: number }} UsageRow
 * @typedef {{ day: string, project: string, login: string, client: string, model: string, requests: number, tokens: number, cacheRead: number, costUsd: number | null }} SpendRow
 * @typedef {{ login: string, name: string | null, avatar: string | null, agent: boolean }} UserRow
 */

/** @returns {TeamTotals} */
const zeroSnout = () => ({ reads: 0, gated: 0, inContext: 0, keptOut: 0, couldKeepOut: 0 });
/** @returns {TeamSpend} */
const zeroSpend = () => ({ requests: 0, tokens: 0, cacheRead: 0, costUsd: 0 });

/** @param {TeamTotals} t @param {UsageRow} r */
function addUsage(t, r) {
  t.reads += r.reads;
  t.gated += r.gated;
  t.inContext += r.inContext;
  t.keptOut += r.heldBack;
  t.couldKeepOut += r.couldHoldBack;
}

/** @param {TeamSpend} t @param {SpendRow} r */
function addSpend(t, r) {
  t.requests += r.requests;
  t.tokens += r.tokens;
  t.cacheRead += r.cacheRead;
  t.costUsd += r.costUsd ?? 0;
}

/**
 * Slices keyed by one field of both row kinds.
 * @template {TeamSlice} S
 * @param {UsageRow[]} usage
 * @param {SpendRow[]} spend
 * @param {(r: UsageRow | SpendRow) => string} keyOf
 * @param {(key: string) => S} make
 * @returns {Map<string, S>}
 */
function slices(usage, spend, keyOf, make) {
  /** @type {Map<string, S>} */
  const m = new Map();
  const get = (/** @type {string} */ k) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = make(k)));
    return s;
  };
  for (const r of usage) {
    const s = get(keyOf(r));
    addUsage(s.snout, r);
    if (!s.last || r.day > s.last) s.last = r.day;
  }
  for (const r of spend) {
    const s = get(keyOf(r));
    addSpend(s.spend, r);
    if (!s.last || r.day > s.last) s.last = r.day;
  }
  return m;
}

/** Biggest first: what cost the most, then what Snout kept out. */
const bySize = (/** @type {TeamSlice} */ a, /** @type {TeamSlice} */ b) => b.spend.costUsd - a.spend.costUsd || b.snout.keptOut - a.snout.keptOut || b.snout.reads - a.snout.reads;

/** @param {string} key @param {string} name @returns {TeamSlice} */
const slice = (key, name) => ({ key, name, snout: zeroSnout(), spend: zeroSpend(), last: null });

/**
 * Every day from `days - 1` days before `today` through `today`, as YYYY-MM-DD.
 * @param {string} today @param {number} days
 */
export function dayRange(today, days) {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/**
 * @param {{
 *   team: HostedTeam, days: number, capped: { historyDays: number } | null, today: string, now: string,
 *   usage: UsageRow[], spend: SpendRow[], projects: { id: string, name: string }[], users: UserRow[],
 *   machines: TeamMachine[], lastSyncAt: string | null
 * }} input
 * @returns {TeamView}
 */
export function teamView(input) {
  const { usage, spend } = input;
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]));
  const user = new Map(input.users.map((u) => [u.login, u]));

  const totals = zeroSnout();
  for (const r of usage) addUsage(totals, r);
  const spendTotals = zeroSpend();
  for (const r of spend) addSpend(spendTotals, r);
  const unpriced = [...new Set(spend.filter((r) => r.costUsd === null && r.requests > 0).map((r) => r.model))].sort();

  const days = new Map(dayRange(input.today, input.days).map((d) => [d, { day: d, inContext: 0, keptOut: 0, costUsd: 0, tokens: 0 }]));
  for (const r of usage) {
    const d = days.get(r.day);
    if (d) {
      d.inContext += r.inContext;
      d.keptOut += r.heldBack;
    }
  }
  for (const r of spend) {
    const d = days.get(r.day);
    if (d) {
      d.costUsd += r.costUsd ?? 0;
      d.tokens += r.tokens;
    }
  }

  const members = slices(usage, spend, (r) => r.login, (login) => {
    const u = user.get(login);
    /** @type {TeamMember} */
    const m = { ...slice(login, u?.name || login), avatar: u?.avatar ?? null, agent: !!u?.agent, clients: [] };
    return m;
  });
  for (const r of [...usage, ...spend]) {
    const m = members.get(r.login);
    if (m && !m.clients.includes(r.client)) m.clients.push(r.client);
  }

  const clients = slices(usage, spend, (r) => r.client, (c) => /** @type {TeamClient} */ ({ ...slice(c, c), members: 0, models: [] }));
  /** @type {Map<string, Set<string>>} */
  const clientMembers = new Map();
  for (const r of [...usage, ...spend]) {
    const set = clientMembers.get(r.client) ?? new Set();
    set.add(r.login);
    clientMembers.set(r.client, set);
    const c = clients.get(r.client);
    if (c && r.model && !c.models.includes(r.model)) c.models.push(r.model);
  }
  for (const [k, c] of clients) c.members = clientMembers.get(k)?.size ?? 0;

  // Models: spend is per model; savings rows carry the session's model, "" before it was recorded.
  const models = slices(usage.filter((r) => r.model), spend, (r) => r.model, (m) => ({ ...slice(m, m), client: "" }));
  /** @type {Map<string, Map<string, number>>} */
  const modelClients = new Map();
  for (const r of spend) {
    const c = modelClients.get(r.model) ?? new Map();
    c.set(r.client, (c.get(r.client) ?? 0) + r.requests);
    modelClients.set(r.model, c);
  }
  for (const [k, m] of models) m.client = [...(modelClients.get(k) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? usage.find((r) => r.model === k)?.client ?? "";

  const projects = slices(usage, spend, (r) => r.project, (id) => slice(id, projectName.get(id) ?? "project"));

  /** @type {Map<string, { key: string, reads: number, inContext: number, keptOut: number }>} */
  const labels = new Map();
  /** @type {Map<string, { key: string, reads: number, inContext: number, keptOut: number }>} */
  const mcp = new Map();
  for (const r of usage) {
    const server = r.label.startsWith("mcp-") && r.label !== "mcp-output" ? r.label.slice(4) : null;
    for (const [m, k] of server ? [[mcp, server], [labels, "mcp"]] : [[labels, r.label]]) {
      const map = /** @type {typeof labels} */ (m);
      const key = /** @type {string} */ (k);
      const s = map.get(key) ?? { key, reads: 0, inContext: 0, keptOut: 0 };
      s.reads += r.reads;
      s.inContext += r.inContext;
      s.keptOut += r.heldBack;
      map.set(key, s);
    }
  }
  const bySaved = (/** @type {{ keptOut: number, inContext: number }} */ a, /** @type {{ keptOut: number, inContext: number }} */ b) => b.keptOut - a.keptOut || b.inContext - a.inContext;

  return {
    team: input.team,
    days: input.days,
    capped: input.capped,
    totals,
    spend: { ...spendTotals, unpriced },
    series: [...days.values()],
    byMember: [...members.values()].sort(bySize),
    byClient: [...clients.values()].sort(bySize),
    byModel: [...models.values()].sort(bySize),
    byProject: [...projects.values()].sort(bySize),
    byLabel: [...labels.values()].sort(bySaved),
    byMcp: [...mcp.values()].sort(bySaved),
    machines: input.machines,
    lastSyncAt: input.lastSyncAt,
    now: input.now,
  };
}
