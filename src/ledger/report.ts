/**
 * Terminal reporting, in the shape `npm run eval` prints — coverage, per-class counts,
 * false-deny — run against the user's own ledger instead of fixtures.
 *
 * Tokens, not dollars: tokens are what a builder acts on. Every token figure is derived
 * from byte length, so every one carries a `~`.
 */
import type { DecisionRow, TurnRow } from "../types.js";
import { fmtTokens } from "./tokens.js";
import { safePath, safeText } from "../util/safe.js";

export interface Totals {
  decisions: number;
  allow: number;
  ask: number;
  deny: number;
  suppressed: number;
  tokensReadEst: number;
  tokensAvoidedEst: number;
  /** What the reads would have added with no gate: each row counted once. */
  tokensOfferedEst: number;
  jevInputTokens: number;
  jevCostUsd: number;
  latencies: number[];
}

/** Jev 1.13 input price, per docs.typesafe.ai/models: $0.042 per million input tokens. */
export const JEV_USD_PER_MTOK = 0.042;

/** A rule judged the file worth 0 or 1 out of 3. */
const isFlagged = (r: DecisionRow): boolean => r.value <= 1 && r.rule !== "unclassified";

export function totalsOf(rows: DecisionRow[]): Totals {
  const t: Totals = {
    decisions: rows.length,
    allow: 0,
    ask: 0,
    deny: 0,
    suppressed: 0,
    tokensReadEst: 0,
    tokensAvoidedEst: 0,
    tokensOfferedEst: 0,
    jevInputTokens: 0,
    jevCostUsd: 0,
    latencies: [],
  };
  for (const r of rows) {
    t[r.decision] += 1;
    if (r.decision === "allow" && isFlagged(r)) t.suppressed += 1;
    t.tokensReadEst += r.tokensReadEst || 0;
    if (isFlagged(r)) t.tokensAvoidedEst += r.tokensAvoidedEst || 0;
    // An observed row carries the same estimate in both fields, because the read happened
    // and was also flagged. Summing them counted a flagged read twice.
    t.tokensOfferedEst += Math.max(r.tokensReadEst || 0, r.tokensAvoidedEst || 0);
    t.jevInputTokens += r.jevInputTokens || 0;
    t.latencies.push(r.latencyMs || 0);
  }
  t.jevCostUsd = (t.jevInputTokens / 1_000_000) * JEV_USD_PER_MTOK;
  return t;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: the p-th percentile is the ceil(p/100 * N)-th value. Using floor here
  // biased every reported latency upward by one rank on small samples.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export interface ClassStat {
  rule: string;
  reads: number;
  flagged: number;
  withheld: number;
  overridden: number;
}

export interface Harness {
  reads: DecisionRow[];
  classes: ClassStat[];
  /** Asks and denies the agent actually met. Only these can be overridden. */
  gated: number;
  overridden: DecisionRow[];
  fellThrough: number;
  /** Glob, web and MCP output, and Grep lines no file could be found for: measured, never classified. */
  toolOutput: DecisionRow[];
}

/**
 * Splits the ledger into classification rows and the user's overrides, and attributes
 * each override to the gated read it reversed: the latest ask or deny for the same path in
 * the same session. A reversal row carries no rule of its own.
 */
