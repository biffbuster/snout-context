/**
 * The dashboard's data contract: what each endpoint returns. Shared by the server (views.ts)
 * and the page (app/), so a field cannot drift between them. Types only; no runtime code.
 *
 * Every number carries how it is known:
 *   measured   from the agent's own usage logs (billed tokens, list-price cost) or a count
 *   estimated  from content size at Snout's gate (tokens kept out, dollars those would cost)
 * The page labels each one so an estimate is never shown as a bill.
 */

export type RangeKey = "live" | "24h" | "7d" | "30d" | "all" | "custom";

export interface RangeInfo {
  key: RangeKey;
  from: string;
  to: string;
  /** Bucket width for series: 60s, 3600s or 86400s. */
  bucket: number;
}

export interface ProjectRef {
  id: string;
  name: string;
  dir: string;
  /** Snout records exist for this project (.snout/ledger.jsonl). */
  snout: boolean;
  current: boolean;
  last: string;
  remote: string | null;
}

export interface Boot {
  /** "local" for `snout dashboard`; "hosted" when served by Snout Cloud. */
  host: "local" | "hosted";
  version: string;
  project: ProjectRef;
  projects: ProjectRef[];
  mode: string;
  controls: boolean;
  /** Hosted sync state for this machine, when the user has signed in. */
  cloud: { connected: boolean; url: string | null; team: string | null; user: string | null; lastSync: string | null };
  /** Set only by Snout Cloud: who is signed in and which team the page shows. */
  hosted?: HostedBoot;
}

export interface Usage {
  requests: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  costUsd: number;
  /** Requests whose model has no known price: their tokens count, their cost does not. */
  unpriced: number;
}

export interface SnoutTotals {
  reads: number;
  /** Tokens that reached context through reads and tool results Snout saw (estimated). */
  inContext: number;
  /** Tokens Snout kept out: denied, trimmed or answered with a pointer (estimated). */
  keptOut: number;
  /** In observe mode: what enforce would have kept out (estimated, not a saving). */
  couldKeepOut: number;
  /** Reads Snout acted on. */
  events: number;
  trims: number;
  denials: number;
  repeats: number;
  repeatTokens: number;
  /** Command and MCP output Squeeze shortened. */
  outputTrims: number;
  outputTokens: number;
  overridden: number;
}

export type SessionStatus = "working" | "idle";

export interface SessionRow {
  id: string;
  client: "claude" | "codex";
  title: string;
  task: string;
  surface: string;
  environment: EnvironmentKind;
  version: string;
  branch: string;
  models: string[];
  first: string;
  last: string;
  status: SessionStatus;
  turns: number;
  toolCalls: number;
  errors: number;
  compactions: number;
  subagents: number;
  /** Context size at the latest request: input + cache reads + cache writes (measured). */
  contextNow: number;
  contextWindow: number | null;
  usage: Usage;
  snout: Pick<SnoutTotals, "reads" | "keptOut" | "couldKeepOut" | "events" | "repeats">;
  /** keptOut priced at this session's input rate (estimated). */
  savedUsd: number | null;
}

export type EnvironmentKind = "local" | "desktop" | "sdk" | "remote" | "cloud";

export interface ModelCard {
  model: string;
  provider: string;
  client: string;
  sessions: number;
  active: number;
  usage: Usage;
  /** Requests in the last 24 hours, for the "runs today" line. */
  today: number;
  keptOut: number;
  savedUsd: number | null;
  /** Largest context seen in the range (measured) and the model's window, when known. */
  peakContext: number;
  contextWindow: number | null;
}

export interface Point {
  t: string;
  /** Billed input of all kinds, measured. */
  billed: number;
  output: number;
  costUsd: number;
  /** Through Snout's gate, estimated. */
  inContext: number;
  keptOut: number;
}

export interface Execution {
  session: string;
  client: string;
  model: string;
  prompt: string;
  start: string;
  end: string | null;
  status: "running" | "complete" | "error" | "compacted";
  durationMs: number | null;
  tokens: number;
  costUsd: number;
  keptOut: number;
  toolCalls: number;
}

export interface Slice {
  key: string;
  reads: number;
  inContext: number;
  keptOut: number;
}

export interface FeedRow {
  ts: string;
  session: string;
  client: string;
  agent: string;
  tool: string;
  path: string;
  rule: string;
  outcome: "read" | "trimmed" | "held back" | "asked" | "would hold back";
  inContext: number;
  keptOut: number;
  reason: string;
}

