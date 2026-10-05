/**
 * What the dashboard shows, computed from ledger rows. Pure, so the numbers on the page are
 * the numbers a test can pin; the server only decides when to recompute.
 *
 * Every token figure is an estimate derived from byte length, like the report's.
 */
import type { DecisionRow } from "../types.js";
import { agentLabel, harnessOf, percentile, redundancyOf } from "../ledger/report.js";

export interface Slice {
  key: string;
  reads: number;
  /** Tokens that reached the agent's context. */
  inContext: number;
  /** Tokens the gate kept out: denied, or cut from a trimmed read, and not overridden. */
  heldBack: number;
}

export interface FeedRow {
  ts: string;
  client: string;
  agent: string;
  tool: string;
  path: string;
  rule: string;
  outcome: "read" | "trimmed" | "held back" | "asked" | "would hold back";
  inContext: number;
  heldBack: number;
  reason: string;
}

/** One row of the with/without chart, with what the detail card needs. */
export interface FileDetail extends Slice {
  label: string;
  /** The last reason the gate gave for this file, or "" when it was always read in full. */
  reason: string;
  trimmed: number;
  last: string;
  history: FeedRow[];
}

export interface DashboardSummary {
  generatedAt: string;
  rows: number;
  reads: number;
  /** Reads the gate acted on (asked, denied or trimmed). */
  gated: number;
  overridden: number;
  inContext: number;
  heldBack: number;
  /** Flagged tokens that went through because the mode only observes. */
  couldHoldBack: number;
  /** Grep, Glob, web and MCP output: measured, never classified. */
  toolOutput: number;
  /** Tokens from reads another agent in the session had already made. */
  repeated: number;
  /** heldBack as a share of everything agents asked to read. */
  savedShare: number;
  latency: { p50: number; p95: number };
  byLabel: Slice[];
  byClient: Slice[];
  byAgent: Slice[];
  /** Savings and reads per model (the session's model); "unknown" before models were recorded. */
  byModel: Slice[];
  /** Per MCP server: calls (reads), what reached context, and what trimming or repeat skips saved. */
  byMcpServer: Slice[];
  topHeld: Slice[];
  topRead: Slice[];
  /** The chart: files the gate held back most, then the largest full reads, up to CHART_FILES. */
  files: FileDetail[];
  mode?: string;
  sessions: (Slice & { first: string; last: string; clients: string[] })[];
  /** Cumulative inContext and heldBack over time, at most TIMELINE_POINTS points. */
  timeline: { ts: string; inContext: number; heldBack: number }[];
  recent: FeedRow[];
  /** Today (UTC, the same day boundary as spend), for the live band. */
  today: { day: string; reads: number; inContext: number; heldBack: number };
  /** The last DAILY_DAYS days, oldest first, every day present (zeros included). */
  daily: { day: string; reads: number; inContext: number; heldBack: number }[];
}

const TIMELINE_POINTS = 240;
const FEED = 60;
const CHART_FILES = 8;
const HISTORY = 6;
const DAILY_DAYS = 14;

const isFlagged = (r: DecisionRow): boolean => r.value <= 1 && r.rule !== "unclassified";
const clientOf = (r: DecisionRow): string => r.client ?? "claude";
const agentOf = (r: DecisionRow): string => agentLabel({ agentId: r.agentId, agentType: r.agentType });

/** Rows whose rule names a label the user knows; the rest group under what the rule is. */
const RULE_LABEL: Record<string, string> = { "binary-content": "binary", unclassified: "source" };
const labelOfRule = (rule: string): string => RULE_LABEL[rule] ?? rule;

function bump(m: Map<string, Slice>, key: string, inContext: number, heldBack: number): Slice {
  const s = m.get(key) ?? { key, reads: 0, inContext: 0, heldBack: 0 };
  s.reads += 1;
  s.inContext += inContext;
  s.heldBack += heldBack;
  m.set(key, s);
  return s;
}

/** "mcp__github__list_issues" → "github"; null for tools that are not MCP. */
export function mcpServerOf(tool: string | undefined): string | null {
  if (!tool || !tool.startsWith("mcp__")) return null;
  return tool.split("__")[1] || null;
}

/** MCP results reach context either measured (tool-output) or trimmed/skipped (gated rows). */
function mcpSlices(rows: DecisionRow[], overridden: Set<DecisionRow>): Map<string, Slice> {
  const m = new Map<string, Slice>();
  for (const r of rows) {
    const server = mcpServerOf(r.tool);
    if (!server) continue;
    const held = r.rule === "tool-output" || overridden.has(r) ? 0 : r.tokensAvoidedEst || 0;
    bump(m, server, r.tokensReadEst || 0, held);
  }
  return m;
}

