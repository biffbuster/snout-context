/**
 * The dashboard's data that needs the disk: one cached reader per project (ledger, recall log,
 * agent transcripts) and the pages built from local state (projects, integrations, environment,
 * settings, privacy). views.ts turns the records into numbers; this file finds the records.
 *
 * Everything here reads; nothing writes. Status shown on the page comes from a file or a log line
 * that proves it (a hook heartbeat, a config entry, a credentials file), never from a guess.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, platform, release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configDir, configSource, DEFAULTS, loadConfig, userConfigPath, type Config, type Paths } from "../config.js";
import { MAX_LIMIT, readDecisions, readRows } from "../ledger/store.js";
import { configuredServers } from "../audit/mcp-servers.js";
import { PRICES, PRICES_AS_OF, modelKey, priceOf } from "../spend/prices.js";
import type { DecisionRow } from "../types.js";
import { knownProjects, SessionStore, type SessionLog } from "./sessions.js";
import { mcpServerOf } from "./summary.js";
import { environmentOf, providerOf, type Inputs, type RecallRow } from "./views.js";
import type { Boot, EnvironmentView, Integration, PrivacyView, ProjectRef, SettingsView } from "./api.js";

const ROWS = 20_000;
/** Transcripts are re-scanned at most this often; the store reads only what was appended. */
const SESSIONS_MS = 1500;
/** A hook heartbeat this recent means the agent is wired to Snout right now. */
const HEARTBEAT_DAYS = 7;
const DAY = 86_400_000;

const stampOf = (file: string): string => {
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "none";
  }
};

export const projectId = (dir: string): string => createHash("sha256").update(resolve(dir).toLowerCase()).digest("hex").slice(0, 12);

/** One project's records, re-read only when a file changed. */
export class ProjectData {
  private rows: DecisionRow[] = [];
  private rowsAt = "";
  private recall: RecallRow[] = [];
  private recallAt = "";
  private sessions: SessionLog[] = [];
  private sessionsAt = 0;
  private sessionsKey = "";

  constructor(readonly paths: Paths, private readonly store: SessionStore) {}

  get dir(): string {
    return this.paths.projectDir;
  }

  get recallFile(): string {
    return join(this.paths.snoutDir, "recall.jsonl");
  }

  ledger(): DecisionRow[] {
    const v = stampOf(this.paths.ledger);
    if (v !== this.rowsAt) {
      this.rowsAt = v;
      this.rows = v === "none" ? [] : readDecisions(this.paths.ledger, ROWS);
    }
    return this.rows;
  }

  recalls(): RecallRow[] {
    const v = stampOf(this.recallFile);
    if (v !== this.recallAt) {
      this.recallAt = v;
      this.recall = v === "none" ? [] : readRows<RecallRow>(this.recallFile, ROWS);
    }
    return this.recall;
  }

  logs(): SessionLog[] {
    if (Date.now() - this.sessionsAt > SESSIONS_MS) {
      this.sessionsAt = Date.now();
      try {
        this.sessions = this.store.sessions(this.dir);
      } catch {
        this.sessions = []; // no agent logs is a normal state
      }
      this.sessionsKey = this.sessions.map((s) => `${s.id}:${s.last}:${s.requests.length}:${s.tools.length}`).join("|");
    }
    return this.sessions;
  }

  /** Changes whenever anything the pages show changed: the page refetches on a new value. */
  version(): string {
    this.logs();
    return createHash("sha1").update(`${stampOf(this.paths.ledger)}|${stampOf(this.recallFile)}|${stampOf(this.paths.config)}|${this.sessionsKey}`).digest("hex").slice(0, 16);
  }

  inputs(now = new Date()): Inputs {
    const cfg = loadConfig(this.paths);
    return { rows: this.ledger(), sessions: this.logs(), recall: this.recalls(), mode: cfg.mode, configDir: configDir(), now };
  }
}

/** Every project on this machine an agent worked in, plus the one this dashboard was started for. */
export class Projects {
  private list: ProjectRef[] = [];
  private listedAt = 0;
  private readonly data = new Map<string, ProjectData>();

  constructor(readonly current: Paths, readonly store = new SessionStore()) {
    this.data.set(projectId(current.projectDir), new ProjectData(current, store));
  }

