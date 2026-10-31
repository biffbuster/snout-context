/**
 * The dashboard's pages as data: pure functions from ledger rows, agent sessions (sessions.ts)
 * and Snout's recall records to the shapes in api.ts. The server decides when to recompute;
 * tests pin the numbers here.
 *
 * Accounting, the same everywhere on the page:
 *  - Billed tokens and cost come from the agents' usage logs (measured). Cost is API list price.
 *  - Kept out comes from the ledger: denied, trimmed or pointer-answered reads, minus any the user
 *    overrode (estimated from bytes). A row counts once, in the view that shows it.
 *  - Dollars saved = kept out × the session model's input price, counted once. An estimate,
 *    never added to spend.
 *  - Observe mode's "would keep out" is shown apart and never called a saving.
 */
import type { DecisionRow } from "../types.js";
import { agentLabel, harnessOf, redundancyOf } from "../ledger/report.js";
import { mcpServerOf } from "./summary.js";
import { priceOf } from "../spend/prices.js";
import type { RequestRec, SessionLog, ToolRec } from "./sessions.js";
import type {
  AgentCard, Analytics, EnvironmentKind, Execution, FeedRow, ModelCard, Overview, Point, RangeInfo, RangeKey, SessionDetail, SessionRow,
  Slice, SnoutTotals, Trace, TraceEdge, TraceNode, TraceTurn, Usage,
} from "./api.js";

export interface RecallRow {
  ts: string;
  session: string;
  turn: number;
  /**
   * "hint": the session-start line saying earlier sessions exist (`unfinished`: the session it named);
   * "search" / "fetch": an agent's call to Snout's memory tools (`asked`, the records `shown`, `missed`);
   * "inject": automatic notes' audit (shown only when they are on); "brief" and rows with `cards`: older versions.
   */
  kind?: "brief" | "inject" | "hint" | "search" | "fetch";
  cards?: string[];
  unfinished?: string;
  asked?: string;
  shown?: string[];
  missed?: boolean;
  injected?: boolean;
  tokensEst: number;
}

export interface Inputs {
  rows: DecisionRow[];
  sessions: SessionLog[];
  recall: RecallRow[];
  mode: string;
  configDir?: string;
  now?: Date;
}

const DAY = 86_400_000;
/** A session with activity this recent is shown as working. */
export const WORKING_MS = 120_000;
const FEED = 60;

// ---------------------------------------------------------------- ranges

export function rangeOf(key: string | null, from: string | null, to: string | null, now = new Date()): RangeInfo {
  const end = now.toISOString();
  const k = (["live", "24h", "7d", "30d", "all", "custom"].includes(key ?? "") ? key : "7d") as RangeKey;
  if (k === "custom" && from && !Number.isNaN(Date.parse(from))) {
    const f = new Date(from).toISOString();
    const t = to && !Number.isNaN(Date.parse(to)) ? new Date(to).toISOString() : end;
    const span = Date.parse(t) - Date.parse(f);
    return { key: k, from: f, to: t, bucket: span <= 2 * 3600_000 ? 60 : span <= 3 * DAY ? 3600 : 86400 };
  }
  const back: Record<string, number> = { live: 3600_000, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, all: 3650 * DAY };
  const span = back[k] ?? 7 * DAY;
  return { key: k === "custom" ? "7d" : k, from: new Date(now.getTime() - span).toISOString(), to: end, bucket: k === "live" ? 60 : k === "24h" ? 3600 : 86400 };
}

const inRange = (ts: string, r: RangeInfo) => ts >= r.from && ts <= r.to;

// ---------------------------------------------------------------- usage

export const emptyUsage = (): Usage => ({ requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0, unpriced: 0 });

function addReq(u: Usage, r: RequestRec): Usage {
  u.requests += 1;
  u.input += r.input;
  u.cacheWrite += r.cacheWrite;
  u.cacheRead += r.cacheRead;
  u.output += r.output;
  if (r.costUsd === null) u.unpriced += 1;
  else u.costUsd += r.costUsd;
  return u;
}

export const billedInput = (u: Pick<Usage, "input" | "cacheWrite" | "cacheRead">) => u.input + u.cacheWrite + u.cacheRead;
export const totalTokens = (u: Usage) => billedInput(u) + u.output;

export function providerOf(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("opus") || m.includes("sonnet") || m.includes("haiku") || m.includes("fable")) return "Anthropic";
  if (m.startsWith("gpt") || m.includes("codex") || /^o\d/.test(m)) return "OpenAI";
  if (m.includes("gemini")) return "Google";
  if (m.includes("kimi")) return "Moonshot";
  if (m.includes("mistral") || m.includes("codestral")) return "Mistral";
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("grok")) return "xAI";
  return "Other";
}

/** The context window a model is known to have; null when we do not know. Claude: 200k, or 1M once a session went past 200k. */
export function windowOf(model: string, peak: number): number | null {
  if (providerOf(model) !== "Anthropic") return null;
  return peak > 200_000 ? 1_000_000 : 200_000;
}

const inputRateOf = (model: string, configDir?: string): number | null => priceOf(model, configDir)?.input ?? null;

// ---------------------------------------------------------------- Snout's ledger

const REPEAT_RULES = new Set(["repeat-read", "repeat-output"]);
const OUTPUT_RULES = new Set(["command-output", "mcp-output"]);
const clientOf = (r: DecisionRow): string => r.client ?? "claude";
const labelOf = (rule: string): string => (rule === "binary-content" ? "binary" : rule === "unclassified" ? "source" : rule);

interface Scored {
  row: DecisionRow;
  reached: number;
  kept: number;
  could: number;
  acted: boolean;
}

/** Each ledger row with what reached context and what was kept out, overrides applied. */
export function score(rows: DecisionRow[]): { reads: Scored[]; tool: DecisionRow[]; overridden: number } {
  const h = harnessOf(rows);
  const over = new Set(h.overridden);
  const reads = h.reads.map((r): Scored => {
    const acted = r.decision !== "allow" && !r.observedOnly;
    const kept = acted && !over.has(r) ? r.tokensAvoidedEst || 0 : 0;
    const reachedCtx = r.decision === "allow" || r.observedOnly || r.trimmed || over.has(r);
    const flagged = r.value <= 1 && r.rule !== "unclassified";
    return { row: r, reached: reachedCtx ? r.tokensReadEst || 0 : 0, kept, could: r.observedOnly && flagged ? r.tokensAvoidedEst || 0 : 0, acted };
  });
  return { reads, tool: h.toolOutput, overridden: over.size };
}