const byHeld = (a: Slice, b: Slice) => b.heldBack - a.heldBack || b.inContext - a.inContext;

export function summarizeLedger(rows: DecisionRow[], now = new Date()): DashboardSummary {
  const h = harnessOf(rows);
  const overridden = new Set(h.overridden);
  const labels = new Map<string, Slice>();
  const clients = new Map<string, Slice>();
  const files = new Map<string, Slice>();
  const agents = new Map<string, Slice>();
  const models = new Map<string, Slice>();
  const details = new Map<string, { label: string; reason: string; trimmed: number; last: string; history: FeedRow[] }>();
  const sessions = new Map<string, Slice & { first: string; last: string; clients: string[] }>();
  const timeline: DashboardSummary["timeline"] = [];
  const feed: FeedRow[] = [];
  let inContext = 0;
  let heldBack = 0;
  let couldHoldBack = 0;
  let gated = 0;
  const day = now.toISOString().slice(0, 10);
  const today = { day, reads: 0, inContext: 0, heldBack: 0 };
  const daily = new Map<string, { day: string; reads: number; inContext: number; heldBack: number }>();
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const k = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    daily.set(k, { day: k, reads: 0, inContext: 0, heldBack: 0 });
  }

  for (const r of h.reads) {
    const acted = r.decision !== "allow" && !r.observedOnly;
    const held = acted && !overridden.has(r) ? r.tokensAvoidedEst || 0 : 0;
    const reached = r.decision === "allow" || r.observedOnly || r.trimmed || overridden.has(r);
    const read = reached ? r.tokensReadEst || 0 : 0;
    if (acted) gated += 1;
    if (r.observedOnly && isFlagged(r)) couldHoldBack += r.tokensAvoidedEst || 0;
    inContext += read;
    heldBack += held;
    const dd = daily.get(r.ts.slice(0, 10));
    if (dd) {
      dd.reads += 1;
      dd.inContext += read;
      dd.heldBack += held;
    }
    if (r.ts.startsWith(day)) {
      today.reads += 1;
      today.inContext += read;
      today.heldBack += held;
    }

    bump(labels, labelOfRule(r.rule), read, held);
    bump(clients, clientOf(r), read, held);
    bump(files, r.path, read, held);
    bump(agents, agentOf(r), read, held);
    bump(models, r.model || "unknown", read, held);
    const s = sessions.get(r.session) ?? { key: r.session, reads: 0, inContext: 0, heldBack: 0, first: r.ts, last: r.ts, clients: [] };
    sessions.set(r.session, s);
    bump(sessions, r.session, read, held);
    if (r.ts < s.first) s.first = r.ts;
    if (r.ts > s.last) s.last = r.ts;
    if (!s.clients.includes(clientOf(r))) s.clients.push(clientOf(r));
    timeline.push({ ts: r.ts, inContext, heldBack });

    const row: FeedRow = {
      ts: r.ts,
      client: clientOf(r),
      agent: agentOf(r),
      tool: r.tool,
      path: r.path,
      rule: labelOfRule(r.rule),
      outcome: r.trimmed ? "trimmed" : acted ? (r.decision === "ask" ? "asked" : "held back") : r.observedOnly && isFlagged(r) ? "would hold back" : "read",
      inContext: read,
      heldBack: held,
      reason: r.reason.slice(0, 240),
    };
    feed.push(row);
    const d = details.get(r.path) ?? { label: labelOfRule(r.rule), reason: "", trimmed: 0, last: r.ts, history: [] };
    if (isFlagged(r) || d.label === "source") d.label = labelOfRule(r.rule);
    if (row.outcome !== "read") d.reason = row.reason;
    if (r.trimmed) d.trimmed += 1;
    if (r.ts > d.last) d.last = r.ts;
    d.history.push(row);
    if (d.history.length > HISTORY) d.history.shift();
    details.set(r.path, d);
  }

  const toolOutput = h.toolOutput.reduce((a, r) => a + (r.tokensReadEst || 0), 0);
  const red = redundancyOf(h.reads);
  const asked = inContext + heldBack + toolOutput;
  const sliceFiles = [...files.values()];
  const held = sliceFiles.filter((f) => f.heldBack > 0).sort(byHeld).slice(0, CHART_FILES);
  const full = sliceFiles.filter((f) => f.heldBack === 0 && f.inContext > 0).sort((a, b) => b.inContext - a.inContext);
  const chart = [...held, ...full.slice(0, Math.max(held.length ? 2 : CHART_FILES, CHART_FILES - held.length))].slice(0, CHART_FILES);

  return {
    generatedAt: now.toISOString(),
    rows: rows.length,
    reads: h.reads.length,
    gated,
    overridden: overridden.size,
    inContext,
    heldBack,
    couldHoldBack,
    toolOutput,
    repeated: red.tokens,
    savedShare: asked > 0 ? heldBack / asked : 0,
    latency: { p50: percentile(h.reads.map((r) => r.latencyMs || 0), 50), p95: percentile(h.reads.map((r) => r.latencyMs || 0), 95) },
    byLabel: [...labels.values()].sort(byHeld),
    byClient: [...clients.values()].sort(byHeld),
    byAgent: [...agents.values()].sort(byHeld).slice(0, 12),
    byModel: [...models.values()].sort(byHeld),
    byMcpServer: [...mcpSlices([...h.reads, ...h.toolOutput], overridden).values()].sort(byHeld),
    topHeld: sliceFiles.filter((f) => f.heldBack > 0).sort(byHeld).slice(0, 10),
    topRead: sliceFiles.filter((f) => f.inContext > 0).sort((a, b) => b.inContext - a.inContext).slice(0, 10),
    files: chart.map((f) => {
      const d = details.get(f.key)!;
      return { ...f, label: d.label, reason: d.reason, trimmed: d.trimmed, last: d.last, history: d.history.slice().reverse() };
    }),
    sessions: [...sessions.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 20),
    timeline: thin(timeline, TIMELINE_POINTS),
    recent: feed.slice(-FEED).reverse(),
    today,
    daily: [...daily.values()],
  };
}

