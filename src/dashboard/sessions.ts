/**
 * Agent sessions as the dashboard shows them, read from the agents' own transcripts:
 *
 *   Claude Code  ~/.claude/projects/<slug>/<session>.jsonl, plus <session>/subagents/agent-*.jsonl
 *   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, matched to the project by cwd
 *
 * What comes out is measured: each request's model and billed usage, each tool call with its
 * start, end, size of result and error flag, the user's prompts, compactions and turn ends.
 * Nothing is estimated here; Snout's own decisions are joined in later from the ledger.
 *
 * Transcripts only grow, so each file is parsed incrementally from the byte offset reached last
 * time. A live session costs one read of its new lines per refresh. Everything stays on the
 * machine; prompts and commands are kept short (PROMPT_CHARS, TARGET_CHARS) and only for the
 * local page.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { costOf } from "../spend/prices.js";
import { claudeRoot, claudeSlug, codexRoot, jsonlFiles } from "../spend/usage.js";

const PROMPT_CHARS = 400;
const TARGET_CHARS = 240;
/** Read at most this much of a new file at once; a 100 MB transcript is parsed in slices. */
const SLICE = 8 << 20;

export type Client = "claude" | "codex";

export interface RequestRec {
  ts: string;
  model: string;
  /** Uncached input. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** API-equivalent USD at list price; null when the model has no known price. */
  costUsd: number | null;
  /** Set for a subagent's request. */
  agent?: string;
}

export interface ToolRec {
  id: string;
  ts: string;
  /** When the result came back; absent while the call is still running. */
  endTs?: string;
  name: string;
  /** What the call worked on: a path, a command, a pattern or a URL, shortened. */
  target: string;
  /** Size of the result the agent received, in bytes. */
  resultBytes: number;
  error: boolean;
  agent?: string;
}

export interface PromptRec {
  ts: string;
  text: string;
}

export interface CompactionRec {
  ts: string;
  trigger: string;
  preTokens: number | null;
  postTokens: number | null;
}

export interface TurnEndRec {
  ts: string;
  durationMs: number | null;
}

export interface SubagentRec {
  id: string;
  type: string;
  first: string;
  last: string;
}

export interface SessionLog {
  id: string;
  client: Client;
  cwd: string | null;
  title: string;
  /** Claude Code's entrypoint (cli, sdk-cli, ...) or Codex's originator (Codex Desktop, codex_cli_rs, ...). */
  surface: string;
  /** Codex turn trigger when it says where the turn came from (remote_ios, ...). */
  trigger: string;
  version: string;
  branch: string;
  first: string;
  last: string;
  prompts: PromptRec[];
  requests: RequestRec[];
  tools: ToolRec[];
  compactions: CompactionRec[];
  turnEnds: TurnEndRec[];
  subagents: SubagentRec[];
}

const short = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function bytesOf(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content);
  if (Array.isArray(content)) {
    let n = 0;
    for (const c of content) {
      if (typeof c === "string") n += Buffer.byteLength(c);
      else if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        if (typeof o.text === "string") n += Buffer.byteLength(o.text);
        else if (o.type === "image") n += 6400; // a vision block; its bytes are base64 we do not count
      }
    }
    return n;
  }
  return 0;
}

/** The part of a tool's input a person would recognise it by. */
export function targetOf(name: string, input: unknown): string {
  if (typeof input === "string") {
    try {
      return targetOf(name, JSON.parse(input));
    } catch {
      return short(input, TARGET_CHARS);
    }
  }
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "notebook_path", "path", "command", "cmd", "pattern", "url", "query", "description", "prompt", "skill"]) {
    const v = o[k];
    if (typeof v === "string" && v) return short(v, TARGET_CHARS);
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return short(v.join(" "), TARGET_CHARS);
  }
  return "";
}

/** A user message that is the person typing, not a tool result, a reminder or a command echo. */
function promptText(content: unknown): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((c) => c && typeof c === "object" && (c as { type?: string }).type === "tool_result")) return "";
    text = content
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  // Pasted blocks keep their text but lose the wrapper tags, so titles read like the prompt.
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<\/?pasted_content[^>]*>/g, " ").trim();
  if (!text || text.startsWith("<local-command") || text.startsWith("Caveat:")) return "";
  // A background task finishing starts a turn of its own; title it by the task's summary.
  if (text.startsWith("<task-notification>")) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
    return short(!summary ? "Background task finished" : /^background/i.test(summary) ? summary : `Background task: ${summary}`, PROMPT_CHARS);
  }
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (cmd) return short(cmd[1]!, PROMPT_CHARS);
  return short(text, PROMPT_CHARS);
}