export function snoutTotals(rows: DecisionRow[]): SnoutTotals & { toolOutput: number } {
  const s = score(rows);
  const t: SnoutTotals & { toolOutput: number } = { reads: s.reads.length, inContext: 0, keptOut: 0, couldKeepOut: 0, events: 0, trims: 0, denials: 0, repeats: 0, repeatTokens: 0, outputTrims: 0, outputTokens: 0, overridden: s.overridden, toolOutput: 0 };
  for (const x of s.reads) {
    t.inContext += x.reached;
    t.keptOut += x.kept;
    t.couldKeepOut += x.could;
    if (x.acted) t.events += 1;
    if (x.acted && x.row.trimmed) t.trims += 1;
    else if (x.acted && x.row.decision === "deny") t.denials += 1;
    if (x.acted && REPEAT_RULES.has(x.row.rule)) {
      t.repeats += 1;
      t.repeatTokens += x.kept;
    }
    if (x.acted && OUTPUT_RULES.has(x.row.rule)) {
      t.outputTrims += 1;
      t.outputTokens += x.kept;
    }
  }
  for (const r of s.tool) t.toolOutput += r.tokensReadEst || 0;
  t.inContext += t.toolOutput;
  return t;
}

function outcomeOf(x: Scored): FeedRow["outcome"] {
  const r = x.row;
  if (r.trimmed && x.acted) return "trimmed";
  if (x.acted) return r.decision === "ask" ? "asked" : "held back";
  return x.could > 0 ? "would hold back" : "read";
}