  refs(): ProjectRef[] {
    if (Date.now() - this.listedAt > 60_000 || !this.list.length) {
      this.listedAt = Date.now();
      const seen = new Map<string, ProjectRef>();
      const add = (dir: string, last: string) => {
        // Benchmark fixtures live inside another project's .snout folder; they are not projects.
        // Neither are throwaway folders in the system temp dir.
        const isCurrent = resolve(dir) === resolve(this.current.projectDir);
        if (!isCurrent && (/[\\/]\.snout[\\/]/.test(dir) || resolve(dir).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()))) return;
        const id = projectId(dir);
        const prev = seen.get(id);
        if (prev) {
          if (last > prev.last) prev.last = last;
          return;
        }
        seen.set(id, { id, name: basename(dir) || dir, dir, snout: existsSync(join(dir, ".snout", "ledger.jsonl")), current: resolve(dir) === resolve(this.current.projectDir), last, remote: remoteOf(dir) });
      };
      add(this.current.projectDir, new Date(statMs(this.current.ledger)).toISOString());
      try {
        for (const p of knownProjects()) if (existsSync(p.dir) && resolve(p.dir) !== resolve(homedir())) add(p.dir, p.last);
      } catch {
        // no transcripts: just this project
      }
      this.list = [...seen.values()].sort((a, b) => Number(b.current) - Number(a.current) || (a.last < b.last ? 1 : -1));
    }
    return this.list;
  }

  /** A project by id, only from the discovered list: the page cannot name an arbitrary folder. */
  get(id: string | null): ProjectData | null {
    const want = id || projectId(this.current.projectDir);
    let d = this.data.get(want);
    if (d) return d;
    const ref = this.refs().find((r) => r.id === want);
    if (!ref) return null;
    d = new ProjectData(pathsFor(ref.dir), this.store);
    this.data.set(want, d);
    return d;
  }

  ref(id: string | null): ProjectRef {
    const want = id || projectId(this.current.projectDir);
    return this.refs().find((r) => r.id === want) ?? this.refs()[0]!;
  }
}

function statMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Paths for another project's records. Built directly: resolvePaths may move a legacy folder, and this only reads. */
function pathsFor(dir: string): Paths {
  const projectDir = resolve(dir);
  const snoutDir = join(projectDir, ".snout");
  const f = (n: string) => join(snoutDir, n);
  return { projectDir, snoutDir, config: f("config.json"), thresholds: f("thresholds.json"), ledger: f("ledger.jsonl"), turns: f("turns.jsonl"), errors: f("errors.jsonl"), hooks: f("hooks.jsonl"), state: f("state.json"), map: f("map.json") };
}