/** Parser state for one transcript, fed lines as the file grows. */
class Parser {
  log: SessionLog;
  private open = new Map<string, ToolRec>();
  private reqs = new Map<string, RequestRec>();
  private codexModel = "unknown";
  private codexTurnStart = new Map<string, string>();
  constructor(id: string, client: Client, private configDir: string | undefined, private agent?: string) {
    this.log = { id, client, cwd: null, title: "", surface: "", trigger: "", version: "", branch: "", first: "", last: "", prompts: [], requests: [], tools: [], compactions: [], turnEnds: [], subagents: [] };
  }

  private seen(ts: unknown): string {
    const t = typeof ts === "string" ? ts : "";
    if (t) {
      if (!this.log.first || t < this.log.first) this.log.first = t;
      if (t > this.log.last) this.log.last = t;
    }
    return t;
  }

  private request(key: string, r: RequestRec): void {
    const prev = this.reqs.get(key);
    if (prev) {
      // Claude Code streams one request over several lines; the last has the final output count.
      // The first line's time is kept: it is when the request's tool calls start.
      if (r.output >= prev.output) Object.assign(prev, { ...r, ts: prev.ts });
      return;
    }
    this.reqs.set(key, r);
    this.log.requests.push(r);
  }

  line(o: any): void {
    if (this.log.client === "claude") this.claude(o);
    else this.codex(o);
  }