export function harnessOf(rows: DecisionRow[]): Harness {
  const reads: DecisionRow[] = [];
  const toolOutput: DecisionRow[] = [];
  const lastGated = new Map<string, DecisionRow>();
  const overriddenSet = new Set<DecisionRow>();
  for (const r of rows) {
    const key = `${r.session}\0${r.path}`;
    if (r.rule === "reversal") {
      const g = lastGated.get(key);
      if (g) {
        overriddenSet.add(g);
        lastGated.delete(key);
      }
      continue;
    }
    if (r.rule === "tool-output") {
      toolOutput.push(r);
      continue;
    }
    reads.push(r);
    if (r.decision !== "allow" && !r.observedOnly) lastGated.set(key, r);
  }

  const m = new Map<string, ClassStat>();
  let gated = 0;
  let fellThrough = 0;
  for (const r of reads) {
    if (r.rule === "unclassified") {
      fellThrough += 1;
      continue;
    }
    const s = m.get(r.rule) ?? { rule: r.rule, reads: 0, flagged: 0, withheld: 0, overridden: 0 };
    s.reads += 1;
    if (isFlagged(r)) s.flagged += r.tokensAvoidedEst || 0;
    const isGated = r.decision !== "allow" && !r.observedOnly;
    if (isGated) gated += 1;
    if (overriddenSet.has(r)) s.overridden += 1;
    else if (isGated) s.withheld += r.tokensAvoidedEst || 0;
    m.set(r.rule, s);
  }
  const classes = [...m.values()].sort((a, b) => b.flagged - a.flagged || b.reads - a.reads);
  return { reads, classes, gated, overridden: [...overriddenSet], fellThrough, toolOutput };
}

export interface AgentStat {
  /** undefined for the main loop. */
  agentId: string | undefined;
  agentType: string | undefined;
  reads: number;
  flaggedReads: number;
  /** Tokens this agent's reads added, each counted once. */
  offered: number;
  /** Of those, the low-value share. */
  flagged: number;
  /** Tokens from reads another agent had already made. */
  repeated: number;
}

/**
 * Low-value context per agent. In an orchestration the session total says how much was
 * wasted; this says which agent to fix. Each subagent instance is its own row, since two
 * agents of the same type can be given very different work.
 */
export function byAgentOf(reads: DecisionRow[], repeats: Set<DecisionRow> = new Set()): AgentStat[] {
  const m = new Map<string, AgentStat>();
  for (const r of reads) {
    const key = r.agentId ?? "";
    const s = m.get(key) ?? { agentId: r.agentId, agentType: r.agentType, reads: 0, flaggedReads: 0, offered: 0, flagged: 0, repeated: 0 };
    if (repeats.has(r)) s.repeated += offeredOf(r);
    s.reads += 1;
    s.offered += offeredOf(r);
    if (isFlagged(r)) {
      s.flaggedReads += 1;
      s.flagged += r.tokensAvoidedEst || 0;
    }
    s.agentType ??= r.agentType;
    m.set(key, s);
  }
  return [...m.values()].sort((a, b) => b.flagged - a.flagged || b.reads - a.reads);
}

const offeredOf = (r: DecisionRow): number => Math.max(r.tokensReadEst || 0, r.tokensAvoidedEst || 0);

export interface Redundancy {
  /** Reads another agent had already made: same file, same version, same part. */
  repeats: Set<DecisionRow>;
  /** Reads that reached an agent's context and carry a fingerprint, so could be compared. */
  comparable: number;
  tokens: number;
  /** Paths by how many times they were re-read, most first. */
  top: { path: string; times: number; tokens: number }[];
}

/**
 * Cross-agent redundancy. Subagents do not share context, so the second agent to read a
 * file genuinely has not seen it — the waste is the orchestration's, fixable by passing a
 * summary down, and never something to deny. Computed here rather than in a hook so it
 * costs the agent nothing.
 *
 * A re-read by the same agent is not counted: after compaction that is legitimate.
 */
export function redundancyOf(reads: DecisionRow[]): Redundancy {
  const seen = new Map<string, Set<string>>();
  const repeats = new Set<DecisionRow>();
  const byPath = new Map<string, { times: number; tokens: number }>();
  let comparable = 0;
  let tokens = 0;
  for (const r of reads) {
    const reachedContext = r.decision === "allow" || r.observedOnly;
    if (!reachedContext || !r.fp) continue;
    comparable += 1;
    const key = `${r.session}\0${r.path}\0${r.fp}\0${r.range ?? ""}`;
    const who = r.agentId ?? "";
    const readers = seen.get(key) ?? new Set<string>();
    if (readers.size > 0 && !readers.has(who)) {
      repeats.add(r);
      tokens += offeredOf(r);
      const p = byPath.get(r.path) ?? { times: 0, tokens: 0 };
      p.times += 1;
      p.tokens += offeredOf(r);
      byPath.set(r.path, p);
    }
    readers.add(who);
    seen.set(key, readers);
  }
  const top = [...byPath.entries()]
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) => b.tokens - a.tokens || b.times - a.times);
  return { repeats, comparable, tokens, top };
}