function feedOf(rows: DecisionRow[], limit = FEED): FeedRow[] {
  const s = score(rows);
  const out: FeedRow[] = s.reads.map((x) => ({
    ts: x.row.ts, session: x.row.session, client: clientOf(x.row), agent: agentLabel({ agentId: x.row.agentId, agentType: x.row.agentType }), tool: x.row.tool,
    path: x.row.path, rule: labelOf(x.row.rule), outcome: outcomeOf(x), inContext: x.reached, keptOut: x.kept, reason: (x.row.reason || "").slice(0, 240),
  }));
  for (const r of s.tool) {
    out.push({ ts: r.ts, session: r.session, client: clientOf(r), agent: agentLabel({ agentId: r.agentId, agentType: r.agentType }), tool: r.tool, path: r.path || r.tool, rule: "tool output", outcome: "read", inContext: r.tokensReadEst || 0, keptOut: 0, reason: "" });
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
}

function slices(rows: DecisionRow[], key: (r: DecisionRow) => string | null): Slice[] {
  const m = new Map<string, Slice>();
  const s = score(rows);
  const bump = (k: string | null, reached: number, kept: number) => {
    if (!k) return;
    const x = m.get(k) ?? { key: k, reads: 0, inContext: 0, keptOut: 0 };
    x.reads += 1;
    x.inContext += reached;
    x.keptOut += kept;
    m.set(k, x);
  };
  for (const x of s.reads) bump(key(x.row), x.reached, x.kept);
  for (const r of s.tool) bump(key(r), r.tokensReadEst || 0, 0);
  return [...m.values()].sort((a, b) => b.keptOut - a.keptOut || b.inContext - a.inContext);
}

// ---------------------------------------------------------------- sessions

export function environmentOf(s: Pick<SessionLog, "client" | "surface" | "trigger">): EnvironmentKind {
  const v = `${s.surface} ${s.trigger}`.toLowerCase();
  if (/remote|ios|android|mobile|web/.test(v)) return "remote";
  if (/cloud|sandbox|container/.test(v)) return "cloud";
  if (/desktop/.test(v)) return "desktop";
  if (/sdk/.test(v)) return "sdk";
  return "local";
}

const mainModel = (s: SessionLog): string => {
  const m = new Map<string, number>();
  for (const r of s.requests) if (!r.agent) m.set(r.model, (m.get(r.model) ?? 0) + r.output + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.requests[0]?.model ?? "";
};

function contextOf(r: RequestRec): number {
  return r.input + r.cacheRead + r.cacheWrite;
}

export function sessionRow(s: SessionLog, rows: DecisionRow[], now: Date, configDir?: string, range?: RangeInfo): SessionRow {
  const reqs = range ? s.requests.filter((r) => inRange(r.ts, range)) : s.requests;
  const usage = reqs.reduce(addReq, emptyUsage());
  const t = snoutTotals(rows);
  const main = s.requests.filter((r) => !r.agent);
  const last = main.at(-1);
  const model = mainModel(s);
  const peak = main.reduce((a, r) => Math.max(a, contextOf(r)), 0);
  const rate = model ? inputRateOf(model, configDir) : null;
  return {
    id: s.id,
    client: s.client,
    title: s.title || s.prompts[0]?.text.slice(0, 120) || "Untitled session",
    task: s.prompts.at(-1)?.text ?? "",
    surface: s.surface,
    environment: environmentOf(s),
    version: s.version,
    branch: s.branch,
    models: [...new Set(s.requests.map((r) => r.model))],
    first: s.first,
    last: s.last,
    status: now.getTime() - Date.parse(s.last) < WORKING_MS ? "working" : "idle",
    turns: s.prompts.length,
    toolCalls: s.tools.length,
    errors: s.tools.filter((x) => x.error).length,
    compactions: s.compactions.length,
    subagents: s.subagents.length,
    contextNow: last ? contextOf(last) : 0,
    contextWindow: model ? windowOf(model, peak) : null,
    usage,
    snout: { reads: t.reads, keptOut: t.keptOut, couldKeepOut: t.couldKeepOut, events: t.events, repeats: t.repeats },
    savedUsd: rate !== null ? (t.keptOut * rate) / 1e6 : null,
  };
}

function bySession(rows: DecisionRow[]): Map<string, DecisionRow[]> {
  const m = new Map<string, DecisionRow[]>();
  for (const r of rows) {
    const a = m.get(r.session) ?? [];
    a.push(r);
    m.set(r.session, a);
  }
  return m;
}

export function sessionRows(inp: Inputs, range?: RangeInfo): SessionRow[] {
  const now = inp.now ?? new Date();
  const rows = range ? inp.rows.filter((r) => inRange(r.ts, range)) : inp.rows;
  const per = bySession(rows);
  return inp.sessions
    .filter((s) => !range || (s.last >= range.from && s.first <= range.to))
    .map((s) => sessionRow(s, per.get(s.id) ?? [], now, inp.configDir, range));
}

/** Saved dollars for a set of ledger rows: each session's rows at that session's model input price. */
function savedOf(rows: DecisionRow[], sessions: Map<string, SessionLog>, configDir?: string, fallbackRate: number | null = null): number | null {
  let usd = 0;
  let priced = false;
  for (const [id, rs] of bySession(rows)) {
    const kept = snoutTotals(rs).keptOut;
    if (!kept) continue;
    const s = sessions.get(id);
    const model = s ? mainModel(s) : rs.find((r) => r.model)?.model ?? "";
    const rate = (model && inputRateOf(model, configDir)) || fallbackRate;
    if (rate === null || rate === undefined) continue;
    usd += (kept * rate) / 1e6;
    priced = true;
  }
  return priced ? usd : null;
}

// ---------------------------------------------------------------- turns

interface TurnSpan {
  session: SessionLog;
  n: number;
  prompt: string;
  start: string;
  end: string | null;
  durationMs: number | null;
  next: string | null;
}

function turnsOf(s: SessionLog): TurnSpan[] {
  const out: TurnSpan[] = [];
  s.prompts.forEach((p, i) => {
    const next = s.prompts[i + 1]?.ts ?? null;
    const end = s.turnEnds.find((e) => e.ts >= p.ts && (!next || e.ts <= next));
    out.push({ session: s, n: i + 1, prompt: p.text, start: p.ts, end: end?.ts ?? next, durationMs: end?.durationMs ?? (next ? Date.parse(next) - Date.parse(p.ts) : null), next });
  });
  return out;
}

const within = (ts: string, start: string, end: string | null) => ts >= start && (!end || ts < end);

function executionOf(t: TurnSpan, rows: DecisionRow[], now: Date): Execution {
  const reqs = t.session.requests.filter((r) => within(r.ts, t.start, t.next));
  const u = reqs.reduce(addReq, emptyUsage());
  const kept = snoutTotals(rows.filter((r) => r.session === t.session.id && within(r.ts, t.start, t.next))).keptOut;
  const live = !t.end && now.getTime() - Date.parse(t.session.last) < WORKING_MS;
  const compacted = t.session.compactions.some((c) => within(c.ts, t.start, t.next));
  return {
    session: t.session.id,
    client: t.session.client,
    model: reqs.at(-1)?.model ?? mainModel(t.session),
    prompt: t.prompt,
    start: t.start,
    end: live ? null : t.end ?? t.session.last,
    status: live ? "running" : compacted ? "compacted" : "complete",
    durationMs: live ? now.getTime() - Date.parse(t.start) : t.durationMs ?? Date.parse(t.session.last) - Date.parse(t.start),
    tokens: totalTokens(u),
    costUsd: u.costUsd,
    keptOut: kept,
    toolCalls: t.session.tools.filter((x) => within(x.ts, t.start, t.next)).length,
  };
}

// ---------------------------------------------------------------- series

function bucketOf(ts: string, range: RangeInfo): string {
  const ms = Date.parse(ts);
  const w = range.bucket * 1000;
  return new Date(Math.floor(ms / w) * w).toISOString();
}

function seriesOf(rows: DecisionRow[], sessions: SessionLog[], range: RangeInfo): Point[] {
  const m = new Map<string, Point>();
  const w = range.bucket * 1000;
  // "All time" starts at the first record, not ten years back.
  const firstSeen = [...rows.map((r) => r.ts), ...sessions.map((s) => s.first)].filter((t) => t >= range.from).sort()[0];
  const start = Math.floor(Date.parse(range.key === "all" && firstSeen ? firstSeen : range.from) / w) * w;
  const end = Date.parse(range.to);
  for (let t = start; t <= end && m.size < 800; t += w) {
    const k = new Date(t).toISOString();
    m.set(k, { t: k, billed: 0, output: 0, costUsd: 0, inContext: 0, keptOut: 0 });
  }
  for (const s of sessions) {
    for (const r of s.requests) {
      if (!inRange(r.ts, range)) continue;
      const p = m.get(bucketOf(r.ts, range));
      if (!p) continue;
      p.billed += contextOf(r);
      p.output += r.output;
      p.costUsd += r.costUsd ?? 0;
    }
  }
  const sc = score(rows);
  for (const x of sc.reads) {
    const p = m.get(bucketOf(x.row.ts, range));
    if (!p) continue;
    p.inContext += x.reached;
    p.keptOut += x.kept;
  }
  for (const r of sc.tool) {
    const p = m.get(bucketOf(r.ts, range));
    if (p) p.inContext += r.tokensReadEst || 0;
  }
  return [...m.values()];
}

// ---------------------------------------------------------------- overview

function periodsOf(range: RangeInfo, now: Date): { labels: string[]; keyOf: (ts: string) => number } {
  const span = Date.parse(range.to) - Date.parse(range.from);
  if (span <= 8 * DAY) {
    const days = [2, 1, 0].map((i) => new Date(now.getTime() - i * DAY).toISOString().slice(0, 10));
    return { labels: days, keyOf: (ts) => days.indexOf(ts.slice(0, 10)) };
  }
  if (span <= 31 * DAY) {
    const starts = [2, 1, 0].map((i) => now.getTime() - (i + 1) * 7 * DAY);
    const labels = starts.map((s) => `Week of ${new Date(s + DAY).toISOString().slice(5, 10)}`);
    return { labels, keyOf: (ts) => { const t = Date.parse(ts); for (let i = 2; i >= 0; i--) if (t >= starts[i]!) return i; return -1; } };
  }
  const months = [2, 1, 0].map((i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); return d.toISOString().slice(0, 7); });
  return { labels: months, keyOf: (ts) => months.indexOf(ts.slice(0, 7)) };
}

export function overview(inp: Inputs, range: RangeInfo): Overview {
  const now = inp.now ?? new Date();
  const rows = inp.rows.filter((r) => inRange(r.ts, range));
  const live = inp.sessions.filter((s) => s.last >= range.from && s.first <= range.to);
  const byId = new Map(inp.sessions.map((s) => [s.id, s]));
  const usage = emptyUsage();
  const models = new Map<string, ModelCard & { sessionSet: Set<string>; activeSet: Set<string> }>();
  const agentCost = new Map<string, { key: string; costUsd: number; tokens: number }>();
  const p = periodsOf(range, now);
  const modelCost = new Map<string, { key: string; client: string; costUsd: number; tokens: number; periods: number[] }>();
  for (const s of inp.sessions) {
    const working = now.getTime() - Date.parse(s.last) < WORKING_MS;
    for (const r of s.requests) {
      const k = p.keyOf(r.ts);
      const mc = modelCost.get(r.model) ?? { key: r.model, client: s.client, costUsd: 0, tokens: 0, periods: [0, 0, 0] };
      if (k >= 0) mc.periods[k] = (mc.periods[k] ?? 0) + (r.costUsd ?? 0);
      if (inRange(r.ts, range)) {
        addReq(usage, r);
        mc.costUsd += r.costUsd ?? 0;
        mc.tokens += contextOf(r) + r.output;
        const a = agentCost.get(s.client) ?? { key: s.client, costUsd: 0, tokens: 0 };
        a.costUsd += r.costUsd ?? 0;
        a.tokens += contextOf(r) + r.output;
        agentCost.set(s.client, a);
        const c = models.get(r.model) ?? { model: r.model, provider: providerOf(r.model), client: s.client, sessions: 0, active: 0, usage: emptyUsage(), today: 0, keptOut: 0, savedUsd: null, peakContext: 0, contextWindow: null, sessionSet: new Set<string>(), activeSet: new Set<string>() };
        addReq(c.usage, r);
        c.sessionSet.add(s.id);
        if (working) c.activeSet.add(s.id);
        if (now.getTime() - Date.parse(r.ts) < DAY) c.today += 1;
        if (!r.agent) c.peakContext = Math.max(c.peakContext, contextOf(r));
        models.set(r.model, c);
      }
      if (k >= 0 || inRange(r.ts, range)) modelCost.set(r.model, mc);
    }
  }
  // Kept out per model: a ledger row belongs to its session's main model (or the row's own model).
  for (const [id, rs] of bySession(rows)) {
    const s = byId.get(id);
    const model = (s && mainModel(s)) || rs.find((r) => r.model)?.model;
    if (!model) continue;
    const c = models.get(model);
    if (!c) continue;
    const kept = snoutTotals(rs).keptOut;
    c.keptOut += kept;
    const rate = inputRateOf(model, inp.configDir);
    if (rate !== null && kept) c.savedUsd = (c.savedUsd ?? 0) + (kept * rate) / 1e6;
  }
  const t = snoutTotals(rows);
  const rateWeight = [...models.values()].reduce((a, c) => { const rate = inputRateOf(c.model, inp.configDir); return rate === null ? a : { w: a.w + billedInput(c.usage), s: a.s + billedInput(c.usage) * rate }; }, { w: 0, s: 0 });
  const blended = rateWeight.w ? rateWeight.s / rateWeight.w : null;
  const asked = t.keptOut + t.inContext;
  const sc = score(rows);
  const timeline = live.slice(0, 8).map((s) => {
    const rs = (bySession(rows).get(s.id) ?? []);
    const evs: Overview["timeline"][number]["events"] = [];
    for (const x of score(rs).reads) evs.push({ t: x.row.ts, kind: x.kept > 0 ? "kept" : "read" });
    for (const c of s.compactions) if (inRange(c.ts, range)) evs.push({ t: c.ts, kind: "compact" });
    for (const x of s.tools) if (x.error && inRange(x.ts, range)) evs.push({ t: x.ts, kind: "error" });
    return {
      session: s.id, client: s.client, model: mainModel(s), title: s.title || s.prompts[0]?.text.slice(0, 80) || "Session",
      start: s.first < range.from ? range.from : s.first, end: s.last, status: (now.getTime() - Date.parse(s.last) < WORKING_MS ? "working" : "idle") as "working" | "idle",
      events: evs.sort((a, b) => (a.t < b.t ? -1 : 1)).slice(-400),
    };
  });
  const executions = live.flatMap((s) => turnsOf(s).filter((x) => (x.next ?? s.last) >= range.from && x.start <= range.to)).sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, 12).map((x) => executionOf(x, rows, now));
  const files = slices(rows, (r) => (r.rule === "tool-output" || !r.path || r.path.startsWith("mcp") ? null : r.path));
  const recalls = inp.recall.filter((r) => inRange(r.ts, range));
  return {
    range,
    usage,
    snout: { reads: t.reads, inContext: t.inContext, keptOut: t.keptOut, couldKeepOut: t.couldKeepOut, events: t.events, trims: t.trims, denials: t.denials, repeats: t.repeats, repeatTokens: t.repeatTokens, outputTrims: t.outputTrims, outputTokens: t.outputTokens, overridden: t.overridden },
    reduction: asked > 0 ? t.keptOut / asked : 0,
    savedUsd: savedOf(rows, byId, inp.configDir, blended),
    inputRate: blended,
    sessions: { active: live.filter((s) => now.getTime() - Date.parse(s.last) < WORKING_MS).length, total: live.length },
    models: [...models.values()].sort((a, b) => b.usage.requests - a.usage.requests).map(({ sessionSet, activeSet, ...c }) => ({ ...c, sessions: sessionSet.size, active: activeSet.size, contextWindow: windowOf(c.model, c.peakContext) })),
    series: seriesOf(rows, live, range),
    costBy: {
      agent: [...agentCost.values()].sort((a, b) => b.costUsd - a.costUsd),
      model: [...modelCost.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8),
      periods: p.labels,
    },
    executions,
    insights: {
      topSources: slices(rows, (r) => labelOf(r.rule)).filter((x) => x.key !== "source" && x.key !== "always-allow").slice(0, 6),
      repeats: { count: t.repeats, tokens: t.repeatTokens },
      outputs: { count: t.outputTrims, tokens: t.outputTokens },
      compaction: {
        compactions: live.reduce((a, s) => a + s.compactions.filter((c) => inRange(c.ts, range)).length, 0),
        recalls: recalls.filter((r) => r.kind === "search" || r.kind === "fetch" || (!r.kind && r.cards?.length)).length,
      },
      mcp: slices([...sc.reads.map((x) => x.row), ...sc.tool], (r) => mcpServerOf(r.tool)).slice(0, 6),
    },
    timeline,
    files: { top: files.slice().sort((a, b) => b.inContext - a.inContext).slice(0, 10), held: files.filter((f) => f.keptOut > 0).slice(0, 10) },
    feed: feedOf(rows),
    activity: activityOf(inp.sessions, now),
    mode: inp.mode,
  };
}