/** The repo's origin, credentials stripped, as a display string ("github.com/owner/repo"). */
export function remoteOf(dir: string): string | null {
  try {
    const cfg = readFileSync(join(dir, ".git", "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    if (!m) return null;
    return m[1]!
      .replace(/^[a-z+]+:\/\/([^@/]+@)?/i, "")
      .replace(/^[^@]+@([^:]+):/, "$1/")
      .replace(/\.git$/, "");
  } catch {
    return null;
  }
}

function branchOf(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 7);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- boot

interface CloudFile {
  url?: string;
  user?: string;
  team?: string;
}

/** Snout Cloud state from the credentials file `snout login` writes. The token is never read out. */
export function cloudState(): Boot["cloud"] {
  try {
    const c = JSON.parse(readFileSync(join(configDir(), "cloud.json"), "utf8")) as CloudFile & { token?: string };
    let lastSync: string | null = null;
    try {
      lastSync = new Date(statSync(join(configDir(), "cloud-sync.json")).mtimeMs).toISOString();
    } catch {
      // never synced
    }
    return { connected: !!(c.url && c.token), url: c.url ?? null, team: c.team ?? null, user: c.user ?? null, lastSync };
  } catch {
    return { connected: false, url: null, team: null, user: null, lastSync: null };
  }
}

// ---------------------------------------------------------------- integrations

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

interface Heartbeat {
  ts: string;
  event: string;
  session?: string;
}

/** Which clients' hooks reached Snout lately, from hooks.jsonl joined to the sessions they came from. */
function heartbeats(d: ProjectData): Map<string, { last: string; events: Set<string> }> {
  const out = new Map<string, { last: string; events: Set<string> }>();
  const since = new Date(Date.now() - HEARTBEAT_DAYS * DAY).toISOString();
  const client = new Map(d.logs().map((s) => [s.id, s.client]));
  const fromLedger = new Map(d.ledger().map((r) => [r.session, r.client ?? "claude"]));
  for (const h of readRows<Heartbeat>(d.paths.hooks, 4000)) {
    if (!h.ts || h.ts < since) continue;
    const c = (h.session && (client.get(h.session) ?? fromLedger.get(h.session))) || (h.event.includes("codex") ? "codex" : "claude");
    const e = out.get(c) ?? { last: h.ts, events: new Set<string>() };
    if (h.ts > e.last) e.last = h.ts;
    e.events.add(h.event);
    out.set(c, e);
  }
  return out;
}

/**
 * Claude Code loads a plugin's hooks when a session starts. Reinstalling or updating Snout during
 * a long session can leave that session calling the fast gate (settings hooks) but not the plugin's
 * own hooks, which carry memory and briefs. Seen as: prompts keep arriving in
 * the transcripts while prompt-submit heartbeats stop. Returns a sentence for the page, or null.
 */
export function pluginHookGap(d: ProjectData): string | null {
  if (!claudePlugin(d.dir)) return null;
  let lastHook = "";
  // The fast gate writes a heartbeat per tool call, so look far back for the plugin's own.
  for (const h of readRows<Heartbeat>(d.paths.hooks, MAX_LIMIT)) if ((h.event === "prompt-submit" || h.event === "session-start") && h.ts > lastHook) lastHook = h.ts;
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const missed = d.logs().filter((s) => s.client === "claude").flatMap((s) => s.prompts.filter((p) => p.ts >= since && p.ts > lastHook && (!lastHook || Date.parse(p.ts) - Date.parse(lastHook) > 3600_000)));
  if (missed.length < 3) return null;
  return `Snout's plugin hooks (memory, briefs) have not run ${lastHook ? `since ${new Date(lastHook).toLocaleString()}` : "recently"}, across ${missed.length} prompts. Start a new Claude Code session, or run /plugin and re-enable snout, to load them again.`;
}

function claudePlugin(dir: string): { version: string | null; scope: string } | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8")) as { plugins?: Record<string, { scope?: string; projectPath?: string; version?: string }[]> };
    for (const [name, list] of Object.entries(j.plugins ?? {})) {
      if (!name.startsWith("snout@")) continue;
      for (const p of list) if (p.scope === "user" || !p.projectPath || resolve(p.projectPath) === resolve(dir)) return { version: p.version ?? null, scope: p.scope ?? "user" };
    }
  } catch {
    // not installed as a plugin
  }
  return null;
}

const hasSnoutHook = (file: string, agent: string) => new RegExp(`snout[\\s\\S]*\\bhook ${agent}\\b`).test(read(file));
const claudeGate = (dir: string) => ["settings.json", "settings.local.json"].some((f) => /snout/i.test(read(join(dir, ".claude", f))) && /PreToolUse/.test(read(join(dir, ".claude", f))));

