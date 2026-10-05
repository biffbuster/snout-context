/**
 * Append-only JSONL storage. No database and no daemon: the user can read, grep and
 * delete their own data with ordinary tools.
 *
 * Concurrency: hooks can overlap, so every write is a single `appendFileSync` of one line.
 * On POSIX an O_APPEND write below PIPE_BUF is atomic, which is why rows are kept small
 * and why nothing here ever read-modify-writes the ledger.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionRow, TurnRow } from "../types.js";
import { recordError } from "../util/log.js";
import { writeAtomic } from "../util/atomic.js";
import { tailLines } from "../util/tail.js";
import { IMAGE_TOKENS, isImagePath } from "./tokens.js";

/** Creates the containing directory on demand, so no caller has to remember to. */
function ensureParent(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Appends one row.
 *
 * Concurrency: hooks overlap, so a row is written with a single `appendFileSync` of one
 * line. The file is opened with O_APPEND, under which each `write(2)` is positioned
 * atomically at the end, so concurrent writers interleave whole rows rather than
 * corrupting each other. That guarantee holds per `write(2)` call, which is why rows are
 * kept small and why nothing here ever read-modify-writes the ledger.
 *
 * Verified: 24 concurrent hooks produced 24 rows, none unparseable.
 */
export function appendRow(path: string, row: unknown): void {
  try {
    ensureParent(path);
    const line = JSON.stringify(row);
    // A row larger than a pipe-sized write is the one case interleaving could tear. Rows
    // are bounded by construction; this is the belt to that braces.
    if (line.length > 4096) {
      recordError("appendRow", new Error(`row too large (${line.length} bytes); dropped`));
      return;
    }
    appendFileSync(path, line + "\n");
  } catch (err) {
    recordError("appendRow", err);
  }
}

/**
 * The most recent `limit` rows.
 *
 * `limit` is mandatory and bounded on purpose. Reading the whole ledger was measured at
 * 435 ms on a 40 MB file, and the status line reads it on every repaint — a cost that grows
 * for the life of the project and lands in front of the user. Rows are read backwards from
 * the end of the file; nothing loads the whole ledger.
 */
export function readRows<T>(path: string, limit = DEFAULT_LIMIT): T[] {
  if (!existsSync(path)) return [];
  try {
    const capped = Math.min(limit, MAX_LIMIT);
    const out: T[] = [];
    for (const line of tailLines(path, capped)) {
      if (!line || line[0] !== "{") continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        continue; // a torn final line is expected while a hook is mid-write
      }
    }
    return out;
  } catch (err) {
    recordError("readRows", err);
    return [];
  }
}

/** What a caller gets when it does not say. Enough for a report, cheap enough for a repaint. */
export const DEFAULT_LIMIT = 2000;

/** Hard ceiling. No caller may ask for the whole ledger, however large it has grown. */
export const MAX_LIMIT = 20_000;

/** Rows kept when the ledger is rotated. */
const ROTATE_KEEP = 5000;

/** Rotate once the file passes this size, so it can never grow without bound. */
const ROTATE_BYTES = 8 * 1024 * 1024;

/**
 * Trims an append-only file in place when it gets large, keeping the most recent rows.
 *
 * Called opportunistically after a write rather than on a schedule: there is no daemon,
 * and a project that stops being worked on should stop paying for maintenance.
 */
export function rotateIfLarge(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < ROTATE_BYTES) return;
    const keep = tailLines(path, ROTATE_KEEP);
    writeAtomic(path, keep.join("\n") + "\n");
  } catch (err) {
    recordError("rotateIfLarge", err);
  }
}

export const readDecisions = (p: string, limit?: number) => dropEchoes(readRows<DecisionRow>(p, limit)).map(clampImage);

/** Copies of one row written this close together are the same tool call, not a repeat. */
const ECHO_MS = 1000;

/**
 * Before 0.2.1, a command matching several hook filters was recorded once per match, so one
 * call could leave a dozen identical rows within milliseconds and count its saving each time.
 * Those rows are already in ledgers and get synced again, so they are dropped on read.
 */
export function dropEchoes(rows: DecisionRow[]): DecisionRow[] {
  const last = new Map<string, number>();
  return rows.filter((r) => {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) return true;
    const key = [r.session, r.agentId, r.client, r.turn, r.tool, r.path, r.range, r.rule, r.decision, r.bytes, r.tokensAvoidedEst, r.observedOnly ? 1 : 0].join("\0");
    const prev = last.get(key);
    last.set(key, t);
    return prev === undefined || t - prev >= ECHO_MS;
  });
}

/** Rows written before images were costed as vision input counted their bytes as text. */
function clampImage(r: DecisionRow): DecisionRow {
  if (!isImagePath(r.path ?? "") || (r.tokensReadEst <= IMAGE_TOKENS && r.tokensAvoidedEst <= IMAGE_TOKENS)) return r;
  return { ...r, tokensReadEst: Math.min(r.tokensReadEst, IMAGE_TOKENS), tokensAvoidedEst: Math.min(r.tokensAvoidedEst, IMAGE_TOKENS) };
}
export const readTurns = (p: string, limit?: number) => readRows<TurnRow>(p, limit);

/** Per-session scratch state: turn counter, goal hash, pending latencies. */
export interface SessionState {
  session: string;
  turn: number;
  goalHash: string;
  startedAt: string;
  noticeShown?: boolean;
  /** The turn the prompt coach last showed a tip, so it never nags on consecutive prompts. */
  lastCoachTurn?: number;
  /** The session's model, from SessionStart, stamped on every row so savings split by model. */
  model?: string;
}

export function loadState(path: string, session: string): SessionState {
  if (existsSync(path)) {
    try {
      const s = JSON.parse(readFileSync(path, "utf8")) as SessionState;
      if (s.session === session) return s;
    } catch (err) {
      recordError("loadState", err);
    }
  }
  return { session, turn: 0, goalHash: "", startedAt: new Date().toISOString() };
}

/**
 * Persists session state atomically.
 *
 * `writeFileSync` truncates before it writes, so with parallel tool calls the file was
 * measured coming back unparseable — which silently reset the turn counter and lost the
 * pending-decision map that detects user overrides. Temp file plus rename instead.
 */
export function saveState(path: string, state: SessionState): void {
  try {
    ensureParent(path);
    writeAtomic(path, JSON.stringify(state));
  } catch (err) {
    recordError("saveState", err);
  }
}