const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Time agents spent working today and yesterday (local days): the sum of their turns' durations. */
function activityOf(sessions: SessionLog[], now: Date): Overview["activity"] {
  const today = localDay(now.getTime());
  const yesterday = localDay(now.getTime() - DAY);
  const m = new Map<string, { client: string; todayMs: number; yesterdayMs: number; turns: number }>();
  for (const s of sessions) {
    for (const t of turnsOf(s)) {
      const day = localDay(Date.parse(t.start));
      if (day !== today && day !== yesterday) continue;
      const live = !t.end && now.getTime() - Date.parse(s.last) < WORKING_MS;
      const ms = live ? now.getTime() - Date.parse(t.start) : t.durationMs ?? 0;
      if (ms <= 0 || ms > DAY) continue;
      const a = m.get(s.client) ?? { client: s.client, todayMs: 0, yesterdayMs: 0, turns: 0 };
      if (day === today) {
        a.todayMs += ms;
        a.turns += 1;
      } else a.yesterdayMs += ms;
      m.set(s.client, a);
    }
  }
  const total = [...m.values()].reduce((x, a) => x + a.todayMs, 0);
  return [...m.values()].map((a) => ({ ...a, share: total ? a.todayMs / total : 0 })).sort((a, b) => b.todayMs - a.todayMs);
}

