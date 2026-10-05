/**
 * Real spend, measured: the usage each agent records for its own requests, priced per model.
 *
 *   Claude Code  ~/.claude/projects/<project path with non-alphanumerics as "-">/**.jsonl
 *                one row per request: input, 5m/1h cache writes, cache reads, output, model
 *   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, matched to the project by the
 *                session's cwd; one token_usage_record per response, model from turn_context
 *
 * Nothing here estimates. A request with no usage recorded is not counted, and a model with
 * no known price keeps its tokens and reports no cost. Parsed totals are cached per file by
 * size and mtime, so a repaint re-reads only the session that is still growing.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { costOf, type Usage } from "./prices.js";

export interface SpendRow {
  day: string;
  client: string;
  model: string;
  requests: number;
  /** Uncached input. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** API-equivalent USD; null when the model has no known price. */
  costUsd: number | null;
}

interface Req extends Usage {
  day: string;
  model: string;
  cwd?: string;
}

const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const codexRoot = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

/** Claude Code's folder name for a project: every non-alphanumeric character becomes "-". */
export const claudeSlug = (projectDir: string) => resolve(projectDir).replace(/[^A-Za-z0-9]/g, "-");

function jsonlFiles(dir: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p, depth - 1));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function parseLines(text: string, each: (o: any) => void): void {
  for (const line of text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    try {
      each(JSON.parse(line));
    } catch {
      // a half-written final line is normal while a session is live
    }
  }
}

/** One Claude Code transcript. A request is streamed as several lines; the last carries the final usage. */
export function claudeRequests(text: string): Req[] {
  const byId = new Map<string, Req>();
  parseLines(text, (o) => {
    const m = o?.message;
    const u = m?.usage;
    if (!u || typeof m.model !== "string" || m.model.startsWith("<")) return;
    const create = u.cache_creation_input_tokens || 0;
    const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const r: Req = {
      day: String(o.timestamp || "").slice(0, 10),
      model: m.model,
      cwd: o.cwd,
      input: u.input_tokens || 0,
      cacheWrite1h: Math.min(oneHour, create),
      cacheWrite5m: create - Math.min(oneHour, create),
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
      fast: u.speed === "fast",
    };
    const id = o.requestId || m.id || o.uuid;
    const prev = byId.get(id);
    if (!prev || r.output >= prev.output) byId.set(id, r);
  });
  return [...byId.values()].filter((r) => r.day);
}

/** One Codex rollout. OpenAI counts cached tokens inside input_tokens; they are split out here. */
export function codexRequests(text: string): { cwd: string | null; reqs: Req[] } {
  let cwd: string | null = null;
  let model = "unknown";
  const byId = new Map<string, Req>();
  let lastTotal = -1;
  const add = (id: string, ts: string, u: any) => {
    const cached = u.cached_input_tokens || 0;
    const write = u.cache_write_input_tokens || 0;
    byId.set(id, {
      day: String(ts || "").slice(0, 10),
      model,
      input: Math.max(0, (u.input_tokens || 0) - cached - write),
      cacheWrite5m: write,
      cacheWrite1h: 0,
      cacheRead: cached,
      output: u.output_tokens || 0, // includes reasoning tokens, which bill as output
    });
  };
  let sawRecords = false;
  const fallback: [string, string, any][] = [];
  parseLines(text, (o) => {
    const p = o?.payload ?? {};
    if (o.type === "session_meta" && typeof p.cwd === "string") cwd = p.cwd;
    else if (o.type === "turn_context" && typeof p.model === "string") model = p.model;
    else if (o.type === "token_usage_record" && p.usage) {
      sawRecords = true;
      add(p.response_id || `${byId.size}`, o.timestamp, p.usage);
    } else if (o.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) {
      // Older Codex versions only emit running counts; each change in the total is one response.
      const total = p.info.total_token_usage?.total_tokens ?? -1;
      if (total !== lastTotal) {
        lastTotal = total;
        fallback.push([`tc${fallback.length}`, o.timestamp, p.info.last_token_usage]);
      }
    }
  });
  if (!sawRecords) for (const [id, ts, u] of fallback) add(id, ts, u);
  return { cwd, reqs: [...byId.values()].filter((r) => r.day) };
}

