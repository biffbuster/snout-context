/**
 * `snout dashboard`: a local page that shows what the gate is saving, live.
 *
 * No dependencies and no daemon. A plain HTTP server on the loopback interface serves one
 * page and streams a fresh summary over server-sent events whenever the ledger grows. The
 * ledger is polled rather than watched: fs.watch misses appends on some filesystems, and a
 * stat every half second costs nothing.
 *
 * Nothing leaves the machine. The page loads no fonts, scripts or images from anywhere.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { statSync, unwatchFile, watchFile } from "node:fs";
import { basename, join } from "node:path";
import type { Paths } from "../config.js";
import { readDecisions } from "../ledger/store.js";
import { summarizeLedger, type DashboardSummary } from "./summary.js";
import { PAGE } from "./page.js";
import { readSpend } from "../spend/usage.js";
import { summarizeSpend, type SpendSummary } from "../spend/summary.js";
import { PRICES_AS_OF } from "../spend/prices.js";
import { configDir } from "../cloud/client.js";

/** What the page's buttons do. Each runs the same code as the matching CLI command. */
export interface DashboardActions {
  mode(): string;
  setMode(mode: string): string;
  allow(path: string): string;
  coach(): string;
  setCoach(value: string): string;
  cloud(): { loggedIn: boolean; team?: string };
  login(): string;
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

export function startDashboard(paths: Paths, opts: DashboardOptions): { close: () => void } {
  const streams = new Set<{ res: ServerResponse; session: string | null }>();
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

  const summary = (session: string | null): DashboardSummary & { meta: object; spend: (SpendSummary & { days: number; pricesAsOf: string }) | null } => {
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
    return {
      ...s,
      sessions,
      meta: {
        project: basename(paths.projectDir),
        mode: opts.actions?.mode() ?? opts.mode,
        version: opts.version,
        session,
        coach: opts.actions?.coach() ?? null,
        cloud: opts.actions?.cloud() ?? null,
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
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      }).end(page);
    } else if (url.pathname === "/api/summary") {
      res.writeHead(200, { ...common, "content-type": "application/json" }).end(JSON.stringify(summary(session)));
    } else if (url.pathname === "/api/action" && req.method === "POST") {
      return void action(req, res, common);
    } else if (url.pathname === "/events") {
      res.writeHead(200, { ...common, "content-type": "text/event-stream", connection: "keep-alive" });
      res.write("retry: 1500\n\n");
      const entry = { res, session };
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
    let a: { type?: string; value?: string; path?: string };
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
        a.type === "login" ? act.login() :
        null;
      if (message === null) return reply(400, { error: "unknown action" });
      cache = new Map(); // settings changed: the next summary is recomputed
      reply(200, { ok: true, message });
      for (const st of streams) send(st.res, st.session);
    } catch (err) {
      reply(500, { error: (err as Error).message.slice(0, 200) });
    }
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
      for (const s of streams) s.res.end();
      server.close();
    },
  };
}