  private claude(o: any): void {
    const ts = this.seen(o.timestamp);
    if (typeof o.cwd === "string") this.log.cwd ??= o.cwd;
    if (typeof o.version === "string") this.log.version = o.version;
    if (typeof o.gitBranch === "string" && o.gitBranch) this.log.branch = o.gitBranch;
    if (typeof o.entrypoint === "string") this.log.surface = o.entrypoint;
    if (o.type === "ai-title" && typeof o.aiTitle === "string") this.log.title = short(o.aiTitle, 120);
    const agent = this.agent ?? (o.isSidechain ? "sidechain" : undefined);
    if (o.type === "system") {
      if (o.subtype === "compact_boundary") {
        const m = o.compactMetadata ?? {};
        this.log.compactions.push({ ts, trigger: String(m.trigger ?? "auto"), preTokens: num(m.preTokens), postTokens: num(m.postTokens) });
      } else if (o.subtype === "turn_duration" && !agent) {
        this.log.turnEnds.push({ ts, durationMs: num(o.durationMs) });
      }
      return;
    }
    const m = o.message;
    if (!m) return;
    if (o.type === "assistant") {
      const u = m.usage;
      if (u && typeof m.model === "string" && !m.model.startsWith("<")) {
        const create = u.cache_creation_input_tokens || 0;
        const oneHour = Math.min(u.cache_creation?.ephemeral_1h_input_tokens ?? 0, create);
        const usage = { input: u.input_tokens || 0, cacheWrite5m: create - oneHour, cacheWrite1h: oneHour, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, fast: u.speed === "fast" };
        this.request(String(o.requestId || m.id || o.uuid), {
          ts, model: m.model, input: usage.input, cacheWrite: create, cacheRead: usage.cacheRead, output: usage.output,
          costUsd: costOf(m.model, usage, this.configDir), ...(agent ? { agent } : {}),
        });
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c?.type !== "tool_use" || typeof c.id !== "string" || this.open.has(c.id)) continue;
          const t: ToolRec = { id: c.id, ts, name: String(c.name ?? "tool"), target: targetOf(String(c.name ?? ""), c.input), resultBytes: 0, error: false, ...(agent ? { agent } : {}) };
          this.open.set(c.id, t);
          this.log.tools.push(t);
        }
      }
      return;
    }
    if (o.type === "user") {
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c?.type !== "tool_result") continue;
          const t = this.open.get(String(c.tool_use_id));
          if (!t) continue;
          t.endTs = ts;
          t.resultBytes = bytesOf(c.content);
          t.error = c.is_error === true;
        }
      }
      if (!agent && !o.isMeta && !o.isCompactSummary) {
        const text = promptText(m.content);
        if (text) this.log.prompts.push({ ts, text });
      }
    }
  }

  private codex(o: any): void {
    const ts = this.seen(o.timestamp);
    const p = o.payload ?? {};
    if (o.type === "session_meta") {
      if (typeof p.cwd === "string") this.log.cwd = p.cwd;
      if (typeof p.originator === "string") this.log.surface = p.originator;
      if (typeof p.cli_version === "string") this.log.version = p.cli_version;
      if (typeof p.git?.branch === "string") this.log.branch = p.git.branch;
      return;
    }
    if (o.type === "turn_context") {
      if (typeof p.model === "string") this.codexModel = p.model;
      if (typeof p.cwd === "string") this.log.cwd ??= p.cwd;
      return;
    }
    if (o.type === "compacted") {
      this.log.compactions.push({ ts, trigger: "auto", preTokens: null, postTokens: null });
      return;
    }
    if (o.type === "token_usage_record" && p.usage) {
      const u = p.usage;
      const cached = u.cached_input_tokens || 0;
      const write = u.cache_write_input_tokens || 0;
      const usage = { input: Math.max(0, (u.input_tokens || 0) - cached - write), cacheWrite5m: write, cacheWrite1h: 0, cacheRead: cached, output: u.output_tokens || 0 };
      this.request(String(p.response_id || `r${this.reqs.size}`), {
        ts, model: this.codexModel, input: usage.input, cacheWrite: write, cacheRead: cached, output: usage.output, costUsd: costOf(this.codexModel, usage, this.configDir),
      });
      return;
    }
    if (o.type === "event_msg") {
      if (p.type === "task_started") {
        if (typeof p.turn_attribution?.turn_trigger === "string") this.log.trigger = p.turn_attribution.turn_trigger;
        if (typeof p.turn_id === "string") this.codexTurnStart.set(p.turn_id, ts);
      } else if (p.type === "task_complete") {
        const start = typeof p.turn_id === "string" ? this.codexTurnStart.get(p.turn_id) : undefined;
        this.log.turnEnds.push({ ts, durationMs: start ? Date.parse(ts) - Date.parse(start) : null });
      }
      return;
    }
    if (o.type !== "response_item") return;
    if (p.type === "message" && p.role === "user") {
      const text = Array.isArray(p.content) ? p.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n").trim() : "";
      // Codex puts its environment and AGENTS.md into user messages; those are not the person typing.
      if (text && !/^(<environment_context>|<user_instructions>|# AGENTS\.md|<permissions)/.test(text)) this.log.prompts.push({ ts, text: short(text, PROMPT_CHARS) });
      return;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const id = String(p.call_id ?? p.id ?? `c${this.log.tools.length}`);
      if (this.open.has(id)) return;
      const input = p.type === "local_shell_call" ? p.action : (p.arguments ?? p.input);
      const t: ToolRec = { id, ts, name: String(p.name ?? (p.type === "local_shell_call" ? "shell" : "tool")), target: targetOf(String(p.name ?? ""), input), resultBytes: 0, error: false };
      this.open.set(id, t);
      this.log.tools.push(t);
      return;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
      const t = this.open.get(String(p.call_id ?? ""));
      if (!t) return;
      t.endTs = ts;
      const out = p.output;
      t.resultBytes = typeof out === "string" ? Buffer.byteLength(out) : bytesOf(out);
      t.error = typeof out === "string" ? /"exit_code":\s*[1-9]/.test(out) : false;
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface FileState {
  size: number;
  offset: number;
  rest: string;
  parser: Parser;
}

/**
 * Reads and caches transcripts. One instance per dashboard server; `sessions()` returns every
 * session of a project, re-reading only bytes added since the last call.
 */
export class SessionStore {
  private files = new Map<string, FileState>();
  private codexCwd = new Map<string, { stamp: string; cwd: string | null }>();
  constructor(private configDir?: string) {}

  private feed(file: string, id: string, client: Client, agent?: string): Parser | null {
    let st;
    try {
      st = statSync(file);
    } catch {
      this.files.delete(file);
      return null;
    }
    let s = this.files.get(file);
    if (!s || st.size < s.size) {
      s = { size: 0, offset: 0, rest: "", parser: new Parser(id, client, this.configDir, agent) };
      this.files.set(file, s);
    }
    if (st.size > s.offset) {
      const fd = openSync(file, "r");
      try {
        while (s.offset < st.size) {
          const len = Math.min(SLICE, st.size - s.offset);
          const buf = Buffer.alloc(len);
          const n = readSync(fd, buf, 0, len, s.offset);
          if (n <= 0) break;
          s.offset += n;
          const text = s.rest + buf.subarray(0, n).toString("utf8");
          const lines = text.split("\n");
          s.rest = lines.pop() ?? "";
          for (const l of lines) {
            if (!l || l[0] !== "{") continue;
            try {
              s.parser.line(JSON.parse(l));
            } catch {
              // a damaged line is skipped, the rest of the session still counts
            }
          }
        }
      } finally {
        closeSync(fd);
      }
    }
    s.size = st.size;
    return s.parser;
  }

  private codexFiles(root: string): string[] {
    const out: string[] = [];
    for (const f of jsonlFiles(codexRoot())) {
      let stamp = "";
      try {
        stamp = String(statSync(f).size);
      } catch {
        continue;
      }
      let hit = this.codexCwd.get(f);
      if (!hit) {
        hit = { stamp, cwd: firstCwd(f) };
        this.codexCwd.set(f, hit);
      }
      if (hit.cwd && inside(resolve(hit.cwd), root)) out.push(f);
    }
    return out;
  }

  /** Every Claude Code and Codex session recorded for this project, newest activity first. */
  sessions(projectDir: string): SessionLog[] {
    const root = resolve(projectDir);
    const out: SessionLog[] = [];
    const dir = join(claudeRoot(), claudeSlug(root));
    if (existsSync(dir)) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const id = e.name.slice(0, -6);
        const main = this.feed(join(dir, e.name), id, "claude");
        if (!main) continue;
        const log: SessionLog = { ...main.log, requests: [...main.log.requests], tools: [...main.log.tools], subagents: [] };
        const subDir = join(dir, id, "subagents");
        if (existsSync(subDir)) {
          for (const f of readdirSync(subDir)) {
            if (!f.endsWith(".jsonl")) continue;
            const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
            const sub = this.feed(join(subDir, f), id, "claude", agentId);
            if (!sub) continue;
            log.requests.push(...sub.log.requests);
            log.tools.push(...sub.log.tools);
            log.subagents.push({ id: agentId, type: subagentType(join(subDir, f.replace(/\.jsonl$/, ".meta.json"))), first: sub.log.first, last: sub.log.last });
            if (sub.log.last > log.last) log.last = sub.log.last;
          }
          log.requests.sort((a, b) => (a.ts < b.ts ? -1 : 1));
          log.tools.sort((a, b) => (a.ts < b.ts ? -1 : 1));
        }
        if (log.first) out.push(log);
      }
    }
    for (const f of this.codexFiles(root)) {
      const p = this.feed(f, codexId(f), "codex");
      if (p && p.log.first) out.push(p.log);
    }
    return out.sort((a, b) => (a.last < b.last ? 1 : -1));
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

function firstCwd(file: string): string | null {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    for (const l of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!l.includes("session_meta") && !l.includes("turn_context")) continue;
      try {
        const cwd = JSON.parse(l)?.payload?.cwd;
        if (typeof cwd === "string") return cwd;
      } catch {
        // a long first line cut by the buffer
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(l);
        if (m) return JSON.parse(`"${m[1]}"`);
      }
    }
  } catch {
    // unreadable file: not this project's
  }
  return null;
}

/** `rollout-2026-10-20T08-03-53-<uuid>.jsonl` → the session's id as Codex hooks report it. */
function codexId(file: string): string {
  const name = basename(file, ".jsonl");
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?$/.exec(name);
  return m ? m[1]! : name;
}

function subagentType(metaFile: string): string {
  try {
    const m = JSON.parse(readFileSync(metaFile, "utf8"));
    return String(m.agentType ?? m.subagent_type ?? m.type ?? "subagent");
  } catch {
    return "subagent";
  }
}

/** Every project folder the agents on this machine have worked in, from the transcripts' cwd. */
export function knownProjects(): { dir: string; client: Client; last: string }[] {
  const seen = new Map<string, { dir: string; client: Client; last: string }>();
  const note = (dir: string | null, client: Client, mtime: number) => {
    if (!dir) return;
    const key = resolve(dir);
    const last = new Date(mtime).toISOString();
    const prev = seen.get(key);
    if (!prev || prev.last < last) seen.set(key, { dir: key, client, last });
  };
  const root = claudeRoot();
  if (existsSync(root)) {
    for (const d of readdirSync(root)) {
      const dir = join(root, d);
      let newest: { f: string; m: number } | null = null;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const m = statSync(join(dir, f)).mtimeMs;
          if (!newest || m > newest.m) newest = { f: join(dir, f), m };
        }
      } catch {
        continue;
      }
      if (newest) note(claudeCwd(newest.f), "claude", newest.m);
    }
  }
  for (const f of jsonlFiles(codexRoot())) {
    try {
      note(firstCwd(f), "codex", statSync(f).mtimeMs);
    } catch {
      // gone
    }
  }
  return [...seen.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}

function claudeCwd(file: string): string | null {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString("utf8"));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch {
    return null;
  }
}