// ---------------------------------------------------------------- agents

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI" };

export function agents(inp: Inputs, range: RangeInfo, installed: Record<string, boolean>): AgentCard[] {
  const now = inp.now ?? new Date();
  const rows = inp.rows.filter((r) => inRange(r.ts, range));
  const byId = new Map(inp.sessions.map((s) => [s.id, s]));
  const cards = new Map<string, AgentCard>();
  const card = (key: string, client: string, role: string): AgentCard => {
    let c = cards.get(key);
    if (!c) {
      c = { key, client, name: role === "main" ? AGENT_NAMES[client] ?? client : role, role, models: [], status: role === "main" && installed[client] ? "connected" : "idle", task: "", sessions: 0, turns: 0, toolCalls: 0, usage: emptyUsage(), keptOut: 0, savedUsd: null, last: null, environment: "", errors: 0, warnings: [], tools: [], mcp: [] };
      cards.set(key, c);
    }
    return c;
  };
  for (const client of Object.keys(installed)) if (installed[client]) card(client, client, "main");
  // Sessions per card: any session where that agent made a request, ran a tool or met Snout.
  const seen = new Map<string, Set<string>>();
  const saw = (key: string, session: string) => seen.set(key, (seen.get(key) ?? new Set<string>()).add(session));
  const toolCount = new Map<string, Map<string, number>>();
  for (const s of inp.sessions) {
    if (s.last < range.from || s.first > range.to) continue;
    const c = card(s.client, s.client, "main");
    const working = now.getTime() - Date.parse(s.last) < WORKING_MS;
    c.sessions += 1;
    c.turns += s.prompts.filter((x) => inRange(x.ts, range)).length;
    if (!c.last || s.last > c.last) {
      c.last = s.last;
      c.task = s.prompts.at(-1)?.text ?? s.title;
      c.environment = environmentOf(s);
    }
    if (working) c.status = "working";
    else if (c.status !== "working") c.status = "idle";
    const subTypes = new Map(s.subagents.map((a) => [a.id, a.type]));
    for (const r of s.requests) {
      if (!inRange(r.ts, range)) continue;
      const target = r.agent ? card(`${s.client}:${subTypes.get(r.agent) ?? "subagent"}`, s.client, subTypes.get(r.agent) ?? "subagent") : c;
      addReq(target.usage, r);
      saw(target.key, s.id);
      if (!target.models.includes(r.model)) target.models.push(r.model);
      if (r.agent && (!target.last || r.ts > target.last)) target.last = r.ts;
    }
    for (const x of s.tools) {
      if (!inRange(x.ts, range)) continue;
      const key = x.agent ? `${s.client}:${subTypes.get(x.agent) ?? "subagent"}` : s.client;
      const target = x.agent ? card(key, s.client, subTypes.get(x.agent) ?? "subagent") : c;
      target.toolCalls += 1;
      saw(target.key, s.id);
      if (x.error) target.errors += 1;
      const tc = toolCount.get(key) ?? new Map<string, number>();
      tc.set(x.name, (tc.get(x.name) ?? 0) + 1);
      toolCount.set(key, tc);
      const server = mcpServerOf(x.name);
      if (server && !target.mcp.includes(server)) target.mcp.push(server);
    }
    for (const sub of s.subagents) {
      if (sub.last < range.from) continue;
      const sc = card(`${s.client}:${sub.type}`, s.client, sub.type);
      saw(sc.key, s.id);
      sc.status = now.getTime() - Date.parse(sub.last) < WORKING_MS ? "working" : "idle";
    }
  }
  for (const [id, rs] of bySession(rows)) {
    const s = byId.get(id);
    for (const r of rs) {
      const client = r.client ?? s?.client ?? "claude";
      const key = r.agentId ? `${client}:${r.agentType ?? "subagent"}` : client;
      const c = cards.get(key) ?? card(key, client, r.agentId ? r.agentType ?? "subagent" : "main");
      saw(key, id);
      if (!c.last || r.ts > c.last) c.last = r.ts;
    }
    const perAgent = new Map<string, DecisionRow[]>();
    for (const r of rs) {
      const client = r.client ?? s?.client ?? "claude";
      const key = r.agentId ? `${client}:${r.agentType ?? "subagent"}` : client;
      perAgent.set(key, [...(perAgent.get(key) ?? []), r]);
    }
    for (const [key, list] of perAgent) {
      const c = cards.get(key)!;
      const kept = snoutTotals(list).keptOut;
      c.keptOut += kept;
      const model = (s && mainModel(s)) || list.find((r) => r.model)?.model || "";
      const rate = model ? inputRateOf(model, inp.configDir) : null;
      if (rate !== null && kept) c.savedUsd = (c.savedUsd ?? 0) + (kept * rate) / 1e6;
    }
  }
  for (const [key, c] of cards) {
    if (c.role !== "main") c.sessions = seen.get(key)?.size ?? 0;
    c.tools = [...(toolCount.get(key) ?? new Map<string, number>()).entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls).slice(0, 10);
    if (c.errors) c.warnings.push(`${c.errors} tool call${c.errors === 1 ? "" : "s"} returned an error`);
    if (c.usage.unpriced) c.warnings.push(`${c.usage.unpriced} request${c.usage.unpriced === 1 ? "" : "s"} on a model with no known price`);
    if (installed[c.client] === false && c.role === "main" && c.sessions) c.warnings.push("Snout's hooks are not set up for this agent in this project");
  }
  return [...cards.values()].sort((a, b) => (a.role === "main" ? 0 : 1) - (b.role === "main" ? 0 : 1) || (b.last ?? "").localeCompare(a.last ?? ""));
}