export interface Overview {
  range: RangeInfo;
  usage: Usage;
  snout: SnoutTotals;
  /** keptOut / (keptOut + inContext + tool output), estimated. */
  reduction: number;
  savedUsd: number | null;
  inputRate: number | null;
  sessions: { active: number; total: number };
  models: ModelCard[];
  series: Point[];
  costBy: { agent: { key: string; costUsd: number; tokens: number }[]; model: { key: string; client: string; costUsd: number; tokens: number; periods: number[] }[]; periods: string[] };
  executions: Execution[];
  insights: {
    topSources: Slice[];
    repeats: { count: number; tokens: number };
    outputs: { count: number; tokens: number };
    compaction: { compactions: number; recalls: number };
    mcp: Slice[];
  };
  timeline: { session: string; client: string; model: string; title: string; start: string; end: string; status: SessionStatus; events: { t: string; kind: "read" | "kept" | "compact" | "error" }[] }[];
  files: { top: Slice[]; held: Slice[] };
  feed: FeedRow[];
  mode: string;
  /** Agent working time today and yesterday, from turn durations in the agents' logs (measured). */
  activity: { client: string; todayMs: number; yesterdayMs: number; turns: number; share: number }[];
}

export interface AgentCard {
  key: string;
  client: "claude" | "codex" | "cursor" | "gemini" | string;
  name: string;
  /** Main loop or a subagent type ("Explore", "general-purpose", ...). */
  role: string;
  models: string[];
  status: "working" | "idle" | "connected" | "not connected";
  task: string;
  sessions: number;
  turns: number;
  toolCalls: number;
  usage: Usage;
  keptOut: number;
  savedUsd: number | null;
  last: string | null;
  environment: string;
  errors: number;
  warnings: string[];
  tools: { name: string; calls: number }[];
  mcp: string[];
}

export interface TraceNode {
  id: string;
  kind:
    | "start" | "brief" | "prompt" | "request" | "tool" | "read" | "search" | "shell" | "mcp" | "web" | "edit" | "subagent"
    | "kept" | "trimmed" | "repeat" | "would" | "asked" | "output-trim" | "recall" | "compact" | "response" | "end";
  label: string;
  detail: string;
  ts: string;
  endTs: string | null;
  status: "running" | "completed" | "optimized" | "skipped" | "failed";
  turn: number;
  parent: string | null;
  /** Tokens: for a request, its billed input+output; for a read, what reached context (estimated). */
  tokens: number;
  keptOut: number;
  costUsd: number | null;
  model: string | null;
  agent: string | null;
  path: string | null;
  rule: string | null;
  reason: string | null;
  bytes: number | null;
}

export interface TraceTurn {
  n: number;
  prompt: string;
  start: string;
  end: string | null;
  nodes: number;
  tokens: number;
  costUsd: number;
  keptOut: number;
  /** Tool calls in the turn that passed Snout's hooks (0 when Snout was not on for the session). */
  checked: number;
  compacted: boolean;
  durationMs: number | null;
}

export interface TraceEdge {
  from: string;
  to: string;
  kind: "flow" | "branch" | "merge" | "snout";
}

export interface Trace {
  session: SessionRow;
  /** Every turn, for the outline; only turns in `window` have nodes. */
  turns: TraceTurn[];
  window: { from: number; to: number };
  nodes: TraceNode[];
  edges: TraceEdge[];
  /** Nodes left out to keep the graph readable (the turns are still listed). */
  truncated: number;
}

export interface SessionDetail {
  session: SessionRow;
  tools: { name: string; calls: number; errors: number; resultBytes: number }[];
  files: Slice[];
  timeline: { t: string; context: number; output: number; costUsd: number }[];
  compactions: { ts: string; trigger: string; preTokens: number | null; postTokens: number | null }[];
  turns: TraceTurn[];
  feed: FeedRow[];
  /** What Snout let through whole, grouped by why. Explains a small "kept out". */
  passed: { why: string; count: number; tokens: number }[];
}

export interface ProjectCard {
  ref: ProjectRef;
  environment: string;
  sessions: number;
  active: number;
  usage: Usage | null;
  snout: Pick<SnoutTotals, "reads" | "keptOut" | "couldKeepOut" | "events"> | null;
  savedUsd: number | null;
  mode: string | null;
  rules: number;
  topFiles: Slice[];
  recent: FeedRow[];
}

export interface Integration {
  id: string;
  name: string;
  kind: "agent" | "mcp" | "model" | "service" | "repo";
  status: "connected" | "installed" | "available" | "off" | "error";
  detail: string;
  version: string | null;
  capabilities: { name: string; on: boolean }[];
  telemetry: string[];
  last: string | null;
  setup: string | null;
  errors: string[];
}

export interface EnvironmentView {
  local: {
    host: string;
    platform: string;
    node: string;
    snout: string;
    projectDir: string;
    snoutDir: string;
    configDir: string;
    dashboard: string;
    fastServer: { on: boolean; port: number };
    records: { name: string; bytes: number; rows: number | null }[];
    agents: { client: string; surface: string; sessions: number; last: string }[];
    errors: { ts: string; where: string; message: string }[];
  };
  hosted: Boot["cloud"] & { environments: { id: string; kind: string; label: string; last: string; sessions: number }[] };
}