export function integrations(d: ProjectData): Integration[] {
  const dir = d.dir;
  const cfg = loadConfig(d.paths);
  const beats = heartbeats(d);
  const logs = d.logs();
  const used = (c: string) => logs.filter((s) => s.client === c);
  const lastOf = (ss: SessionLog[]) => ss.reduce<string | null>((a, s) => (!a || s.last > a ? s.last : a), null);
  const out: Integration[] = [];

  // Agents
  const plugin = claudePlugin(dir);
  const gate = claudeGate(dir);
  const cb = beats.get("claude");
  const cs = used("claude");
  out.push({
    id: "agent:claude", name: "Claude Code", kind: "agent",
    status: cb ? "connected" : plugin || gate ? "installed" : cs.length ? "available" : "off",
    detail: cb ? `Hooks reached Snout ${ago(cb.last)}` : plugin ? "Plugin installed; no hook calls from this project in the last week" : gate ? "Gate in .claude settings; no hook calls in the last week" : cs.length ? "Used in this project; Snout is not set up for it" : "No sessions in this project",
    version: plugin?.version ?? null,
    capabilities: [
      { name: "File reads gated", on: !!(plugin || gate) },
      { name: "Command and MCP output trimmed", on: !!(plugin || gate) && cfg.mode !== "observe" },
      { name: "Repeat reads answered with a pointer", on: cfg.repeatReads !== false },
      { name: "Memory across sessions", on: cfg.memory !== false },
    ],
    telemetry: ["Usage and cost from ~/.claude/projects transcripts", "Snout decisions from .snout/ledger.jsonl"],
    last: lastOf(cs), setup: plugin || gate ? null : "/plugin marketplace add biffbuster/snout-context then /plugin install snout", errors: [pluginHookGap(d)].filter((x): x is string => !!x),
  });
  const xb = beats.get("codex");
  const xs = used("codex");
  const codexHooks = hasSnoutHook(join(dir, ".codex", "hooks.json"), "codex");
  out.push({
    id: "agent:codex", name: "Codex", kind: "agent",
    status: xb ? "connected" : codexHooks ? "installed" : xs.length ? "available" : "off",
    detail: xb ? `Hooks reached Snout ${ago(xb.last)}` : codexHooks ? "Hooks in .codex/hooks.json; no hook calls in the last week" : xs.length ? "Used in this project; Snout is not set up for it" : "No sessions in this project",
    version: xs.at(-1)?.version || null,
    capabilities: [
      { name: "Shell reads gated", on: codexHooks },
      { name: "Tool output trimmed", on: codexHooks && cfg.mode !== "observe" },
      { name: "Memory across sessions", on: codexHooks && cfg.memory !== false },
    ],
    telemetry: ["Usage and cost from ~/.codex/sessions rollouts", "Snout decisions from .snout/ledger.jsonl"],
    last: lastOf(xs), setup: codexHooks ? null : "snout init codex", errors: [],
  });
  for (const [agent, name, file] of [["cursor", "Cursor", join(dir, ".cursor", "hooks.json")], ["gemini", "Gemini CLI", join(dir, ".gemini", "settings.json")]] as const) {
    const on = hasSnoutHook(file, agent);
    const b = beats.get(agent);
    out.push({
      id: `agent:${agent}`, name, kind: "agent", status: b ? "connected" : on ? "installed" : "off",
      detail: b ? `Hooks reached Snout ${ago(b.last)}` : on ? `Hooks in ${file.slice(dir.length + 1)}` : "Not set up in this project",
      version: null, capabilities: [{ name: "File and shell reads gated", on }], telemetry: on ? ["Snout decisions from .snout/ledger.jsonl", "No usage logs read: cost is not shown for this agent"] : [],
      last: b?.last ?? null, setup: on ? null : `snout init ${agent}`, errors: [],
    });
  }

  // MCP servers: configured ones, plus any that show up in the ledger or transcripts.
  const calls = new Map<string, { n: number; last: string }>();
  const bump = (server: string | null, ts: string) => {
    if (!server) return;
    const c = calls.get(server) ?? { n: 0, last: ts };
    c.n += 1;
    if (ts > c.last) c.last = ts;
    calls.set(server, c);
  };
  for (const s of logs) for (const t of s.tools) bump(mcpServerOf(t.name), t.ts);
  const trimmed = new Map<string, number>();
  for (const r of d.ledger()) {
    const server = mcpServerOf(r.tool);
    if (server && r.rule === "mcp-output" && !r.observedOnly) trimmed.set(server, (trimmed.get(server) ?? 0) + 1);
  }
  const seen = new Set<string>();
  let servers: ReturnType<typeof configuredServers> = [];
  try {
    servers = configuredServers(dir);
  } catch {
    servers = [];
  }
  for (const s of servers) {
    const key = s.name.toLowerCase();
    if (seen.has(`${key}:${s.agent}`)) continue;
    seen.add(`${key}:${s.agent}`);
    const c = [...calls.entries()].find(([k]) => k.toLowerCase() === key)?.[1];
    out.push({
      id: `mcp:${s.agent}:${s.name}`, name: s.name, kind: "mcp", status: c ? "connected" : "installed",
      detail: `${s.source}${s.url ? " · remote" : s.command ? ` · ${basename(s.command)}` : ""}`, version: null,
      capabilities: [{ name: "Output trimmed by Snout", on: cfg.mode !== "observe" }, { name: `Used by ${s.agent === "claude" ? "Claude Code" : s.agent}`, on: true }],
      telemetry: [c ? `${c.n} tool call${c.n === 1 ? "" : "s"} in agent logs` : "No calls in agent logs", ...(trimmed.get(s.name) ? [`${trimmed.get(s.name)} result${trimmed.get(s.name) === 1 ? "" : "s"} shortened`] : [])],
      last: c?.last ?? null, setup: null, errors: [],
    });
  }
  for (const [server, c] of calls) {
    if (servers.some((s) => s.name.toLowerCase() === server.toLowerCase())) continue;
    out.push({ id: `mcp:seen:${server}`, name: server, kind: "mcp", status: "connected", detail: "Called in agent logs; configured outside this project", version: null, capabilities: [{ name: "Output trimmed by Snout", on: cfg.mode !== "observe" }], telemetry: [`${c.n} tool calls in agent logs`], last: c.last, setup: null, errors: [] });
  }

  // Models: every one the agents used here, with whether Snout knows its price.
  const models = new Map<string, { n: number; last: string; client: string }>();
  for (const s of logs) for (const r of s.requests) {
    const m = models.get(r.model) ?? { n: 0, last: r.ts, client: s.client };
    m.n += 1;
    if (r.ts > m.last) m.last = r.ts;
    models.set(r.model, m);
  }
  for (const [model, m] of [...models.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const p = priceOf(model, configDir());
    out.push({
      id: `model:${model}`, name: model, kind: "model", status: "connected", detail: `${providerOf(model)} · via ${m.client === "codex" ? "Codex" : "Claude Code"}`, version: null,
      capabilities: [{ name: "Price known", on: !!p }],
      telemetry: [`${m.n.toLocaleString()} request${m.n === 1 ? "" : "s"} in agent logs`, p ? `$${p.input}/M input, $${p.output}/M output (list, ${PRICES_AS_OF})` : "No list price: tokens counted, cost not shown"],
      last: m.last, setup: null, errors: p ? [] : [`No list price; add one in ${join(configDir(), "prices.json")}`],
    });
  }

  // Services
  const jevOn = cfg.coach === "jev" || cfg.memoryJudge === "jev";
  out.push({
    id: "service:jev", name: "TypeSafe Jev", kind: "service", status: jevOn ? (process.env.TYPESAFE_API_KEY ? "connected" : "error") : "off",
    detail: jevOn ? "Opt-in: prompts (coach) or preference sentences (memory judge) go to api.typesafe.ai" : "Off. Hooks stay local and make no model calls.", version: null,
    capabilities: [{ name: "Prompt coach (snout coach jev)", on: cfg.coach === "jev" }, { name: "Memory preference judge", on: cfg.memoryJudge === "jev" }],
    telemetry: [], last: null, setup: jevOn ? null : "snout coach jev", errors: jevOn && !process.env.TYPESAFE_API_KEY ? ["TYPESAFE_API_KEY is not set in this shell"] : [],
  });
  const cloud = cloudState();
  out.push({
    id: "service:cloud", name: "Snout Cloud", kind: "service", status: cloud.connected ? "connected" : "off",
    detail: cloud.connected ? `Signed in${cloud.user ? ` as ${cloud.user}` : ""}${cloud.team ? ` · ${cloud.team}` : ""}` : "Off. Opt in to share totals with a team dashboard.", version: null,
    capabilities: [{ name: "Daily totals synced", on: cloud.connected }, { name: "Paths or file contents synced", on: false }],
    telemetry: cloud.lastSync ? [`Last sync ${ago(cloud.lastSync)}`] : [], last: cloud.lastSync, setup: cloud.connected ? null : "snout login", errors: [],
  });

  // Repo
  const remote = remoteOf(dir);
  if (remote || existsSync(join(dir, ".git"))) {
    const host = remote?.split("/")[0] ?? "";
    out.push({
      id: "repo:git", name: remote ?? basename(dir), kind: "repo", status: "connected", detail: `${host.includes("github") ? "GitHub" : host || "Local git"} · branch ${branchOf(dir) ?? "?"}`, version: null,
      capabilities: [{ name: "Commits linked to memory cards", on: cfg.memory !== false }], telemetry: ["Read from .git on this machine; nothing is fetched"], last: null, setup: null, errors: [],
    });
  }
  return out;
}

export function ago(ts: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------------------------------------------------------------- environment

const RECORDS: [string, string][] = [
  ["ledger.jsonl", "One row per read and tool result: path, rule, decision, size, estimated tokens"],
  ["turns.jsonl", "One row per turn, and a row at each compaction"],
  ["recall.jsonl", "Which memory cards were recalled into which prompt, and their size"],
  ["hooks.jsonl", "A heartbeat per hook call, so Snout can tell it is wired in"],
  ["errors.jsonl", "Anything that went wrong"],
  ["prompts.jsonl", "Prompt coach scores (not the prompt text)"],
  ["config.json", "Only the settings you changed"],
  ["state.json", "Turn counter and a hash of the current prompt"],
  ["map.json", "Repo map: names each file declares and uses"],
  ["spend-cache.json", "Parsed usage from agent logs, so the next read is fast"],
];

function lineCount(file: string): number | null {
  try {
    const st = statSync(file);
    if (st.size > 64 << 20) return null;
    const b = readFileSync(file);
    let n = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 10) n++;
    return n;
  } catch {
    return null;
  }
}

function dirBytes(dir: string): number {
  let n = 0;
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile()) n += statSync(join(dir, f.name)).size;
    }
  } catch {
    // absent
  }
  return n;
}

