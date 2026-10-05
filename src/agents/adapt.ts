/**
 * Adapters from other coding agents' hook protocols to the one the gate already speaks
 * (Claude Code's), and back. The gate itself never learns which agent called it.
 *
 * Pure: no I/O, so each protocol is testable from the payloads in its vendor's docs.
 *
 *   Gemini CLI  BeforeTool can rewrite arguments, so a flagged read is trimmed as in Claude.
 *   Cursor      beforeReadFile / beforeShellExecution can only allow or deny, so a trim
 *               becomes a deny, and every response must be valid JSON: Cursor treats
 *               anything else as a block.
 *   Codex CLI   hooks already use Claude's shape (Bash reads, hookSpecificOutput), so
 *               payloads pass through.
 */
import type { HookInput } from "../types.js";

export const AGENTS = ["gemini", "cursor", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export function isAgent(a: unknown): a is Agent {
  return typeof a === "string" && (AGENTS as readonly string[]).includes(a);
}

type Raw = Record<string, unknown>;
type Out = Record<string, unknown> | null;

/** The internal hook event and payload for one agent event, or null when we ignore it. */
export function toInternal(agent: Agent, event: string, raw: Raw): { command: string; input: HookInput } | null {
  if (agent === "codex") {
    const command = CODEX_EVENTS[event];
    return command ? { command, input: raw as HookInput } : null;
  }
  if (agent === "gemini") return geminiIn(event, raw);
  return cursorIn(event, raw);
}

/** The text to print on stdout for this agent, given the gate's Claude-shaped response. */
export function fromInternal(agent: Agent, event: string, out: Out): string {
  if (agent === "codex") return out ? JSON.stringify(out) : "";
  if (agent === "gemini") return JSON.stringify(geminiOut(out));
  return JSON.stringify(cursorOut(event, out));
}

// ---------- Codex ----------

const CODEX_EVENTS: Record<string, string> = {
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
  SessionStart: "session-start",
  UserPromptSubmit: "prompt-submit",
  PreCompact: "pre-compact",
  Stop: "stop",
};

// ---------- Gemini CLI ----------

const GEMINI_TOOLS: Record<string, string> = {
  read_file: "Read",
  run_shell_command: "Bash",
  glob: "Glob",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch",
};

function geminiIn(event: string, raw: Raw): { command: string; input: HookInput } | null {
  const command = event === "BeforeTool" ? "pre-tool" : event === "AfterTool" ? "post-tool" : event === "SessionStart" ? "session-start" : null;
  if (!command) return null;
  const base: HookInput = { session_id: str(raw.session_id), cwd: str(raw.cwd), transcript_path: str(raw.transcript_path), hook_event_name: event };
  if (command === "session-start") return { command, input: base };
  const name = str(raw.tool_name) ?? "";
  const ti = (raw.tool_input as Raw) ?? {};
  let toolInput: Raw = ti;
  if (name === "read_file") {
    const file_path = str(ti.absolute_path) ?? str(ti.file_path) ?? str(ti.path);
    toolInput = { file_path };
    // Gemini's offset is a 0-based line number; the gate's (Claude's) is 1-based.
    if (typeof ti.offset === "number") toolInput.offset = ti.offset + 1;
    if (typeof ti.limit === "number") toolInput.limit = ti.limit;
  } else if (name === "run_shell_command") {
    toolInput = { command: str(ti.command) };
  }
  const input: HookInput = { ...base, tool_name: GEMINI_TOOLS[name] ?? name, tool_input: toolInput };
  if (command === "post-tool") input.tool_response = geminiText((raw.tool_response as Raw)?.llmContent);
  return { command, input };
}

/** llmContent is a string or a list of parts; the gate measures text. */
function geminiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : str((p as Raw)?.text) ?? "")).join("");
  return "";
}

function geminiOut(out: Out): Record<string, unknown> {
  const h = hso(out);
  const note = str(out?.systemMessage);
  if (!h?.permissionDecision) return note ? { systemMessage: note } : {};
  const reason = str(h.permissionDecisionReason) ?? str(h.additionalContext) ?? "";
  if (h.permissionDecision === "deny") return { decision: "deny", reason, ...(note ? { systemMessage: note } : {}) };
  if (h.permissionDecision === "ask") return { decision: "ask", reason, ...(note ? { systemMessage: note } : {}) };
  const u = h.updatedInput as Raw | undefined;
  if (u && typeof u.limit === "number") {
    const offset = typeof u.offset === "number" ? u.offset - 1 : 0;
    return { decision: "allow", hookSpecificOutput: { tool_input: { offset, limit: u.limit } }, ...(note ? { systemMessage: note } : {}) };
  }
  return { decision: "allow", ...(note ? { systemMessage: note } : {}) };
}

// ---------- Cursor ----------

function cursorIn(event: string, raw: Raw): { command: string; input: HookInput } | null {
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const base: HookInput = {
    session_id: str(raw.conversation_id),
    cwd: str(raw.cwd) ?? str(roots[0]),
    hook_event_name: event,
  };
  if (event === "beforeReadFile") return { command: "pre-tool", input: { ...base, tool_name: "Read", tool_input: { file_path: str(raw.file_path) } } };
  if (event === "beforeShellExecution") return { command: "pre-tool", input: { ...base, tool_name: "Bash", tool_input: { command: str(raw.command) } } };
  return null;
}

function cursorOut(event: string, out: Out): Record<string, unknown> {
  const h = hso(out);
  const decision = str(h?.permissionDecision);
  const trimmed = decision === "allow" && !!h?.updatedInput;
  const reason = str(h?.permissionDecisionReason) ?? str(h?.additionalContext) ?? "";
  const note = str(out?.systemMessage) ?? reason;
  // Cursor cannot trim a read, so the read the gate would have cut goes the way of a deny.
  if (decision === "deny" || trimmed) {
    return event === "beforeShellExecution" ? { permission: "deny", user_message: note, agent_message: reason } : { permission: "deny", user_message: note || reason };
  }
  // A read has no "ask" in Cursor; when unsure, the read goes ahead.
  if (decision === "ask" && event === "beforeShellExecution") return { permission: "ask", user_message: note, agent_message: reason };
  return { permission: "allow" };
}

// ---------- helpers ----------

function hso(out: Out): Raw | undefined {
  return (out?.hookSpecificOutput as Raw | undefined) ?? undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
