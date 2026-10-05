/**
 * Trims large MCP tool results before the agent reads them: browser snapshots, PR diffs and
 * issue lists, query results, fetched pages. Same contract as Squeeze: only successful calls
 * reach here (a failed MCP call fires PostToolUseFailure, which can't be rewritten), the full
 * result is saved, and anything that can't be trimmed safely is passed through unchanged.
 *
 * What it does, in order of safety:
 *   JSON  re-serialised compactly; arrays past MAX_ITEMS keep their first items plus a count;
 *         strings past MAX_STRING are cut with their length noted. Keys and structure stay.
 *   text  runs of blank lines collapsed, repeated lines counted, very long lines cut, and if
 *         still over budget, the head and tail kept around a note of what was left out.
 * Images and other non-text blocks are never touched.
 *
 * Claude Code has its own cap for MCP output (MAX_MCP_OUTPUT_TOKENS, 25,000 by default) and
 * handles results above it itself, so this stays below that, as Squeeze does for Bash.
 */
export interface McpBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpTrimmed {
  /** The replacement, in the same shape the tool returned (a block list or `{ content }`). */
  output: unknown;
  beforeChars: number;
  afterChars: number;
}

/** Results smaller than this are left alone (~1.5k tokens). */
const MIN_CHARS = 6000;
/** Text is trimmed toward this budget (~6k tokens). */
const TEXT_BUDGET = 24_000;
const MAX_ITEMS = 25;
const KEEP_ITEMS = 20;
const MAX_STRING = 400;
const MAX_LINE = 600;
const MIN_CUT = 0.3;

/** Claude Code's MCP output cap, in characters (~4 per token). */
export const mcpLimitChars = (): number => (Number(process.env.MAX_MCP_OUTPUT_TOKENS) || 25_000) * 4;

function trimJson(v: unknown, depth = 0): unknown {
  if (depth > 12) return v;
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… (${v.length} chars)` : v;
  if (Array.isArray(v)) {
    const kept = v.slice(0, v.length > MAX_ITEMS ? KEEP_ITEMS : v.length).map((x) => trimJson(x, depth + 1));
    if (v.length > MAX_ITEMS) kept.push(`… ${v.length - KEEP_ITEMS} more items (${v.length} total)`);
    return kept;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = trimJson(x, depth + 1);
    return out;
  }
  return v;
}

function trimText(text: string): string {
  const out: string[] = [];
  let last = "";
  let repeats = 0;
  let blank = false;
  const flush = () => {
    if (repeats) out.push(`(+${repeats} identical)`);
    repeats = 0;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      if (!blank) out.push("");
      blank = true;
      continue;
    }
    blank = false;
    if (line === last) {
      repeats += 1;
      continue;
    }
    flush();
    out.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… (${line.length} chars)` : line);
    last = line;
  }
  flush();
  let s = out.join("\n");
  if (s.length > TEXT_BUDGET) {
    const head = s.slice(0, Math.floor(TEXT_BUDGET * 0.7));
    const tail = s.slice(s.length - Math.floor(TEXT_BUDGET * 0.3));
    s = `${head}\n… ${s.length - head.length - tail.length} characters omitted …\n${tail}`;
  }
  return s;
}

function trimBlockText(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(trimJson(JSON.parse(t)));
    } catch {
      // not JSON after all: treat as text
    }
  }
  return trimText(text);
}

/** The trimmed result, or null when it's small, over Claude Code's cap, or wouldn't shrink enough. */
export function trimMcp(response: unknown, savedTo: string): McpTrimmed | null {
  const blocks: McpBlock[] | null = Array.isArray(response)
    ? (response as McpBlock[])
    : response && typeof response === "object" && Array.isArray((response as { content?: unknown }).content)
      ? ((response as { content: McpBlock[] }).content)
      : null;
  if (!blocks || !blocks.every((b) => b && typeof b === "object" && typeof b.type === "string")) return null;
  const beforeChars = blocks.reduce((a, b) => a + (b.type === "text" && typeof b.text === "string" ? b.text.length : 0), 0);
  if (beforeChars < MIN_CHARS || beforeChars > mcpLimitChars()) return null;
  const trimmed: McpBlock[] = blocks.map((b) => (b.type === "text" && typeof b.text === "string" ? { ...b, text: trimBlockText(b.text) } : b));
  const kept = trimmed.reduce((a, b) => a + (b.type === "text" && typeof b.text === "string" ? b.text.length : 0), 0);
  if (kept > beforeChars * (1 - MIN_CUT)) return null;
  trimmed.push({ type: "text", text: `[Snout trimmed this result from ${beforeChars.toLocaleString()} to ${kept.toLocaleString()} characters: long lists shortened, repeats collapsed, structure kept. Full result: ${savedTo}]` });
  const afterChars = kept + (trimmed[trimmed.length - 1]!.text as string).length;
  const output = Array.isArray(response) ? trimmed : { ...(response as object), content: trimmed };
  return { output, beforeChars, afterChars };
}