// --- cache ------------------------------------------------------------------------------

interface CacheEntry {
  stamp: string;
  client: string;
  cwd: string | null;
  rows: SpendRow[];
}

function rollup(reqs: Req[], client: string, configDir?: string): SpendRow[] {
  const m = new Map<string, SpendRow>();
  for (const r of reqs) {
    const key = `${r.day}\0${r.model}`;
    const s = m.get(key) ?? { day: r.day, client, model: r.model, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0 };
    s.requests += 1;
    s.input += r.input;
    s.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
    s.cacheRead += r.cacheRead;
    s.output += r.output;
    const c = costOf(r.model, r, configDir);
    s.costUsd = c === null || s.costUsd === null ? null : s.costUsd + c;
    m.set(key, s);
  }
  return [...m.values()];
}

function loadCache(path: string): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function fileRows(file: string, client: "claude" | "codex", cache: Record<string, CacheEntry>, configDir?: string): CacheEntry | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache[file];
  if (hit && hit.stamp === stamp) return hit;
  const text = readFileSync(file, "utf8");
  let entry: CacheEntry;
  if (client === "claude") {
    const reqs = claudeRequests(text);
    entry = { stamp, client, cwd: reqs.find((r) => r.cwd)?.cwd ?? null, rows: rollup(reqs, client, configDir) };
  } else {
    const { cwd, reqs } = codexRequests(text);
    entry = { stamp, client, cwd, rows: rollup(reqs, client, configDir) };
  }
  cache[file] = entry;
  return entry;
}

const inside = (child: string | null, parent: string) => !!child && (child === parent || child.startsWith(parent + sep));

/**
 * Spend for one project, or for every project on the machine with `projectDir` null, keyed by
 * project folder. `cachePath` holds parsed totals between calls; null parses without caching
 * (a read-only command must not create state where it runs).
 */
export function readSpend(projectDir: string | null, cachePath: string | null, configDir?: string): Map<string, SpendRow[]> {
  const cache = cachePath ? loadCache(cachePath) : {};
  const out = new Map<string, SpendRow[]>();
  const push = (cwd: string, rows: SpendRow[]) => out.set(cwd, [...(out.get(cwd) ?? []), ...rows]);
  const root = projectDir ? resolve(projectDir) : null;

  const claudeDirs = root ? [join(claudeRoot(), claudeSlug(root))] : existsSync(claudeRoot()) ? readdirSync(claudeRoot()).map((d) => join(claudeRoot(), d)) : [];
  for (const dir of claudeDirs) {
    for (const f of jsonlFiles(dir)) {
      const e = fileRows(f, "claude", cache, configDir);
      if (!e || !e.rows.length) continue;
      push(root ?? e.cwd ?? dir, e.rows);
    }
  }
  for (const f of jsonlFiles(codexRoot())) {
    const e = fileRows(f, "codex", cache, configDir);
    if (!e || !e.rows.length) continue;
    if (root && !inside(e.cwd, root)) continue;
    push(root ?? e.cwd ?? "unknown", e.rows);
  }

  // Drop entries for files that no longer exist, so the cache cannot grow forever.
  for (const k of Object.keys(cache)) if (!existsSync(k)) delete cache[k];
  if (cachePath) try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    // an unwritable cache only costs a re-parse next time
  }
  for (const [k, rows] of out) out.set(k, merge(rows));
  return out;
}

/** Rows for the same day, agent and model, from different session files, as one. */
export function merge(rows: SpendRow[]): SpendRow[] {
  const m = new Map<string, SpendRow>();
  for (const r of rows) {
    const key = `${r.day}\0${r.client}\0${r.model}`;
    const s = m.get(key);
    if (!s) {
      m.set(key, { ...r });
      continue;
    }
    s.requests += r.requests;
    s.input += r.input;
    s.cacheWrite += r.cacheWrite;
    s.cacheRead += r.cacheRead;
    s.output += r.output;
    s.costUsd = s.costUsd === null || r.costUsd === null ? null : s.costUsd + r.costUsd;
  }
  return [...m.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : 1));
}