// ---------------------------------------------------------------- one session

export function sessionDetail(inp: Inputs, id: string): SessionDetail | null {
  const s = inp.sessions.find((x) => x.id === id);
  if (!s) return null;
  const now = inp.now ?? new Date();
  const rows = inp.rows.filter((r) => r.session === id);
  const tools = new Map<string, { name: string; calls: number; errors: number; resultBytes: number }>();
  for (const x of s.tools) {
    const t = tools.get(x.name) ?? { name: x.name, calls: 0, errors: 0, resultBytes: 0 };
    t.calls += 1;
    if (x.error) t.errors += 1;
    t.resultBytes += x.resultBytes;
    tools.set(x.name, t);
  }
  return {
    session: sessionRow(s, rows, now, inp.configDir),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    files: slices(rows, (r) => (r.rule === "tool-output" ? null : r.path || null)).slice(0, 40),
    timeline: s.requests.filter((r) => !r.agent).map((r) => ({ t: r.ts, context: contextOf(r), output: r.output, costUsd: r.costUsd ?? 0 })),
    compactions: s.compactions,
    turns: turnsOf(s).map((t) => turnInfo(t, rows)),
    feed: feedOf(rows, 200),
    passed: passedOf(rows),
  };
}

const INSTRUCTIONS = /(^|[\\/])\.(claude|codex|cursor|gemini)[\\/]|(^|[\\/])(CLAUDE|AGENTS|GEMINI|SKILL)(\.local)?\.md$/i;

/** Why a read reached the agent whole: the gate's rule, in words. Source code is never trimmed. */
function whyPassed(r: DecisionRow): string {
  if (r.rule === "tool-output") return "Tool output under the trim size";
  if (r.rule === "always-allow") return "On your always-read list";
  if (r.rule === "binary") return "Images the agent looked at";
  if (r.range && r.range !== ":") return "Ranged reads (already a slice)";
  if (INSTRUCTIONS.test(r.path || "")) return "Instructions and skills, read in full";
  if (r.rule === "unclassified") return "Source and other files, never trimmed";
  return labelOf(r.rule);
}

function passedOf(rows: DecisionRow[]): SessionDetail["passed"] {
  const m = new Map<string, { why: string; count: number; tokens: number }>();
  const s = score(rows);
  const add = (r: DecisionRow) => {
    const why = whyPassed(r);
    const g = m.get(why) ?? { why, count: 0, tokens: 0 };
    g.count += 1;
    g.tokens += r.tokensReadEst || 0;
    m.set(why, g);
  };
  for (const x of s.reads) if (!x.acted) add(x.row);
  for (const r of s.tool) add(r);
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}

function turnInfo(t: TurnSpan, rows: DecisionRow[]): TraceTurn {
  const reqs = t.session.requests.filter((r) => within(r.ts, t.start, t.next));
  const u = reqs.reduce(addReq, emptyUsage());
  return {
    n: t.n, prompt: t.prompt, start: t.start, end: t.end, nodes: 0, tokens: totalTokens(u), costUsd: u.costUsd,
    keptOut: snoutTotals(rows.filter((r) => within(r.ts, t.start, t.next))).keptOut,
    // Every tool call passes Snout's hooks when Snout is on for the session (it has ledger rows).
    checked: rows.length ? t.session.tools.filter((x) => within(x.ts, t.start, t.next)).length : 0,
    compacted: t.session.compactions.some((c) => within(c.ts, t.start, t.next)),
    durationMs: t.durationMs,
  };
}

// ---------------------------------------------------------------- trace

const MAX_NODES = 1600;
/** A Snout decision belongs to a tool call made up to this long before it, or finished up to this long after. */
const MATCH_MS = 4000;

function toolKind(name: string): TraceNode["kind"] {
  const n = name.toLowerCase();
  if (n.startsWith("mcp__")) return "mcp";
  if (n === "read" || n === "notebookread" || n === "view") return "read";
  if (n === "grep" || n === "glob" || n === "ls" || n === "search") return "search";
  if (n === "bash" || n === "shell" || n === "exec" || n === "powershell" || n === "exec_command" || n === "local_shell") return "shell";
  if (n === "webfetch" || n === "websearch" || n.startsWith("web")) return "web";
  if (n === "edit" || n === "write" || n === "multiedit" || n === "notebookedit" || n === "apply_patch") return "edit";
  if (n === "task" || n === "agent") return "subagent";
  return "tool";
}