export function environment(d: ProjectData, opts: { version: string; dashboard: string; fastPort: number; fastOn: boolean }): EnvironmentView {
  const sd = d.paths.snoutDir;
  const records = RECORDS.filter(([f]) => existsSync(join(sd, f))).map(([f]) => ({ name: f, bytes: statSync(join(sd, f)).size, rows: f.endsWith(".jsonl") ? lineCount(join(sd, f)) : null }));
  if (existsSync(join(sd, "memory"))) records.push({ name: "memory/", bytes: dirBytes(join(sd, "memory")), rows: readdirSync(join(sd, "memory")).filter((f) => f.endsWith(".json")).length });
  if (existsSync(join(sd, "squeeze"))) records.push({ name: "squeeze/", bytes: dirBytes(join(sd, "squeeze")), rows: readdirSync(join(sd, "squeeze")).length });
  const agents = new Map<string, { client: string; surface: string; sessions: number; last: string }>();
  for (const s of d.logs()) {
    const env = environmentOf(s);
    const k = `${s.client}:${env}:${s.surface}`;
    const a = agents.get(k) ?? { client: s.client, surface: `${s.surface || "cli"} (${env})`, sessions: 0, last: s.last };
    a.sessions += 1;
    if (s.last > a.last) a.last = s.last;
    agents.set(k, a);
  }
  const errors = readRows<{ ts: string; where: string; error?: string; message?: string }>(d.paths.errors, 30)
    .slice(-12)
    .reverse()
    .map((e) => ({ ts: e.ts, where: e.where, message: String(e.error ?? e.message ?? "").slice(0, 300) }));
  const cloud = cloudState();
  return {
    local: {
      host: hostname(), platform: `${platform()} ${release()}`, node: process.version, snout: opts.version, projectDir: d.dir, snoutDir: sd, configDir: configDir(), dashboard: opts.dashboard,
      fastServer: { on: opts.fastOn, port: opts.fastPort }, records, agents: [...agents.values()].sort((a, b) => (a.last < b.last ? 1 : -1)), errors,
    },
    hosted: { ...cloud, environments: [] },
  };
}

