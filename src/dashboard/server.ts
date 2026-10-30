/**
 * `snout dashboard`: a local page that shows what the gate is saving, live.
 *
 * No dependencies and no daemon. A plain HTTP server on the loopback interface serves one
 * page and streams a fresh summary over server-sent events whenever the ledger grows. The
 * ledger is polled rather than watched: fs.watch misses appends on some filesystems, and a
 * stat every half second costs nothing.
 *
 * Nothing leaves the machine. The page loads no fonts, scripts or images from anywhere; the
 * one image it does not inline, Snout's corner animation, comes from this server (dist/).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { loadConfig, type Paths } from "../config.js";
import { readDecisions } from "../ledger/store.js";
import { summarizeLedger, type DashboardSummary } from "./summary.js";
import { PAGE } from "./page.js";
import { readSpend } from "../spend/usage.js";
import { summarizeSpend, type SpendSummary } from "../spend/summary.js";
import { PRICES_AS_OF } from "../spend/prices.js";
import { configDir } from "../config.js";
import { listFiles, type RepoMap } from "../map/map.js";
import { tier0 } from "../gate/tier0.js";
import { auditContext, totals as contextTotals } from "../audit/context.js";
import { auditServers } from "../audit/mcp-servers.js";
import { buildRepoView, type ReadStat, type RepoView } from "./repo.js";
import { fileReport } from "./file.js";
import { EDITABLE, environment, integrations, privacy, Projects, settings, type ProjectData } from "./pages.js";
import * as views from "./views.js";
import { HOOK_PORT } from "../gate/install.js";
import type { Boot, ProjectCard } from "./api.js";

/** Snout's corner animation (app/tour.ts). Shipped next to the bundle, not inlined: the hooks load
 * the same bundle on every tool call and should not parse 1 MB of image to do it. */
const MASCOT_PATH = "/snout-mascot.webp";
let mascotBytes: Buffer | null | undefined;
function mascot(): Buffer | null {
  if (mascotBytes === undefined) {
    try {
      mascotBytes = readFileSync(new URL("./snout-mascot.webp", import.meta.url));
    } catch {
      mascotBytes = null;
    }
  }
  return mascotBytes;
}

/** What the page's buttons do. Each runs the same code as the matching CLI command. */
export interface DashboardActions {
  mode(): string;
  setMode(mode: string): string;
  allow(path: string): string;
  coach(): string;
  setCoach(value: string): string;
  /** A setting from pages.ts EDITABLE; the value is checked against it before this runs. */
  set?(key: string, value: string | boolean): string;
  unallow?(path: string): string;
}

export interface DashboardOptions {
  port: number;
  mode: string;
  version: string;
  actions?: DashboardActions;

  /** Called once with the URL the server is listening on. */
  onListen: (url: string) => void;
}

/** Enough for months of work in one project; the ledger rotates well before this. */
const ROWS = 20_000;
const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;
/** Agent logs grow with every request; re-reading them (cached per file) every few seconds is cheap. */
const SPEND_MS = 4000;
const SPEND_DAYS = 30;
/** The file list and repo map change slowly; re-read them at most this often. */
const REPO_MS = 60_000;
/** Agent files and MCP servers come from session history, which is slow to read; refresh rarely. */
const AUDIT_MS = 10 * 60_000;
/** Files smaller than this are never worth classifying for the map: they cost too little to trim. */
const CLASSIFY_MIN_BYTES = 4096;
/** How often open pages are told whether anything they show changed. */
const TICK_MS = 1000;
/** Projects with a card on the Projects page; transcripts of older ones are not read. */
const PROJECT_CARDS = 16;
const API = new Set(["boot", "overview", "sessions", "session", "trace", "agents", "projects", "repo", "integrations", "environment", "analytics", "settings", "privacy"]);

const samePath = (rowPath: string, rel: string): boolean => {
  const a = rowPath.split("\\").join("/");
  return a === rel || a.endsWith(`/${rel}`);
};