/** "main", or the subagent's type plus enough of its id to tell two of a kind apart. */
export function agentLabel(s: Pick<AgentStat, "agentId" | "agentType">): string {
  if (s.agentId === undefined) return "main";
  return `${safeText(s.agentType ?? "subagent", 24)} ${safeText(s.agentId.slice(0, 8), 8)}`;
}

const pctOf = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
const tok = (n: number): string => (n > 0 ? `~${fmtTokens(n)}` : "0");

export interface ReportOptions {
  /** Shown in the header: "this session", "all sessions". */
  scope?: string;
  gateInstalled?: boolean;
  /** Add the BY AGENT table. */
  byAgent?: boolean;
}

export function renderReport(
  rows: DecisionRow[],
  turns: TurnRow[],
  mode: string,
  opts: ReportOptions = {},
): string {
  const h = harnessOf(rows);
  if (h.reads.length === 0 && h.toolOutput.length === 0) {
    return [
      `snout — no reads recorded${opts.scope ? ` ${opts.scope}` : ""} yet.`,
      "",
      "The plugin records a decision each time the agent reads a file. Ask Claude to read",
      "something, then run /snout:report again.",
    ].join("\n");
  }

  const t = totalsOf(h.reads);
  const n = h.reads.length;
  const classified = n - h.fellThrough;
  const withheld = h.classes.reduce((a, s) => a + s.withheld, 0);
  const flaggedReads = h.reads.filter(isFlagged).length;

  const out: string[] = [];
  const turnNote = turns.length > 0 ? ` over ${turns.length} turn(s)` : "";
  out.push(`snout — ${opts.scope ?? "ledger"} · ${n} read(s)${turnNote} · mode: ${mode}`);
  out.push("");

  // The one sentence a non-technical reader needs. Everything below is its breakdown.
  out.push(`  Reads added ~${fmtTokens(t.tokensOfferedEst)} tokens of context. ${flaggedReads} of ${n} read(s) were`);
  out.push(`  low-value: ${tok(t.tokensAvoidedEst)} tokens, ${pctOf(t.tokensAvoidedEst, t.tokensOfferedEst)} of the total.`);
  if (h.toolOutput.length > 0) {
    const toolTokens = h.toolOutput.reduce((a, r) => a + (r.tokensReadEst || 0), 0);
    const tools = [...new Set(h.toolOutput.map((r) => (r.tool.startsWith("mcp__") ? "MCP" : r.tool)))].join(", ");
    out.push(`  Search, web and MCP output added ${tok(toolTokens)} more (${safeText(tools, 60)}): measured, not classified.`);
  }
  if (mode === "observe") {
    out.push("  Observe mode withholds nothing, so all of it reached the agent.");
  } else {
    out.push(`  ${tok(withheld)} tokens were withheld; the rest you allowed or overrode.`);
  }
  out.push("");

  out.push("  COVERAGE");
  out.push(`    classified     ${String(classified).padStart(5)} of ${n}  ${pctOf(classified, n).padStart(4)}   a rule recognised the file`);
  out.push(`    fell through   ${String(h.fellThrough).padStart(5)} of ${n}  ${pctOf(h.fellThrough, n).padStart(4)}   no rule applies, so it was read as normal`);
  out.push("");

  if (h.classes.length > 0) {
    out.push("  BY CLASS         reads    flagged   withheld   overridden");
    for (const s of h.classes) {
      out.push(
        `    ${s.rule.padEnd(14)} ${String(s.reads).padStart(5)} ${tok(s.flagged).padStart(10)} ${tok(s.withheld).padStart(10)} ${String(s.overridden).padStart(12)}`,
      );
    }
    out.push(`    ${"-".repeat(55)}`);
    out.push(
      `    ${"total".padEnd(14)} ${String(classified).padStart(5)} ${tok(t.tokensAvoidedEst).padStart(10)} ${tok(withheld).padStart(10)} ${String(h.overridden.length).padStart(12)}`,
    );
    out.push("");
  }

  const red = redundancyOf(h.reads);
  const agents = byAgentOf(h.reads, red.repeats);
  if (opts.byAgent) {
    out.push("  BY AGENT                      reads   low-value   of its reads   share of waste   repeats");
    for (const a of agents) {
      out.push(
        `    ${agentLabel(a).padEnd(26)} ${String(a.reads).padStart(5)} ${tok(a.flagged).padStart(11)} ${pctOf(a.flagged, a.offered).padStart(14)} ${pctOf(a.flagged, t.tokensAvoidedEst).padStart(16)} ${tok(a.repeated).padStart(9)}`,
      );
    }
    if (agents.length === 1) out.push("    Only the main agent read files. Subagents appear here when they do.");
    out.push("");
  } else if (agents.length > 1) {
    out.push(`  ${agents.length - (agents.some((a) => a.agentId === undefined) ? 1 : 0)} subagent(s) also read files. Waste per agent: /snout:report --by-agent`);
    out.push("");
  }

  // Only meaningful in an orchestration: with one agent there is nobody to repeat.
  if (agents.length > 1) {
    out.push("  REDUNDANCY");
    if (red.repeats.size === 0) {
      out.push("    No agent re-read a file another agent had already read.");
    } else {
      out.push(
        `    ${red.repeats.size} of ${red.comparable} read(s) (${pctOf(red.repeats.size, red.comparable)}) repeated a read another agent had already made: ${tok(red.tokens)} tokens.`,
      );
      for (const p of red.top.slice(0, 3)) out.push(`      ${safePath(p.path)}  re-read ${p.times}× · ${tok(p.tokens)} tokens`);
      out.push("    Subagents don't share context; passing a summary down avoids the repeat.");
    }
    out.push("");
  }

  out.push("  FALSE-DENY");
  if (h.gated === 0) {
    out.push(
      mode === "observe"
        ? "    n/a — observe mode asks nothing, so there is nothing to override."
        : "    n/a — no read has been asked about or denied yet.",
    );
  } else {
    out.push(`    ${h.overridden.length} of ${h.gated} ask/deny decision(s) overridden  (${pctOf(h.overridden.length, h.gated)})`);
    if (h.overridden.length > 0) {
      out.push("    Each override is our error. `/snout:allow <path>` stops it recurring:");
      for (const r of h.overridden.slice(-5)) out.push(`      ${r.path}  (${r.rule})`);
    }
  }

  const flagged = h.reads.filter(isFlagged).slice(-5);
  if (flagged.length > 0) {
    out.push("");
    out.push("  MOST RECENT FLAGGED");
    for (const r of flagged) {
      const mark = r.decision === "allow" ? "·" : r.decision === "ask" ? "?" : "×";
      out.push(`    ${mark} ${r.path}  ${r.rule} · ${tok(r.tokensAvoidedEst)} tokens`);
    }
  }

  out.push("");
  out.push("  `~` marks an estimate, derived from byte length. Withheld content is never read,");
  out.push("  so its tokens cannot be measured. See docs/evaluation.md.");
  // Only the blocking hook makes the agent wait. The recording hook runs with async:true,
  // so its process lifetime is real cost to the machine but not delay the user feels.
  const p50 = percentile(t.latencies, 50);
  const p95 = percentile(t.latencies, 95);
  out.push(
    opts.gateInstalled
      ? `  added latency p50 ${p50} ms · p95 ${p95} ms (blocks the agent)`
      : `  recording overhead p50 ${p50} ms · p95 ${p95} ms (async — does not delay the agent)`,
  );
  if (t.jevInputTokens > 0) out.push(`  Jev requests ${fmtTokens(t.jevInputTokens)} input tokens`);

  if (mode === "observe" && flaggedReads > 0) {
    out.push("");
    out.push("  Next: `/snout:mode advise` to start asking before low-value reads.");
  }
  return out.join("\n");
}