function decisionKind(x: Scored): TraceNode["kind"] | null {
  const r = x.row;
  if (REPEAT_RULES.has(r.rule) && x.acted) return "repeat";
  if (OUTPUT_RULES.has(r.rule) && x.acted) return "output-trim";
  if (x.acted && r.trimmed) return "trimmed";
  if (x.acted && r.decision === "ask") return "asked";
  if (x.acted) return "kept";
  if (x.could > 0) return "would";
  return null;
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
function samePath(target: string, path: string): boolean {
  if (!target || !path) return false;
  const a = norm(target);
  const b = norm(path);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`) || a.includes(b);
}

/** Turns shown by default: the latest few, so a long session opens fast and readable. */
export const TRACE_TURNS = 6;

export function trace(inp: Inputs, id: string, win: { from?: number; to?: number } = {}): Trace | null {
  const s = inp.sessions.find((x) => x.id === id);
  if (!s) return null;
  const now = inp.now ?? new Date();
  const rows = inp.rows.filter((r) => r.session === id);
  const scored = score(rows).reads;
  const used = new Set<Scored>();
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  let truncated = 0;
  const node = (n: Omit<TraceNode, "id"> & { id?: string }): TraceNode => {
    const full = { ...n, id: n.id ?? `n${nodes.length}` } as TraceNode;
    if (nodes.length >= MAX_NODES) {
      truncated += 1;
      return full;
    }
    nodes.push(full);
    return full;
  };
  const edge = (from: TraceNode | null, to: TraceNode, kind: TraceEdge["kind"] = "flow") => {
    if (from && nodes.includes(from) && nodes.includes(to)) edges.push({ from: from.id, to: to.id, kind });
  };
  const base = { endTs: null, tokens: 0, keptOut: 0, costUsd: null, model: null, agent: null, path: null, rule: null, reason: null, bytes: null, parent: null } as const;
  const recall = inp.recall.filter((r) => r.session === id);
  const subTypes = new Map(s.subagents.map((a) => [a.id, a.type]));

  const start = node({ ...base, kind: "start", label: s.client === "codex" ? "Codex session" : "Claude Code session", detail: [s.surface, s.version && `v${s.version}`, s.branch && `on ${s.branch}`].filter(Boolean).join(" · "), ts: s.first, status: "completed", turn: 0 });
  let prev: TraceNode = start;
  // The session-start line that earlier sessions exist (or, from older versions, a repo brief).
  const brief = recall.find((r) => r.kind === "hint" || r.kind === "brief");
  if (brief) {
    const detail = brief.kind === "hint" ? `One line: earlier sessions are on record and how to search them${brief.unfinished ? "; one left work unfinished" : ""}` : "What earlier sessions found, added at session start";
    const b = node({ ...base, kind: "brief", label: brief.kind === "hint" ? "Memory pointer" : "Repo brief", detail, ts: brief.ts, status: "completed", turn: 0, tokens: brief.tokensEst });
    edge(prev, b);
    prev = b;
  }

  const turns = turnsOf(s);
  const turnInfos: TraceTurn[] = [];
  const to = Math.min(win.to ?? turns.length, turns.length);
  const from = Math.max(1, win.from ?? to - TRACE_TURNS + 1);
  const decisionsFor = (t: ToolRec): Scored[] => {
    const from = Date.parse(t.ts) - 1000;
    const to = Date.parse(t.endTs ?? t.ts) + MATCH_MS;
    const cands = scored.filter((x) => !used.has(x) && (x.row.agentId ?? undefined) === (t.agent === "sidechain" ? undefined : t.agent) && Date.parse(x.row.ts) >= from && Date.parse(x.row.ts) <= to);
    const byPath = cands.filter((x) => samePath(t.target, x.row.path));
    const pick = byPath.length ? byPath : cands.filter((x) => x.row.tool === t.name).slice(0, 1);
    for (const x of pick) used.add(x);
    return pick;
  };

  for (const t of turns) {
    const info = turnInfo(t, rows);
    if (t.n < from || t.n > to) {
      turnInfos.push(info);
      continue;
    }
    const startCount = nodes.length;
    const p = node({ ...base, kind: "prompt", label: `Prompt ${t.n}`, detail: t.prompt, ts: t.start, status: "completed", turn: t.n });
    edge(prev, p);
    prev = p;
    // The agent's searches and fetches (Snout's MCP server logs them against the session its hooks saw last), and older automatic recalls.
    for (const r of recall.filter((r) => ((r.kind === "search" || r.kind === "fetch") || (!r.kind && r.cards?.length)) && within(r.ts, t.start, t.next))) {
      const [label, detail] = r.kind === "search" ? ["Memory search", `"${r.asked ?? ""}": ${r.shown?.length ? `${r.shown.length} record${r.shown.length === 1 ? "" : "s"} shown` : "nothing found"}`]
        : r.kind === "fetch" ? ["Memory fetch", r.missed ? `${r.asked ?? ""}: not found` : `Opened ${r.asked ?? ""}`]
        : ["Memory recall", `${r.cards!.length} earlier session${r.cards!.length === 1 ? "" : "s"} brought back`];
      const rc = node({ ...base, kind: "recall", label, detail, ts: r.ts, status: "completed", turn: t.n, tokens: r.tokensEst });
      edge(prev, rc);
      prev = rc;
    }
    const reqs = s.requests.filter((r) => !r.agent && within(r.ts, t.start, t.next));
    const tools = s.tools.filter((x) => within(x.ts, t.start, t.next));
    const compactions = s.compactions.filter((c) => within(c.ts, t.start, t.next));
    let pendingTools: TraceNode[] = [];
    let ci = 0;
    const flushCompactions = (before: string | null) => {
      while (ci < compactions.length && (!before || compactions[ci]!.ts <= before)) {
        const c = compactions[ci++]!;
        const cn = node({ ...base, kind: "compact", label: "Compaction", detail: c.preTokens ? `${c.trigger}: ${c.preTokens.toLocaleString()} → ${(c.postTokens ?? 0).toLocaleString()} tokens` : c.trigger, ts: c.ts, status: "completed", turn: t.n, tokens: c.preTokens ?? 0 });
        for (const x of pendingTools) edge(x, cn, "merge");
        if (!pendingTools.length) edge(prev, cn);
        pendingTools = [];
        prev = cn;
      }
    };
    reqs.forEach((r, i) => {
      flushCompactions(r.ts);
      const nextTs = reqs[i + 1]?.ts ?? t.next;
      const mine = tools.filter((x) => !x.agent && x.ts >= r.ts && (!nextTs || x.ts < nextTs));
      const isLast = i === reqs.length - 1;
      const rn = node({
        ...base, kind: mine.length || !isLast ? "request" : "response", label: mine.length || !isLast ? "Model request" : "Response", detail: r.model,
        ts: r.ts, status: "completed", turn: t.n, tokens: contextOf(r) + r.output, costUsd: r.costUsd, model: r.model, bytes: null,
        reason: `${contextOf(r).toLocaleString()} in (${r.cacheRead.toLocaleString()} cached) · ${r.output.toLocaleString()} out`,
      });
      for (const x of pendingTools) edge(x, rn, "merge");
      if (!pendingTools.length) edge(prev, rn);
      pendingTools = [];
      prev = rn;
      for (const x of mine) {
        const kind = toolKind(x.name);
        const sub = kind === "subagent" ? s.subagents.find((a) => a.first >= x.ts && (!x.endTs || a.first <= x.endTs)) : undefined;
        const subReqs = sub ? s.requests.filter((q) => q.agent === sub.id) : [];
        const subCost = subReqs.reduce((a, q) => a + (q.costUsd ?? 0), 0);
        const tn = node({
          ...base, kind, label: kind === "subagent" ? `Subagent${sub ? ` · ${subTypes.get(sub.id) ?? sub.type}` : ""}` : x.name, detail: x.target,
          ts: x.ts, endTs: x.endTs ?? null, status: !x.endTs ? (now.getTime() - Date.parse(s.last) < WORKING_MS ? "running" : "completed") : x.error ? "failed" : "completed",
          turn: t.n, parent: rn.id, bytes: x.resultBytes, path: kind === "read" || kind === "edit" ? x.target : null,
          ...(sub ? { tokens: subReqs.reduce((a, q) => a + contextOf(q) + q.output, 0), costUsd: subCost, agent: sub.id, reason: `${subReqs.length} requests · ${s.tools.filter((q) => q.agent === sub.id).length} tool calls` } : {}),
        });
        edge(rn, tn, "branch");
        let tail = tn;
        const ds = decisionsFor(x);
        if (sub) ds.push(...scored.filter((d) => !used.has(d) && d.row.agentId === sub.id).map((d) => (used.add(d), d)));
        for (const d of ds) {
          tn.tokens = sub ? tn.tokens : d.reached;
          const k = decisionKind(d);
          if (!k) continue;
          tn.status = tn.status === "failed" ? "failed" : "optimized";
          const dn = node({
            ...base, kind: k, label: DECISION_LABEL[k] ?? k, detail: d.row.path, ts: d.row.ts, status: k === "would" ? "skipped" : "optimized", turn: t.n, parent: tn.id,
            tokens: d.reached, keptOut: d.kept || d.could, path: d.row.path, rule: labelOf(d.row.rule), reason: d.row.reason?.slice(0, 400) || null, bytes: d.row.bytes, agent: d.row.agentId ?? null,
          });
          edge(tail, dn, "snout");
          tail = dn;
        }
        pendingTools.push(tail);
      }
    });
    flushCompactions(null);
    if (t.end && t.end !== t.next) {
      const end = node({ ...base, kind: "end", label: "Turn complete", detail: info.durationMs ? `${Math.round(info.durationMs / 1000)}s` : "", ts: t.end, status: "completed", turn: t.n } as never);
      for (const x of pendingTools) edge(x, end, "merge");
      if (!pendingTools.length) edge(prev, end);
      pendingTools = [];
      prev = end;
    } else if (pendingTools.length) {
      prev = pendingTools.at(-1)!;
    }
    turnInfos.push({ ...info, nodes: nodes.length - startCount });
  }
  return { session: sessionRow(s, rows, now, inp.configDir), turns: turnInfos, window: { from, to }, nodes, edges, truncated };
}

const DECISION_LABEL: Partial<Record<TraceNode["kind"], string>> = {
  kept: "Kept out of context", trimmed: "Trimmed to its head", repeat: "Repeat read: pointer", would: "Would keep out (observe)", asked: "Asked first", "output-trim": "Output shortened",
};

// ---------------------------------------------------------------- analytics

export function analytics(inp: Inputs, range: RangeInfo): Analytics {
  const rows = inp.rows.filter((r) => inRange(r.ts, range));
  const live = inp.sessions.filter((s) => s.last >= range.from && s.first <= range.to);
  const per = bySession(rows);
  const group = (key: (s: SessionLog, r: RequestRec) => string) => {
    const m = new Map<string, { key: string; usage: Usage; keptOut: number; sessions: Set<string> }>();
    for (const s of live) for (const r of s.requests) {
      if (!inRange(r.ts, range)) continue;
      const k = key(s, r);
      const g = m.get(k) ?? { key: k, usage: emptyUsage(), keptOut: 0, sessions: new Set<string>() };
      addReq(g.usage, r);
      g.sessions.add(s.id);
      m.set(k, g);
    }
    return m;
  };
  const byModel = group((_s, r) => r.model);
  const byAgent = group((s) => s.client);
  for (const s of live) {
    const kept = snoutTotals(per.get(s.id) ?? []).keptOut;
    byModel.get(mainModel(s))?.keptOut !== undefined && (byModel.get(mainModel(s))!.keptOut += kept);
    if (byAgent.get(s.client)) byAgent.get(s.client)!.keptOut += kept;
  }
  const flat = (m: typeof byModel) => [...m.values()].map((g) => ({ key: g.key, usage: g.usage, keptOut: g.keptOut, sessions: g.sessions.size })).sort((a, b) => b.usage.costUsd - a.usage.costUsd);
  const t = snoutTotals(rows);
  const recalls = inp.recall.filter((r) => inRange(r.ts, range));
  return {
    range,
    series: seriesOf(rows, live, range),
    byModel: flat(byModel),
    byAgent: flat(byAgent),
    composition: slices(rows, (r) => (r.rule === "tool-output" ? (mcpServerOf(r.tool) ? "mcp result" : "tool output") : labelOf(r.rule))),
    growth: live.slice(0, 6).map((s) => {
      const main = s.requests.filter((r) => !r.agent);
      const step = Math.max(1, Math.ceil(main.length / 160));
      return {
        session: s.id, title: s.title || s.prompts[0]?.text.slice(0, 60) || "Session",
        points: main.filter((_r, i) => i % step === 0 || i === main.length - 1).map((r) => ({ i: main.indexOf(r), context: contextOf(r) })),
        compactions: s.compactions.map((c) => main.findIndex((r) => r.ts >= c.ts)).filter((i) => i >= 0),
      };
    }),
    retention: {
      compactions: live.reduce((a, s) => a + s.compactions.filter((c) => inRange(c.ts, range)).length, 0),
      hints: recalls.filter((r) => r.kind === "hint").length,
      searches: recalls.filter((r) => r.kind === "search").length,
      opened: recalls.filter((r) => r.kind === "fetch" && !r.missed).length,
      notesShown: recalls.filter((r) => r.kind === "inject" && r.injected).length,
    },
    files: slices(rows, (r) => (r.rule === "tool-output" || !r.path ? null : r.path)).slice(0, 15),
    turns: live.flatMap((s) => turnsOf(s).filter((x) => inRange(x.start, range)).map((x) => {
      const reqs = s.requests.filter((r) => within(r.ts, x.start, x.next));
      const u = reqs.reduce(addReq, emptyUsage());
      return { session: s.id, prompt: x.prompt, tokens: totalTokens(u), costUsd: u.costUsd, keptOut: snoutTotals((per.get(s.id) ?? []).filter((r) => within(r.ts, x.start, x.next))).keptOut, durationMs: x.durationMs };
    })).sort((a, b) => b.costUsd - a.costUsd).slice(0, 20),
    repeats: { count: t.repeats, tokens: t.repeatTokens },
    crossAgent: (() => { const r = redundancyOf(score(rows).reads.map((x) => x.row)); return { count: r.repeats.size, tokens: r.tokens, comparable: r.comparable, top: r.top.slice(0, 8) }; })(),
  };
}