export function startDashboard(paths: Paths, opts: DashboardOptions): { close: () => void } {
  const streams = new Set<{ res: ServerResponse; session: string | null; project: string | null; v: string }>();
  const projects = new Projects(paths);
  // The page's buttons change settings. A key minted per launch and embedded in the page means
  // only a page this server served can press them; the Host check below stops DNS rebinding.
  const key = randomBytes(24).toString("base64url");
  const page = PAGE.replace("__SNOUT_KEY__", key);
  let version = "";
  let cache = new Map<string, DashboardSummary>();

  const stamp = (): string => {
    try {
      const s = statSync(paths.ledger);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "none";
    }
  };

  let spend: SpendSummary | null = null;
  const readSpendNow = (): boolean => {
    try {
      const since = new Date(Date.now() - (SPEND_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
      const rows = [...readSpend(paths.projectDir, join(paths.snoutDir, "spend-cache.json"), configDir()).values()].flat();
      const next = summarizeSpend(rows, since);
      const changed = !spend || next.requests !== spend.requests || next.costUsd !== spend.costUsd;
      spend = next;
      return changed;
    } catch {
      return false; // no agent logs is a normal state, not an error
    }
  };
  readSpendNow();

  // The repo map: every file in the project, grouped by folder, joined with what the ledger saw.
  let listing: { path: string; size: number }[] = [];
  let listedAt = 0;
  let repoMap: RepoMap | null = null;
  let mapStamp = "";
  const labels = new Map<string, string>();
  let cfg: ReturnType<typeof loadConfig> | null = null;
  const labelOf = (path: string, size: number): string => {
    if (size < CLASSIFY_MIN_BYTES) return "source";
    const key = `${path}:${size}`;
    let l = labels.get(key);
    if (l === undefined) {
      try {
        cfg ??= loadConfig(paths);
        const d = tier0({ absPath: join(paths.projectDir, path), projectDir: paths.projectDir, cfg });
        l = d && d.value <= 1 ? d.rule : "source";
      } catch {
        l = "source";
      }
      labels.set(key, l);
    }
    return l;
  };
  const repoView = (s: DashboardSummary): RepoView | null => {
    try {
      if (Date.now() - listedAt > REPO_MS) {
        listedAt = Date.now();
        const seen = new Set<string>();
        const next: { path: string; size: number }[] = [];
        // Files agents read count even when the listing skips them (dist/, lockfiles): that is where bloat lives.
        for (const p of [...listFiles(paths.projectDir), ...s.readFiles.map((f) => f.key)]) {
          if (seen.has(p) || isAbsolute(p) || p.startsWith("..")) continue;
          seen.add(p);
          try {
            const st = statSync(join(paths.projectDir, p));
            if (st.isFile()) next.push({ path: p, size: st.size });
          } catch {
            // deleted since it was read
          }
        }
        listing = next;
        try {
          const st = statSync(paths.map);
          const v = `${st.size}:${st.mtimeMs}`;
          if (v !== mapStamp) {
            mapStamp = v;
            repoMap = JSON.parse(readFileSync(paths.map, "utf8")) as RepoMap;
          }
        } catch {
          repoMap = null;
        }
      }
      const read = new Map<string, ReadStat>(s.readFiles.map((f) => [f.key, f]));
      return buildRepoView(listing, read, labelOf, repoMap);
    } catch {
      return null;
    }
  };

  // Agent context files (CLAUDE.md, AGENTS.md, skills...) and configured MCP servers: what
  // `snout audit context` and `snout audit` report, read in the background after the page opens.
  type AgentFiles = ReturnType<typeof agentFilesNow>;
  let agentFiles: AgentFiles | null = null;
  type McpConfig = { name: string; source: string; agent: string; calls: number | null }[];
  let mcpConfig: McpConfig | null = null;
  let auditedAt = 0;
  function agentFilesNow() {
    const rows = readDecisions(paths.ledger, ROWS).map((r) => ({ path: r.path, ts: r.ts }));
    const a = auditContext(paths.projectDir, { days: 30, ledger: rows });
    const t = contextTotals(a);
    return {
      files: a.files
        .slice()
        .sort((x, y) => y.perSession - x.perSession || y.tokens - x.tokens)
        .slice(0, 16)
        .map((f) => ({ path: f.path, role: f.role, kind: f.kind, agents: f.agents, tokens: f.tokens, perSession: f.perSession, uses: f.uses, savePerSession: f.savePerSession, flags: f.flags.map((x) => ({ code: x.code, reason: x.reason, action: x.action })) })),
      count: a.files.length,
      alwaysPerSession: t.always.perSession,
      flagged: t.flagged,
      savePerSession: t.savePerSession,
    };
  }
  const audit = () => {
    if (Date.now() - auditedAt < AUDIT_MS) return;
    auditedAt = Date.now();
    setTimeout(() => {
      try {
        agentFiles = agentFilesNow();
      } catch {
        agentFiles = null;
      }
      auditServers(paths.projectDir, { days: 30 })
        .then((r) => { mcpConfig = r.map((x) => ({ name: x.name, source: x.source, agent: x.agent, calls: x.calls })); })
        .catch(() => { mcpConfig = null; })
        .finally(() => { cache = new Map(); for (const st of streams) send(st.res, st.session); });
    }, 50);
  };

  type Extras = { meta: object; spend: (SpendSummary & { days: number; pricesAsOf: string }) | null; repo: RepoView | null; agentFiles: AgentFiles | null; mcpConfig: McpConfig | null };
  const summary = (session: string | null): DashboardSummary & Extras => {
    const v = stamp();
    if (v !== version) {
      version = v;
      cache = new Map();
    }
    const key = session ?? "";
    let s = cache.get(key);
    if (!s) {
      const rows = readDecisions(paths.ledger, ROWS);
      s = summarizeLedger(session ? rows.filter((r) => r.session === session) : rows);
      cache.set(key, s);
    }
    const sessions = session ? summarizeLedger(readDecisions(paths.ledger, ROWS)).sessions : s.sessions;
    audit();
    return {
      ...s,
      readFiles: [],
      repo: repoView(s),
      agentFiles,
      mcpConfig,
      sessions,
      meta: {
        project: basename(paths.projectDir),
        mode: opts.actions?.mode() ?? opts.mode,
        version: opts.version,
        session,
        coach: opts.actions?.coach() ?? null,
        controls: !!opts.actions,
      },
      spend: spend && spend.requests ? { ...spend, days: SPEND_DAYS, pricesAsOf: PRICES_AS_OF } : null,
    };
  };

  const send = (res: ServerResponse, session: string | null) => {
    res.write(`event: summary\ndata: ${JSON.stringify(summary(session))}\n\n`);
  };

  let last = stamp();
  const onChange = () => {
    const now = stamp();
    if (now === last) return;
    last = now;
    for (const s of streams) send(s.res, s.session);
  };
  watchFile(paths.ledger, { interval: POLL_MS, persistent: true }, onChange);
  const heartbeat = setInterval(() => {
    for (const s of streams) s.res.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);
  const spendTimer = setInterval(() => {
    if (streams.size && readSpendNow()) for (const s of streams) send(s.res, s.session);
  }, SPEND_MS);
  // The page listens for "tick": a version that changes when the ledger, the recall log, the
  // settings or an agent transcript does. It then refetches only the view it is showing.
  const tickTimer = setInterval(() => {
    for (const s of streams) {
      try {
        const d = projects.get(s.project);
        if (!d) continue;
        const v = d.version();
        if (v === s.v) continue;
        s.v = v;
        s.res.write(`event: tick\ndata: ${JSON.stringify({ v, ts: new Date().toISOString() })}\n\n`);
      } catch {
        // a project folder that went away; the page keeps its last view
      }
    }
  }, TICK_MS);

  let port = opts.port;
  // Loaded here, not imported at the top: an ESM import of node:http makes Node evaluate its lazy
  // exports, which loads undici (fetch) and costs every hook process ~15 ms it never uses.
  const { createServer } = createRequire(import.meta.url)("node:http") as typeof import("node:http");
  const server = createServer((req, res) => handle(req, res));

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // A page on another site can point a hostname it controls at 127.0.0.1 and read this
    // server as same-origin. Refusing any Host but our own closes that (DNS rebinding).
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const session = url.searchParams.get("session") || null;
    const common = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

    if (req.method !== "GET" && !(req.method === "POST" && url.pathname === "/api/action")) {
      res.writeHead(405, common).end();
    } else if (url.pathname === "/") {
      res.writeHead(200, {
        ...common,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      }).end(page);
    } else if (url.pathname === MASCOT_PATH) {
      const img = mascot();
      if (img) res.writeHead(200, { "content-type": "image/webp", "cache-control": "max-age=86400", "x-content-type-options": "nosniff" }).end(img);
      else res.writeHead(404, { ...common, "content-type": "text/plain" }).end("not found");
    } else if (url.pathname === "/api/summary") {
      res.writeHead(200, { ...common, "content-type": "application/json" }).end(JSON.stringify(summary(session)));
    } else if (url.pathname.startsWith("/api/") && API.has(url.pathname.slice(5))) {
      const json = (status: number, body: unknown) => res.writeHead(status, { ...common, "content-type": "application/json" }).end(JSON.stringify(body));
      try {
        const body = api(url.pathname.slice(5), url.searchParams);
        if (body === undefined) json(404, { error: "not found" });
        else json(200, body);
      } catch (err) {
        json(500, { error: (err as Error).message.slice(0, 200) });
      }
    } else if (url.pathname === "/api/file") {
      // One file's report card: label, head, outline, search hint. Files inside the project only.
      try {
        cfg ??= loadConfig(paths);
        const body = fileReport(paths.projectDir, url.searchParams.get("path") ?? "", cfg);
        // What agents did with this file, from the ledger: when it was read and what reached context.
        const rows = projects.get(null)!.ledger().filter((r) => samePath(r.path, body.path));
        const t = views.snoutTotals(rows);
        const history = views.overview({ rows, sessions: [], recall: [], mode: cfg.mode }, views.rangeOf("all", null, null)).feed.slice(0, 40);
        const allowed = loadConfig(paths).alwaysAllow.includes(body.path);
        res.writeHead(200, { ...common, "content-type": "application/json" }).end(JSON.stringify({ ...body, reads: t.reads, inContext: t.inContext, keptOut: t.keptOut, history, allowed }));
      } catch {
        res.writeHead(404, { ...common, "content-type": "application/json" }).end(JSON.stringify({ error: "no such file in this project" }));
      }
    } else if (url.pathname === "/api/action" && req.method === "POST") {
      return void action(req, res, common);
    } else if (url.pathname === "/events") {
      res.writeHead(200, { ...common, "content-type": "text/event-stream", connection: "keep-alive" });
      res.write("retry: 1500\n\n");
      const entry = { res, session, project: url.searchParams.get("project") || null, v: "" };
      streams.add(entry);
      send(res, session);
      req.on("close", () => streams.delete(entry));
    } else {
      res.writeHead(404, { ...common, "content-type": "text/plain" }).end("not found");
    }
  }

  async function action(req: IncomingMessage, res: ServerResponse, common: Record<string, string>): Promise<void> {
    const reply = (status: number, body: object): void => {
      res.writeHead(status, { ...common, "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const given = Buffer.from(String(req.headers["x-snout-key"] ?? ""));
    const want = Buffer.from(key);
    if (!opts.actions || given.length !== want.length || !timingSafeEqual(given, want)) return reply(403, { error: "forbidden" });
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 4096) return reply(413, { error: "too large" });
    }
    let a: { type?: string; value?: string | boolean; path?: string; key?: string };
    try {
      a = JSON.parse(raw || "{}");
    } catch {
      return reply(400, { error: "invalid json" });
    }
    const act = opts.actions;
    try {
      const message =
        a.type === "mode" ? act.setMode(String(a.value)) :
        a.type === "allow" ? act.allow(String(a.path)) :
        a.type === "coach" ? act.setCoach(String(a.value)) :
        a.type === "set" ? setting(act, a) :
        a.type === "unallow" && act.unallow ? act.unallow(String(a.path)) :
        null;
      if (message === null) return reply(400, { error: "unknown action" });
      cache = new Map(); // settings changed: the next summary is recomputed
      reply(200, { ok: true, message });
      for (const st of streams) send(st.res, st.session);
    } catch (err) {
      reply(500, { error: (err as Error).message.slice(0, 200) });
    }
  }

  function setting(act: DashboardActions, a: { key?: string; value?: string | boolean }): string {
    const allowed = EDITABLE[String(a.key)];
    if (!allowed || !allowed.includes(a.value as string | boolean)) throw new Error("that setting cannot be changed here");
    if (a.key === "mode") return act.setMode(String(a.value));
    if (a.key === "coach") return act.setCoach(String(a.value));
    if (!act.set) throw new Error("that setting cannot be changed here");
    return act.set(String(a.key), a.value as string | boolean);
  }

  /** The page's data, one view per name. Undefined means no such session or project (404). */
  function api(name: string, q: URLSearchParams): unknown {
    const pid = q.get("project") || null;
    const d = projects.get(pid);
    if (!d) return undefined;
    const isCurrent = d.dir === paths.projectDir;
    const range = () => views.rangeOf(q.get("range"), q.get("from"), q.get("to"));
    // The environment selector: only sessions from that surface, and only their ledger rows.
    const env = q.get("env");
    const inp = () => {
      const all = d.inputs();
      if (!env || env === "all") return all;
      const sessions = all.sessions.filter((s) => views.environmentOf(s) === env);
      const ids = new Set(sessions.map((s) => s.id));
      return { ...all, sessions, rows: all.rows.filter((r) => ids.has(r.session)), recall: all.recall.filter((r) => ids.has(r.session)) };
    };
    switch (name) {
      case "boot": {
        const boot: Boot = {
          version: opts.version,
          project: projects.ref(pid),
          projects: projects.refs(),
          mode: loadConfig(d.paths).mode,
          controls: !!opts.actions && isCurrent,
        };
        return { ...boot, coach: isCurrent ? opts.actions?.coach() ?? null : null, now: new Date().toISOString(), v: d.version() };
      }
      case "overview":
        return views.overview(inp(), range());
      case "sessions":
        return views.sessionRows(inp(), q.get("range") ? range() : undefined).sort((a, b) => (a.last < b.last ? 1 : -1));
      case "session":
        return views.sessionDetail(inp(), q.get("id") ?? "") ?? undefined;
      case "trace": {
        const n = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
        return views.trace(inp(), q.get("id") ?? "", { from: n("from"), to: n("to") }) ?? undefined;
      }
      case "agents":
        return { agents: views.agents(inp(), range(), installedOf(d)), integrations: integrations(d).filter((i) => i.kind === "agent" || i.kind === "mcp") };
      case "projects":
        return projectCards(range());
      case "repo":
        return isCurrent ? repoView(summary(null)) : null;
      case "integrations":
        return integrations(d);
      case "environment":
        return environment(d, { version: opts.version, dashboard: `http://127.0.0.1:${port}/`, fastPort: HOOK_PORT, fastOn: loadConfig(d.paths).fastHooks !== false });
      case "analytics":
        return views.analytics(inp(), range());
      case "settings":
        return settings(d);
      case "privacy":
        return privacy(d);
      default:
        return undefined;
    }
  }

  const installedOf = (d: ProjectData): Record<string, boolean> =>
    Object.fromEntries(integrations(d).filter((i) => i.kind === "agent").map((i) => [i.id.slice(6), i.status === "connected" || i.status === "installed"]));

  /** One card per project, most recent first. */
  function projectCards(range: ReturnType<typeof views.rangeOf>): ProjectCard[] {
    return projects.refs().slice(0, PROJECT_CARDS).map((ref) => {
      const d = projects.get(ref.id)!;
      try {
        const inp = d.inputs();
        const o = views.overview(inp, range);
        const cfg = loadConfig(d.paths);
        const envs = [...new Set(inp.sessions.filter((s) => s.last >= range.from).map((s) => views.environmentOf(s)))];
        return {
          ref,
          environment: envs.join(", ") || "local",
          sessions: o.sessions.total,
          active: o.sessions.active,
          usage: o.usage.requests ? o.usage : null,
          snout: ref.snout ? { reads: o.snout.reads, keptOut: o.snout.keptOut, couldKeepOut: o.snout.couldKeepOut, events: o.snout.events } : null,
          savedUsd: o.savedUsd,
          mode: ref.snout ? cfg.mode : null,
          rules: cfg.alwaysAllow.length + cfg.alwaysDeny.length,
          topFiles: o.files.held.slice(0, 3),
          recent: o.feed.slice(0, 3),
        };
      } catch {
        return { ref, environment: "local", sessions: 0, active: 0, usage: null, snout: null, savedUsd: null, mode: null, rules: 0, topFiles: [], recent: [] };
      }
    });
  }

  // A busy default port moves up rather than failing: two projects can each run a dashboard.
  let tries = 0;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && opts.port !== 0 && tries < 20) {
      tries += 1;
      port += 1;
      server.listen(port, "127.0.0.1");
      return;
    }
    throw err;
  });
  server.on("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") port = addr.port;
    opts.onListen(`http://127.0.0.1:${port}/`);
  });
  server.listen(port, "127.0.0.1");

  return {
    close() {
      unwatchFile(paths.ledger, onChange);
      clearInterval(heartbeat);
      clearInterval(spendTimer);
      clearInterval(tickTimer);
      for (const s of streams) s.res.end();
      server.close();
    },
  };
}