/** Evenly spaced points, always keeping the last so the chart ends at the current total. */
function thin<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(xs[Math.floor(i * step)]!);
  out.push(xs[xs.length - 1]!);
  return out;
}

/** One day of one project's usage for one coding agent and label: what `snout sync` sends. */
export interface DayRow {
  day: string;
  client: string;
  /** The session's model; empty before models were recorded. */
  model: string;
  label: string;
  reads: number;
  gated: number;
  inContext: number;
  heldBack: number;
  couldHoldBack: number;
}

/**
 * Per-day totals, with the dashboard's accounting. Totals rather than events, so a re-sync
 * replaces a day instead of adding to it, and nothing about a file but its label leaves.
 */
export function dailyAggregates(rows: DecisionRow[], sinceDay = ""): DayRow[] {
  const h = harnessOf(rows);
  const overridden = new Set(h.overridden);
  const m = new Map<string, DayRow>();
  for (const r of h.reads) {
    const day = r.ts.slice(0, 10);
    if (day < sinceDay) continue;
    const acted = r.decision !== "allow" && !r.observedOnly;
    const held = acted && !overridden.has(r) ? r.tokensAvoidedEst || 0 : 0;
    const reached = r.decision === "allow" || r.observedOnly || r.trimmed || overridden.has(r);
    const client = clientOf(r);
    const server = mcpServerOf(r.tool);
    const label = server ? mcpLabel(server) : labelOfRule(r.rule);
    const model = (r.model || "").slice(0, 64);
    const key = `${day}\0${client}\0${model}\0${label}`;
    const d = m.get(key) ?? { day, client, model, label, reads: 0, gated: 0, inContext: 0, heldBack: 0, couldHoldBack: 0 };
    d.reads += 1;
    if (acted) d.gated += 1;
    d.inContext += reached ? r.tokensReadEst || 0 : 0;
    d.heldBack += held;
    if (r.observedOnly && isFlagged(r)) d.couldHoldBack += r.tokensAvoidedEst || 0;
    m.set(key, d);
  }
  // Untrimmed MCP results are measured, not gated; they still count toward their server.
  for (const r of h.toolOutput) {
    const server = mcpServerOf(r.tool);
    const day = r.ts.slice(0, 10);
    if (!server || day < sinceDay) continue;
    const client = clientOf(r);
    const model = (r.model || "").slice(0, 64);
    const label = mcpLabel(server);
    const key = `${day}\0${client}\0${model}\0${label}`;
    const d = m.get(key) ?? { day, client, model, label, reads: 0, gated: 0, inContext: 0, heldBack: 0, couldHoldBack: 0 };
    d.reads += 1;
    d.inContext += r.tokensReadEst || 0;
    m.set(key, d);
  }
  return [...m.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** The label an MCP server's rows sync under: "mcp-" plus a slug the cloud accepts (≤32 chars). */
export const mcpLabel = (server: string) => `mcp-${server.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "server"}`;