// ---------------------------------------------------------------- settings

/** The settings the page may change, and the values each accepts. Anything else is CLI-only. */
export const EDITABLE: Record<string, readonly (string | boolean)[]> = {
  mode: ["observe", "advise", "enforce"],
  coach: ["off", "tip", "jev"],
  repeatReads: [true, false],
  longDocs: [true, false],
  repoMap: [true, false],
  memory: [true, false],
  memoryJudge: ["off", "jev"],
  output: ["normal", "concise"],
};

const SHOWN: (keyof Config)[] = ["mode", "coach", "repeatReads", "longDocs", "output", "repoMap", "memory", "memoryJudge", "fastHooks", "sizeCapBytes"];
const IMPLICIT: Partial<Config> = { coach: "tip", repeatReads: true, longDocs: true, output: "normal", repoMap: false, memory: true, memoryJudge: "off", fastHooks: true };

/** Snout's own errors: the last week's, newest first, and how many older ones the file still holds. */
function health(d: ProjectData): SettingsView["health"] {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = readRows<{ ts: string; where: string; error?: string; message?: string }>(d.paths.errors, 500);
  const recent = rows.filter((e) => (e.ts ?? "") >= since).reverse();
  const hooks = pluginHookGap(d);
  return { hooks, recent: recent.slice(0, 12).map((e) => ({ ts: e.ts, where: e.where, message: String(e.error ?? e.message ?? "").slice(0, 300) })), more: Math.max(0, recent.length - 12), older: rows.length - recent.length, file: d.paths.errors };
}

