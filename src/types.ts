/** Shared types. Kept dependency-free so every module can import them cheaply. */

export type Mode = "observe" | "advise" | "enforce";
export type Verdict = "allow" | "ask" | "deny";

/** 0 = nothing usable, 1 = marginal, 2 = useful, 3 = essential. Matches the Jev Score levels. */
export type ContextValue = 0 | 1 | 2 | 3;

export interface Decision {
  verdict: Verdict;
  /** Which stage of the ladder answered. 0 = free rules, 1 = turn vector, 2 = per-file Jev call. */
  tier: 0 | 1 | 2;
  /** Stable identifier for the rule or question that produced this. Used by /snout:report grouping. */
  rule: string;
  value: ContextValue;
  confidence: number;
  /** One sentence, written for a non-technical reader, stating what/cost/certainty/override. */
  reason: string;
  /** True when the verdict was downgraded to allow because of the current mode. */
  suppressedByMode?: boolean;
  warn?: boolean;
}

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  /** Set when the event comes from a subagent rather than the main loop. */
  agent_id?: string;
  agent_type?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  /** What the tool returned. Shape varies by tool; read it through `responseText`. */
  tool_response?: unknown;
  prompt?: string;
  session_start_reason?: string;
  /** SessionStart: "startup", "resume", "clear", "compact" or "fork". */
  source?: string;
  /** The model the session runs on; Claude Code sends it with SessionStart. */
  model?: string;
  compaction_reason?: string;
}

export interface DecisionRow {
  ts: string;
  session: string;
  turn: number;
  tool: string;
  path: string;
  tier: 0 | 1 | 2;
  rule: string;
  value: ContextValue;
  confidence: number;
  decision: Verdict;
  mode: Mode;
  /** The sentence shown to the user, stored so reports need not re-run the classifier. */
  reason: string;
  bytes: number;
  /** Tokens we estimate the agent would have paid had the read gone through. Never measured. */
  tokensAvoidedEst: number;
  /** Tokens the read actually cost, filled in by PostToolUse. */
  tokensReadEst: number;
  jevInputTokens: number;
  latencyMs: number;
  model: string | null;
  reversedByUser: boolean;
  /**
   * True when the row was written after the read had already happened, by the
   * non-blocking PostToolUse hook. These rows say what we *would* have done; they never
   * represent an action taken.
   */
  observedOnly?: boolean;
  /**
   * `size:mtime` of the file when read, so two reads of the same path can be told apart
   * from a read, an edit, and a re-read. Absent on rows written before redundancy landed.
   */
  fp?: string;
  /** Which part was read: `offset:limit` for Read, `bash:<bytes>` for a Bash read. */
  range?: string;
  /**
   * The read went ahead but was cut to the file's head (enforce mode). `decision` is "deny"
   * and `tokensAvoidedEst` counts only what was cut; `tokensReadEst` is the head.
   */
  trimmed?: boolean;
  /** The subagent that made the read. Absent for the main loop. */
  agentId?: string;
  agentType?: string;
  /** The coding agent that made the read, when not Claude Code: "codex", "gemini", "cursor". */
  client?: string;
}

export interface TurnRow {
  ts: string;
  session: string;
  turn: number;
  goalHash: string;
  decisions: Record<Verdict, number>;
  tokensReadEst: number;
  tokensAvoidedEst: number;
  jevRequests: number;
  jevInputTokens: number;
  jevCostUsd: number;
  latency: { p50: number; p95: number; max: number };
  compacted: boolean;
}