export interface Analytics {
  range: RangeInfo;
  series: Point[];
  byModel: { key: string; usage: Usage; keptOut: number; sessions: number }[];
  byAgent: { key: string; usage: Usage; keptOut: number; sessions: number }[];
  composition: Slice[];
  growth: { session: string; title: string; points: { i: number; context: number }[]; compactions: number[] }[];
  retention: { compactions: number; recalls: number; briefs: number };
  files: Slice[];
  turns: { session: string; prompt: string; tokens: number; costUsd: number; keptOut: number; durationMs: number | null }[];
  repeats: { count: number; tokens: number };
  /** Reads another agent in the same session had already made (subagents do not share context). Not kept out. */
  crossAgent: { count: number; tokens: number; comparable: number; top: { path: string; times: number; tokens: number }[] };
}

export interface SettingsView {
  mode: string;
  values: Record<string, unknown>;
  defaults: Record<string, unknown>;
  alwaysAllow: string[];
  alwaysDeny: string[];
  redact: string[];
  redactExempt: string[];
  prices: { model: string; input: number; cacheRead: number; output: number; source: "list" | "yours" }[];
  pricesAsOf: string;
  configFile: string;
  keyPresent: { typesafe: boolean };
  /** Errors Snout recorded in the last 7 days (newest first); `more` recent ones not listed, `older` ones before that. */
  health: { hooks: string | null; recent: { ts: string; where: string; message: string }[]; more: number; older: number; file: string };
}

export interface PrivacyView {
  local: { stored: { file: string; holds: string; bytes: number }[]; telemetry: string; network: { feature: string; on: boolean; sends: string; to: string }[] };
  redact: string[];
  hosted: { connected: boolean; sends: string[]; never: string[] };
  audit: { ts: string; what: string }[];
}

// ---------------------------------------------------------------- hosted (Snout Cloud)
//
// What a signed-in browser gets from Snout Cloud (cloud/). Built only from what `snout sync`
// sends: per day, project, person, agent and file label, reads and tokens in context or kept out
// (estimated at the gate), plus measured usage per model. No sessions, paths or prompts exist
// on the server, so the hosted pages have none.

export interface HostedTeam {
  id: string;
  name: string;
  personal: boolean;
  plan: string;
  role: "owner" | "member" | string;
  members: number;
}

export interface HostedBoot {
  user: { id: string; login: string; name: string | null; avatar: string | null; admin: boolean };
  teams: HostedTeam[];
  /** The team the page shows. */
  team: string;
  /** The command that connects a machine to this server. */
  connect: string;
  devLogin: boolean;
  beta: boolean;
}

/** Tokens through Snout's gate, all estimated from content size. */
export interface TeamTotals {
  reads: number;
  /** Reads Snout acted on (denied, trimmed or answered with a pointer). */
  gated: number;
  inContext: number;
  keptOut: number;
  /** In observe mode: what enforce would have kept out. Not a saving. */
  couldKeepOut: number;
}

/** Billed usage from the agents' own logs, priced at list (measured). */
export interface TeamSpend {
  requests: number;
  /** Input of all kinds plus output. */
  tokens: number;
  cacheRead: number;
  costUsd: number;
}

export interface TeamSlice {
  key: string;
  name: string;
  snout: TeamTotals;
  spend: TeamSpend;
  /** Latest day this slice has rows for. */
  last: string | null;
}

export interface TeamMember extends TeamSlice {
  avatar: string | null;
  /** A cloud-agent key reports as its own member ("agent:<label>"). */
  agent: boolean;
  clients: string[];
}

export interface TeamClient extends TeamSlice {
  members: number;
  models: string[];
}

export interface TeamMachine {
  id: string;
  label: string;
  owner: string;
  kind: "cli" | "workspace";
  createdAt: string;
  lastUsedAt: string | null;
  /** The signed-in user's own CLI login: they can revoke it. */
  mine: boolean;
}

export interface TeamView {
  team: HostedTeam;
  days: number;
  /** Set when the plan shows less history than was asked for. */
  capped: { historyDays: number } | null;
  totals: TeamTotals;
  spend: TeamSpend & { unpriced: string[] };
  /** One point per day in the range, oldest first, zero-filled. */
  series: { day: string; inContext: number; keptOut: number; costUsd: number; tokens: number }[];
  byMember: TeamMember[];
  byClient: TeamClient[];
  byModel: (TeamSlice & { client: string })[];
  byProject: TeamSlice[];
  byLabel: { key: string; reads: number; inContext: number; keptOut: number }[];
  /** MCP servers, from labels "mcp-<server>". */
  byMcp: { key: string; reads: number; inContext: number; keptOut: number }[];
  machines: TeamMachine[];
  lastSyncAt: string | null;
  now: string;
}