export function settings(d: ProjectData): SettingsView & { sources: Record<string, string>; editable: Record<string, readonly (string | boolean)[]>; userConfig: string } {
  const cfg = loadConfig(d.paths);
  const values: Record<string, unknown> = {};
  const defaults: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  for (const k of SHOWN) {
    values[k] = cfg[k] ?? IMPLICIT[k] ?? null;
    defaults[k] = (DEFAULTS as Partial<Config>)[k] ?? IMPLICIT[k] ?? null;
    sources[k] = configSource(d.paths, k);
  }
  const seen = new Set<string>();
  for (const s of d.logs()) for (const r of s.requests) seen.add(r.model);
  const prices: SettingsView["prices"] = [];
  for (const m of seen) {
    const p = priceOf(m, configDir());
    if (!p) continue;
    prices.push({ model: m, input: p.input, cacheRead: p.cacheRead, output: p.output, source: PRICES[modelKey(m)] === p ? "list" : "yours" });
  }
  return {
    mode: cfg.mode, values, defaults, sources, editable: EDITABLE, alwaysAllow: cfg.alwaysAllow, alwaysDeny: cfg.alwaysDeny, redact: cfg.redact, redactExempt: cfg.redactExempt,
    prices: prices.sort((a, b) => a.model.localeCompare(b.model)), pricesAsOf: PRICES_AS_OF, configFile: d.paths.config, userConfig: userConfigPath(), keyPresent: { typesafe: !!process.env.TYPESAFE_API_KEY }, health: health(d),
  };
}

// ---------------------------------------------------------------- privacy

export function privacy(d: ProjectData): PrivacyView {
  const cfg = loadConfig(d.paths);
  const sd = d.paths.snoutDir;
  const stored = RECORDS.filter(([f]) => existsSync(join(sd, f))).map(([f, holds]) => ({ file: `.snout/${f}`, holds, bytes: statSync(join(sd, f)).size }));
  if (existsSync(join(sd, "memory"))) stored.push({ file: ".snout/memory/", holds: "One card per session: start of first and last request, files changed, commits, test command, last error", bytes: dirBytes(join(sd, "memory")) });
  if (existsSync(join(sd, "squeeze"))) stored.push({ file: ".snout/squeeze/", holds: "Full command outputs Snout shortened, newest 30 kept", bytes: dirBytes(join(sd, "squeeze")) });
  const cloud = cloudState();
  return {
    local: {
      stored,
      telemetry: "None. Snout sends no usage data anywhere.",
      network: [
        { feature: "Prompt coach with Jev", on: cfg.coach === "jev", sends: "Prompts that look like tasks", to: "api.typesafe.ai" },
        { feature: "Memory preference judge", on: cfg.memoryJudge === "jev", sends: "Up to six sentences per finished session", to: "api.typesafe.ai" },
        { feature: "Snout Cloud sync", on: cloud.connected, sends: "Daily totals per agent, model and file label; measured spend", to: cloud.url ?? "Snout Cloud" },
        { feature: "Memory model install", on: false, sends: "Nothing: downloads a model once, when you run the command", to: "npm, Hugging Face" },
      ],
    },
    redact: cfg.redact,
    hosted: {
      connected: cloud.connected,
      sends: ["Per day, agent, model and label: reads, tokens in context, tokens kept out", "Measured usage and list-price cost per day, agent and model", "A hash of the git remote (or folder) and the folder name"],
      never: ["File contents", "File paths", "Prompts or responses", "Snout's reasons", "Secrets (files matching redact are never read)"],
    },
    audit: [],
  };
}
