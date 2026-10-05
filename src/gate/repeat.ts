/**
 * Repeat skip: an agent that reads something it already has, unchanged, pays for the same
 * tokens twice, and again on every later turn because both copies stay in the conversation.
 *
 * Files: PostToolUse records each successful read by what it actually returned (the whole
 * file, or an exact line window) along with the file's size and mtime at that moment; Bash
 * dumps (`cat file`) count as whole-file reads. PreToolUse then spots a request already
 * covered by an earlier read of the unchanged file: the same window, a window inside one
 * already read, or any window of a file read whole.
 *
 * Tool results: an MCP call or command whose result is byte-identical to one this agent
 * already received is replaced with a pointer to the earlier copy.
 *
 * Claude Code already answers an exact repeat of a Read itself ("file unchanged"), so for it
 * only the cases it misses fire here (a narrower window, a Read after a `cat`, a `cat` after a
 * Read); agents without that, such as Codex, Cursor and Gemini CLI, get every case.
 *
 * Safety, in order of importance:
 *  - per agent: a subagent has its own context and never inherits the main agent's reads;
 *  - any change resets: size, mtime (so the agent's own edits);
 *  - compaction resets: after a summary the earlier text is gone, so the next read is full;
 *  - only reads that completed are recorded, so a failed read is never "already seen".
 * State lives in one small file per project; a lost write only means a full re-read.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeAtomic } from "../util/atomic.js";

type Entry = { size: number; mtimeMs: number; turn: number; windows: string[] };
type Output = { turn: number; chars: number; call?: string };
type Store = { session: string; reads: Record<string, Entry>; outputs?: Record<string, Output> };

const MAX_ENTRIES = 2000;
const MAX_WINDOWS = 20;
const storePath = (snoutDir: string) => join(snoutDir, "reads.json");

function load(snoutDir: string, session: string): Store {
  try {
    const s = JSON.parse(readFileSync(storePath(snoutDir), "utf8")) as Store;
    if (s.session === session && s.reads && typeof s.reads === "object") return s;
  } catch {
    // missing or unreadable: start fresh
  }
  return { session, reads: {} };
}

function trim<T>(map: Record<string, T>): void {
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
}

function save(snoutDir: string, store: Store): void {
  try {
    trim(store.reads);
    if (store.outputs) trim(store.outputs);
    writeAtomic(storePath(snoutDir), JSON.stringify(store));
  } catch {
    // best effort: without the record the next read is simply full
  }
}

/** The window a Read asks for: "full", or "start:count" for an offset/limit read. */
export function requestedWindow(toolInput: Record<string, unknown> | undefined): string {
  const t = toolInput ?? {};
  const limit = Number(t.limit);
  if (!Number.isFinite(limit) || limit <= 0) return "full";
  const offset = Math.max(1, Number(t.offset) || 1);
  return `${offset}:${limit}`;
}

/** The window a Read actually returned, from its tool_response; null when it did not succeed. */
export function returnedWindow(toolResponse: unknown): string | null {
  const file = (toolResponse as { file?: { startLine?: number; numLines?: number; totalLines?: number } } | undefined)?.file;
  if (!file || typeof file.numLines !== "number") return null;
  const start = Number(file.startLine) || 1;
  const total = Number(file.totalLines) || file.numLines;
  if (start <= 1 && file.numLines >= total) return "full";
  return `${start}:${file.numLines}`;
}

const span = (w: string): [number, number] => {
  const [s, n] = w.split(":").map(Number);
  return [s!, s! + n! - 1];
};

/** The recorded window that already holds everything `want` would return, if any. */
export function coveringWindow(have: string[], want: string): string | null {
  if (have.includes(want)) return want;
  if (have.includes("full")) return "full";
  if (want === "full") return null;
  const [a, b] = span(want);
  return have.find((w) => w !== "full" && span(w)[0] <= a && span(w)[1] >= b) ?? null;
}

const keyOf = (agentId: string | undefined, rel: string) => `${agentId || "main"}\u0000${rel}`;

function statOf(absPath: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(absPath);
    return s.isFile() ? { size: s.size, mtimeMs: Math.round(s.mtimeMs) } : null;
  } catch {
    return null;
  }
}

/** Called from PostToolUse after a Read (or a whole-file Bash dump) completed. */
export function rememberRead(snoutDir: string, session: string, agentId: string | undefined, absPath: string, rel: string, window: string, turn: number): void {
  const st = statOf(absPath);
  if (!st || !existsSync(snoutDir)) return;
  const store = load(snoutDir, session);
  const key = keyOf(agentId, rel);
  const prior = store.reads[key];
  const same = prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs;
  const windows = same ? prior.windows.filter((w) => w !== window) : [];
  windows.push(window);
  delete store.reads[key]; // re-insert so the newest reads survive trimming
  store.reads[key] = { ...st, turn, windows: windows.slice(-MAX_WINDOWS) };
  save(snoutDir, store);
}

/**
 * The earlier read that already holds what this request would return, if the file is
 * unchanged since. `native` is true for agents that answer exact repeats themselves, so only
 * a request covered by a different window counts.
 */
export function repeatOf(snoutDir: string, session: string, agentId: string | undefined, absPath: string, rel: string, window: string, native = false): { turn: number; window: string } | null {
  const prior = load(snoutDir, session).reads[keyOf(agentId, rel)];
  if (!prior || !Array.isArray(prior.windows)) return null;
  const st = statOf(absPath);
  if (!st || st.size !== prior.size || st.mtimeMs !== prior.mtimeMs) return null;
  const covering = coveringWindow(prior.windows, window);
  if (!covering || (native && covering === window)) return null;
  return { turn: prior.turn, window: covering };
}

/** Results shorter than this are cheaper to repeat than to point at. */
export const MIN_REPEAT_CHARS = 800;

const outputKey = (agentId: string | undefined, tool: string, text: string) =>
  `${agentId || "main"}\u0000${tool}\u0000${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;

/**
 * Records a tool result and returns the earlier identical one this agent already received, if
 * any. Identical bytes, same tool, same agent, no compaction since: the copy is in context.
 * `call` is the tool_use_id: when several hook entries match one command, Claude Code runs the
 * hook once per entry for the same call, and that is not a repeat.
 */
export function repeatOutput(snoutDir: string, session: string, agentId: string | undefined, tool: string, text: string, turn: number, call?: string): Output | null {
  if (text.length < MIN_REPEAT_CHARS || !existsSync(snoutDir)) return null;
  const store = load(snoutDir, session);
  store.outputs ??= {};
  const key = outputKey(agentId, tool, text);
  const prior = store.outputs[key];
  if (prior) return prior.call && prior.call === call ? null : prior;
  store.outputs[key] = { turn, chars: text.length, ...(call ? { call } : {}) };
  save(snoutDir, store);
  return null;
}

/** Compaction replaced the conversation with a summary: nothing earlier can be relied on. */
export function forgetReads(snoutDir: string, session: string): void {
  if (!existsSync(snoutDir)) return;
  save(snoutDir, { session, reads: {}, outputs: {} });
}
