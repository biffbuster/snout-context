/**
 * Spend as the dashboard and `snout spend` show it: totals, by model and agent, per day, and
 * the blended input rate that turns tokens held back into dollars.
 */
import { priceOf, modelKey } from "./prices.js";
import type { SpendRow } from "./usage.js";

export interface SpendSlice {
  key: string;
  requests: number;
  tokens: number;
  costUsd: number;
  input: number;
  output: number;
  /** The coding agent with the most requests for this slice (for a model: who ran it). */
  client: string;
  /** Today (UTC) and the last 7 days, for the dashboard's model cards and cost table. */
  today: { requests: number; tokens: number; costUsd: number };
  weekCostUsd: number;
}

export interface SpendSummary {
  requests: number;
  /** All tokens billed: uncached input, cache writes, cache reads, output. */
  tokens: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  costUsd: number;
  /** Models seen with no known price; their tokens count, their cost does not. */
  unpriced: string[];
  /** USD per million input tokens, weighted by each model's input volume. */
  inputRate: number;
  byModel: SpendSlice[];
  byClient: SpendSlice[];
  series: { day: string; costUsd: number; tokens: number }[];
}

const tokensOf = (r: SpendRow) => r.input + r.cacheWrite + r.cacheRead + r.output;

export function summarizeSpend(rows: SpendRow[], sinceDay = "", now = new Date()): SpendSummary {
  const today = now.toISOString().slice(0, 10);
  const weekStart = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const clientCounts = new Map<SpendSlice, Map<string, number>>();
  const s: SpendSummary = { requests: 0, tokens: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0, unpriced: [], inputRate: 0, byModel: [], byClient: [], series: [] };
  const models = new Map<string, SpendSlice>();
  const clients = new Map<string, SpendSlice>();
  const days = new Map<string, { day: string; costUsd: number; tokens: number }>();
  const unpriced = new Set<string>();
  let rateWeight = 0;
  let rateSum = 0;
  const bump = (m: Map<string, SpendSlice>, key: string, r: SpendRow) => {
    const x = m.get(key) ?? { key, requests: 0, tokens: 0, costUsd: 0, input: 0, output: 0, client: r.client, today: { requests: 0, tokens: 0, costUsd: 0 }, weekCostUsd: 0 };
    x.requests += r.requests;
    x.tokens += tokensOf(r);
    x.costUsd += r.costUsd ?? 0;
    x.input += r.input + r.cacheWrite + r.cacheRead;
    x.output += r.output;
    if (r.day === today) {
      x.today.requests += r.requests;
      x.today.tokens += tokensOf(r);
      x.today.costUsd += r.costUsd ?? 0;
    }
    if (r.day >= weekStart) x.weekCostUsd += r.costUsd ?? 0;
    const c = clientCounts.get(x) ?? new Map<string, number>();
    c.set(r.client, (c.get(r.client) ?? 0) + r.requests);
    clientCounts.set(x, c);
    m.set(key, x);
  };
  for (const r of rows) {
    if (r.day < sinceDay) continue;
    s.requests += r.requests;
    s.tokens += tokensOf(r);
    s.input += r.input;
    s.cacheWrite += r.cacheWrite;
    s.cacheRead += r.cacheRead;
    s.output += r.output;
    s.costUsd += r.costUsd ?? 0;
    if (r.costUsd === null) unpriced.add(r.model);
    const p = priceOf(r.model);
    const w = r.input + r.cacheWrite + r.cacheRead;
    if (p && w > 0) {
      rateSum += p.input * w;
      rateWeight += w;
    }
    bump(models, modelKey(r.model), r);
    bump(clients, r.client, r);
    const d = days.get(r.day) ?? { day: r.day, costUsd: 0, tokens: 0 };
    d.costUsd += r.costUsd ?? 0;
    d.tokens += tokensOf(r);
    days.set(r.day, d);
  }
  const byCost = (a: SpendSlice, b: SpendSlice) => b.costUsd - a.costUsd || b.tokens - a.tokens;
  s.unpriced = [...unpriced];
  s.inputRate = rateWeight ? rateSum / rateWeight : 0;
  for (const [x, c] of clientCounts) x.client = [...c].sort((a, b) => b[1] - a[1])[0]![0];
  s.byModel = [...models.values()].sort(byCost);
  s.byClient = [...clients.values()].sort(byCost);
  s.series = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return s;
}
