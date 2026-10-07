/**
 * Single entry point for every hook event and every slash command.
 *
 * Protocol rules, all of them load-bearing:
 *   - stdout carries the hook JSON response and nothing else. Diagnostics go to stderr.
 *   - we always exit 0. A non-zero exit from a context classifier would turn our failure
 *     into the user's failure, and the plugin's worst case must be being useless.
 *   - no top-level throw can escape. Every handler is wrapped.
 *
 * A note on token cost: this plugin exists to save tokens, so it must not spend them.
 * User-facing text goes in `systemMessage`, which the user reads and the model never sees.
 * We deliberately emit no `additionalContext` in Phase 0.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { attach, ensureDir, loadConfig, isValidMode, readLayer, resolvePaths, userConfigPath, configSource, DEFAULTS, type Config, type Paths } from "./config.js";
import { applyMode, bandOf, decide, searchHint, withOverride, worthGating, THRESHOLDS, type Band } from "./gate/decide.js";
import { fingerprintOf, scoreFile, sizeOf, tier0, toRel } from "./gate/tier0.js";
import { labelOf } from "./gate/rules.js";
import { summarize, type ScannedFile, type Summary } from "./gate/summary.js";
import { dumpTargets, readTargets } from "./gate/bash.js";
import { outline } from "./gate/outline.js";
import { splitGrepOutput } from "./gate/grep.js";
import { responseBytes, responseText } from "./gate/response.js";
import { appendRow, loadState, readDecisions, readRows, readTurns, rotateIfLarge, saveState, type SessionState } from "./ledger/store.js";
import { estimateTokens, fmtTokens, readTranscriptUsage } from "./ledger/tokens.js";
import { percentile, renderReport, totalsOf, JEV_USD_PER_MTOK } from "./ledger/report.js";
import { claudeMdLine, tipsOf, type Tip } from "./ledger/tips.js";
import { renderStatusline } from "./ledger/statusline.js";
import type { Decision, DecisionRow, HookInput, TurnRow, Verdict } from "./types.js";
import { debug, recordError } from "./util/log.js";
import { safePath, safeText } from "./util/safe.js";
import { writeAtomic } from "./util/atomic.js";
import { AGENTS, fromInternal, isAgent, toInternal } from "./agents/adapt.js";
import { initAgent } from "./agents/init.js";
import { startMcp } from "./mcp.js";
import { startDashboard, type DashboardActions } from "./dashboard/server.js";
import { liveDashboard, registerDashboard } from "./dashboard/registry.js";
import { installGate, refreshGate, removeGate } from "./gate/install.js";
import { AGENT_SYNC_MS, AUTO_SYNC_MS, buildPayload, cloudUrl, configDir, forgetCredentials, lastSync, loadCredentials, login, sync } from "./cloud/client.js";
import { readSpend } from "./spend/usage.js";
import { summarizeSpend } from "./spend/summary.js";
import { PRICES_AS_OF } from "./spend/prices.js";
import { dailyAggregates, summarizeLedger } from "./dashboard/summary.js";
import { scorePrompt, scoreWithJev } from "./coach/coach.js";
import { kindOf, squeeze } from "./squeeze/squeeze.js";
import { trimMcp } from "./squeeze/mcp.js";
import { auditServers, disableHint } from "./audit/mcp-servers.js";
import { archiveFiles, auditContext, listArchives, renderAudit, renderMap, restoreArchive, toJson } from "./audit/context.js";
import { docWindow, type DocWindow } from "./gate/longdoc.js";
import { buildMap, candidates, renderCandidates, type RepoMap } from "./map/map.js";
import { forgetReads, rememberRead, repeatOf, repeatOutput, requestedWindow, returnedWindow } from "./gate/repeat.js";

const VERSION = "0.2.2";
/** This bundle, by absolute path: what the gate hook and the login flow run. */
const BIN = resolve(process.argv[1] ?? "dist/snout.mjs");

const HOOK_EVENTS = new Set(["session-start", "prompt-submit", "pre-tool", "post-tool", "pre-compact", "stop", "squeeze"]);

/** The hooks that ship non-blocking. `pre-tool` is opt-in, so its absence is not a fault. */
const RECORDING_HOOKS = ["session-start", "prompt-submit", "post-tool", "pre-compact", "stop"];

/** Tools whose reads we classify. Grep/Glob are observed but never gated in Phase 0. */
const GATED_TOOLS = new Set(["Read", "NotebookRead"]);

function main(): void {
  const command = process.argv[2] ?? "status";
  // The MCP server owns stdin for its whole life, so it must start before the one-shot read.
  if (command === "mcp") {
    const paths = resolvePaths(process.argv[3]);
    attach(paths);
    return startMcp(paths.projectDir, loadConfig(paths), VERSION, writeOut);
  }
  if (command === "dashboard") return cmdDashboard(process.argv.slice(3));
  if (command === "audit") {
    void cmdAudit(process.argv.slice(3)).catch((err) => recordError("audit", err)).finally(() => process.exit(0));
    return;
  }
  if (command === "login" || command === "logout" || command === "sync") {
    void cmdCloud(command, process.argv.slice(3)).catch((err) => recordError(command, err)).finally(() => process.exit(0));
    return;
  }
  const input = readHookInput();
  if (command === "hook") return onAgentHook(process.argv[3], process.argv[4] ?? "", input as Record<string, unknown>);
  if (command === "init") return cmdInit(process.argv[3], input.cwd);
  dispatch(command, input);
}

/**
 * Another agent's hook event: translate it to the gate's protocol, run the same handler a
 * Claude Code hook would, and translate the answer back. The handler's output is captured
 * instead of printed, so exactly one response reaches the agent.
 */
function onAgentHook(agent: string | undefined, event: string, raw: Record<string, unknown>): void {
  if (!isAgent(agent)) return say(`snout hook: unknown agent "${safeText(agent ?? "", 20)}". Supported: ${AGENTS.join(", ")}.`);
  const mapped = Object.keys(raw).length ? toInternal(agent, event, raw) : null;
  let out: Record<string, unknown> | null = null;
  if (mapped) {
    captured = null;
    capturing = true;
    client = agent;
    try {
      dispatch(mapped.command, mapped.input);
    } catch (err) {
      recordError(`hook ${agent} ${event}`, err);
    } finally {
      capturing = false;
    }
    out = captured;
  }
  const text = fromInternal(agent, event, out);
  if (text) writeOut(text);
}

/**
 * After a turn, a logged-in user's totals go to Snout Cloud, at most every AUTO_SYNC_MS.
 * The upload runs in a detached process so the hook returns at once, online or not.
 */
function maybeAutoSync(paths: Paths): void {
  try {
    if (!loadCredentials()) return;
    const last = lastSync(paths);
    if (last && Date.now() - Date.parse(last.at) < (process.env.SNOUT_TOKEN ? AGENT_SYNC_MS : AUTO_SYNC_MS)) return;
    const script = process.argv[1];
    if (!script) return;
    spawn(process.execPath, [script, "sync", "--quiet", paths.projectDir], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch (err) {
    recordError("autoSync", err);
  }
}

async function cmdCloud(command: string, args: string[]): Promise<void> {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const dir = args.find((a, i) => !a.startsWith("-") && !["--url"].includes(args[i - 1] ?? ""));
  if (command === "logout") {
    return say(forgetCredentials() ? "Logged out. Nothing more is sent; the local ledger is untouched." : "Not logged in.");
  }
  if (command === "login") {
    await login(cloudUrl(flag("--url")), say, args.includes("--no-open") ? () => {} : openBrowser);
    return;
  }
  const paths = resolvePaths(dir);
  if (args.includes("--dry-run")) {
    return say(JSON.stringify(buildPayload(paths, VERSION), null, 2));
  }
  const r = await sync(paths, VERSION);
  if (!args.includes("--quiet") || !r.ok) say(r.message);
}

/** Where parsed spend is cached: inside `.snout/` only if Snout already keeps state here. */
const spendCache = (paths: Paths): string | null => (existsSync(paths.snoutDir) ? join(paths.snoutDir, "spend-cache.json") : null);

/**
 * `snout` with no arguments: whether it is on, what it has kept out of context, what that
 * saved, and the one next step. The answer to "is this doing anything?" in five lines.
 */
function cmdStatus(paths: Paths, cfg: Config): void {
  const rows = readDecisions(paths.ledger, 20_000);
  const s = summarizeLedger(rows);
  let rate = 0;
  let spentToday = 0;
  try {
    const spend = summarizeSpend([...readSpend(paths.projectDir, spendCache(paths), configDir()).values()].flat());
    rate = spend.inputRate;
    spentToday = spend.series.find((d) => d.day === s.today.day)?.costUsd ?? 0;
  } catch {
    // no agent logs: savings are shown in tokens only
  }
  const usd = (tokens: number) => (rate ? ` (~$${((tokens * rate) / 1e6).toFixed(2)})` : "");
  const lines = [`snout ${VERSION} · ${basename(paths.projectDir)} · mode ${cfg.mode}`, ""];
  if (!s.reads) {
    lines.push("  No reads recorded yet in this project.", "", `  Next: ${gateInstalled(paths) || existsSync(paths.hooks) ? "start your agent here and work as usual" : "snout init claude (or codex, cursor, gemini)"}`);
    return say(lines.join("\n"));
  }
  lines.push(`  Today     ~${fmtTokens(s.today.heldBack)} tokens kept out of context${usd(s.today.heldBack)} across ${s.today.reads} read(s)${spentToday ? ` · agents spent $${spentToday.toFixed(2)}` : ""}`);
  lines.push(`  All time  ~${fmtTokens(s.heldBack)} tokens kept out${usd(s.heldBack)} · ${s.gated} of ${s.reads} reads trimmed · ${Math.round(s.savedShare * 100)}% of what agents asked to read`);
  if (s.couldHoldBack > 0 && cfg.mode === "observe") lines.push(`  Waiting   ~${fmtTokens(s.couldHoldBack)} more tokens would have been kept out in enforce mode`);
  lines.push("", `  Next: ${cfg.mode === "observe" ? "snout mode enforce   (start trimming)" : "snout dashboard      (watch it live)"}`);
  say(lines.join("\n"));
}

/**
 * What the agents actually spent, from their own usage records, priced per model. `--all`
 * sums every project on this machine, which is the question a single ledger cannot answer.
 */
function cmdSpend(paths: Paths, args: string[]): void {
  const all = args.includes("--all");
  const i = args.indexOf("--days");
  const days = i >= 0 ? Math.max(1, Number(args[i + 1]) || 30) : 30;
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const spend = readSpend(all ? null : paths.projectDir, all ? join(configDir(), "spend-cache.json") : join(paths.snoutDir, "spend-cache.json"), configDir());
  const s = summarizeSpend([...spend.values()].flat(), since);
  const held = all ? 0 : dailyAggregates(readDecisions(paths.ledger, 20_000), since).reduce((a, d) => a + d.heldBack, 0);
  const projects = [...spend.entries()].map(([dir, r]) => ({ dir, s: summarizeSpend(r, since) })).filter((p) => p.s.requests > 0).sort((a, b) => b.s.costUsd - a.s.costUsd);
  if (args.includes("--json")) {
    return say(JSON.stringify({ days, pricesAsOf: PRICES_AS_OF, ...s, heldBack: held, projects: all ? projects.map((p) => ({ dir: p.dir, costUsd: p.s.costUsd, requests: p.s.requests, tokens: p.s.tokens })) : undefined }, null, 2));
  }
  const usd = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
  const pad = (v: string, n: number, left = false) => (left ? v.padEnd(n) : v.padStart(n));
  const lines = [`snout spend — ${all ? "all projects on this machine" : basename(paths.projectDir)} · last ${days} days · API list prices of ${PRICES_AS_OF}`, ""];
  if (!s.requests) {
    lines.push("  No agent usage recorded in this range. Claude Code and Codex sessions are read from their own logs.");
    return say(lines.join("\n"));
  }
  const cachedShare = s.tokens ? Math.round((s.cacheRead / s.tokens) * 100) : 0;
  lines.push(`  ${usd(s.costUsd)} across ${s.requests.toLocaleString()} requests · ${fmtTokens(s.tokens)} tokens (${cachedShare}% cache reads)`);
  if (held > 0) lines.push(`  Snout held back ~${fmtTokens(held)} tokens, about ${usd((held * s.inputRate) / 1e6)} at your blended input rate ($${s.inputRate.toFixed(2)}/M), counted once`);
  lines.push("", `  ${pad("BY MODEL", 26, true)}${pad("requests", 10)}${pad("tokens", 10)}${pad("cost", 11)}`);
  for (const m of s.byModel) lines.push(`    ${pad(safeText(m.key, 22), 22, true)}${pad(m.requests.toLocaleString(), 10)}${pad(fmtTokens(m.tokens), 10)}${pad(usd(m.costUsd), 11)}`);
  if (all) {
    lines.push("", `  ${pad("BY PROJECT", 46, true)}${pad("cost", 11)}`);
    for (const p of projects.slice(0, 10)) lines.push(`    ${pad(safeText(p.dir.replace(homedir(), "~"), 60).slice(-42), 42, true)}${pad(usd(p.s.costUsd), 11)}`);
    const rest = projects.slice(10);
    if (rest.length) lines.push(`    ${pad(`${rest.length} more`, 42, true)}${pad(usd(rest.reduce((a, p) => a + p.s.costUsd, 0)), 11)}`);
  }
  if (s.unpriced.length) lines.push("", `  No list price for ${s.unpriced.map((m) => safeText(m, 40)).join(", ")}: tokens counted, cost left out. Add it to ${join(configDir(), "prices.json")}.`);
  lines.push("", "  A Claude or ChatGPT subscription is not billed per token; this is what the same work costs on the API.");
  say(lines.join("\n"));
}

/** Serves the live dashboard on 127.0.0.1 until interrupted. */
function cmdDashboard(args: string[]): void {
  let port = 4747;
  let open = true;
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--port") port = Number(args[++i]);
    else if (a === "--no-open") open = false;
    else if (!a.startsWith("-")) dir = a;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) return say("snout dashboard: --port takes a number from 0 to 65535.");
  const paths = resolvePaths(dir);
  const cfg = loadConfig(paths);
  const running = liveDashboard(configDir(), paths.projectDir);
  if (running && !args.includes("--port")) {
    const url = `http://127.0.0.1:${running.port}/`;
    say(`Snout dashboard for ${paths.projectDir} is already running: ${url}`);
    if (open) openBrowser(url);
    process.exit(0);
  }
  startDashboard(paths, {
    port,
    mode: cfg.mode,
    version: VERSION,
    actions: dashboardActions(paths),
    onListen(url) {
      registerDashboard(configDir(), paths.projectDir, { port: Number(new URL(url).port), pid: process.pid, startedAt: new Date().toISOString() });
      say(`Snout dashboard for ${paths.projectDir}: ${url}\nUpdates live as agents read files. Ctrl-C to stop.`);
      if (open) openBrowser(url);
    },
  });
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser to open is fine: the URL is printed.
  }
}

function cmdInit(agent: string | undefined, cwd?: string): void {
  if (agent === "claude" || agent === "claude-code") {
    return say("Claude Code runs Snout as a plugin:\n\n  claude plugin marketplace add biffbuster/snout-context\n  claude plugin install snout@snout-context\n\nThen start a new session in this project. `snout` shows what it's doing.");
  }
  if (!isAgent(agent)) return say(`Usage: snout init <claude|${AGENTS.join("|")}>\n\nSets that agent up in this project so it runs Snout on every read.`);
  const paths = resolvePaths(cwd);
  try {
    const { file, events } = initAgent(agent, paths.projectDir);
    say(`snout init ${agent}: wrote ${toRel(file, paths.projectDir)} (${events.join(", ")}).`);
    if (agent === "codex") say("Codex loads project hooks only in a trusted folder: open Codex here, trust the folder, then approve Snout's hooks with /hooks.");
    const mode = loadConfig(paths).mode;
    say(mode === "observe" ? "Mode: observe (records only). `snout mode enforce` makes it act; `snout report` shows what it saw." : `Mode: ${mode}. \`snout report\` shows what it saw.`);
  } catch (err) {
    recordError("init", err);
    say(`snout init ${agent} failed: ${safeText((err as Error).message, 200)}`);
  }
}

function dispatch(command: string, input: HookInput): void {
  // A hook event with no payload means we could not read stdin. `cwd` is the only reliable
  // source of the project directory, so without it we must not guess and must not write:
  // a misrouted .snout directory is worse than a missed decision.
  if (HOOK_EVENTS.has(command) && Object.keys(input).length === 0) {
    debug("empty hook payload for", command, "- doing nothing");
    return;
  }

  const paths = resolvePaths(input.cwd);
  attach(paths);
  const cfg = loadConfig(paths);

  if (HOOK_EVENTS.has(command)) recordHeartbeat(paths, command, input);

  switch (command) {
    case "session-start": return onSessionStart(input, paths, cfg);
    case "prompt-submit": return onPromptSubmit(input, paths, cfg);
    case "pre-tool": return onPreTool(input, paths, cfg);
    case "post-tool": return onPostTool(input, paths, cfg);
    case "squeeze": return onSqueeze(input, paths, cfg);
    case "pre-compact": return onPreCompact(input, paths);
    case "stop": return onStop(input, paths, cfg);

    case "report": return cmdReport(paths, cfg, process.argv.slice(3));
    case "statusline": return cmdStatusline(paths, cfg);
    case "mode": return cmdMode(paths, cfg, process.argv[3]);
    case "allow": return cmdAllow(paths, cfg, process.argv[3]);
    case "apply": return cmdApply(paths, cfg, process.argv.slice(3));
    case "explain": return cmdExplain(paths, cfg, process.argv.slice(3));
    case "scan": return cmdScan(paths, cfg, process.argv.slice(3));
    case "reset": return cmdReset(paths);
    case "doctor": return cmdDoctor(paths, cfg);
    case "spend": return cmdSpend(paths, process.argv.slice(3));
    case "coach": return cmdCoach(paths, cfg, process.argv.slice(3));
    case "output": return cmdOutput(paths, cfg, process.argv.slice(3));
    case "map": return cmdMap(paths, cfg, process.argv.slice(3));
    case "version": return say(`snout ${VERSION}`);
    case "status": return cmdStatus(paths, cfg);
    case "help": case "--help": case "-h": return say(HELP);
    default: return say(`snout: unknown command "${safeText(command, 30)}".\n\n${HELP}`);
  }
}

/**
 * One line per hook invocation, written before the handler runs.
 *
 * Without this, a decision count of zero has two indistinguishable causes: no hook fired,
 * or hooks fired and found nothing worth classifying. The first is a broken install and
 * the second is a quiet Tuesday, and the user cannot tell them apart — which is how this
 * plugin sat installed for a day with an empty `.snout` directory and no way to notice.
 *
 * Deliberately not gated on mode or config: a heartbeat must be the one thing that still
 * works when everything else is misconfigured.
 */
function recordHeartbeat(paths: Paths, event: string, input: HookInput): void {
  const row: HeartbeatRow = {
    ts: new Date().toISOString(),
    event,
    session: input.session_id ?? "unknown",
  };
  // Kept on the heartbeat too, so `doctor` can show whether these fields arrive at all.
  appendRow(paths.hooks, { ...row, ...agentOf(input) });
  rotateIfLarge(paths.hooks);
}

/**
 * Which subagent made the call. Empty for the main loop, so its rows stay unchanged.
 * Stored as given (length-capped) and escaped only when rendered, like paths.
 */
function agentOf(input: HookInput): { agentId?: string; agentType?: string } {
  const out: { agentId?: string; agentType?: string } = {};
  if (typeof input.agent_id === "string" && input.agent_id) out.agentId = input.agent_id.slice(0, 128);
  if (typeof input.agent_type === "string" && input.agent_type) out.agentType = input.agent_type.slice(0, 128);
  return out;
}

/**
 * What was read, precisely enough to spot the same read made twice: which version of the
 * file, and which part of it. A ranged Read of lines 1-50 and one of 51-100 are different
 * reads; so are a read, an edit, and a re-read.
 */
function readShape(input: HookInput, absPath: string, bashBytes?: number): { fp?: string; range?: string } {
  const out: { fp?: string; range?: string } = {};
  const fp = fingerprintOf(absPath);
  if (fp) out.fp = fp;
  if (input.tool_name === "Bash" || input.tool_name === "Grep") {
    out.range = `${input.tool_name.toLowerCase()}:${bashBytes ?? 0}`;
  } else {
    const t = input.tool_input ?? {};
    const part = (k: string) => (typeof t[k] === "number" || typeof t[k] === "string" ? String(t[k]) : "");
    out.range = `${part("offset")}:${part("limit")}${part("pages") ? `:p${part("pages")}` : ""}`;
  }
  return out;
}

interface HeartbeatRow {
  ts: string;
  event: string;
  session: string;
  agentId?: string;
  agentType?: string;
}

/** Most recent timestamp per hook event, from the tail of the heartbeat log. */
function lastSeenByEvent(paths: Paths): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of readRows<HeartbeatRow>(paths.hooks, 500)) {
    if (!r || typeof r.event !== "string") continue;
    const prev = out.get(r.event);
    if (!prev || r.ts > prev) out.set(r.event, r.ts);
  }
  return out;
}

/** "12s ago", "4m ago", "3h ago" — precision the user can act on, and no more. */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---------------------------------------------------------------- hook handlers

function onSessionStart(input: HookInput, paths: Paths, cfg: Config): void {
  const session = input.session_id ?? "unknown";
  const state = loadState(paths.state, session);
  state.session = session;
  if (typeof input.model === "string" && input.model) state.model = input.model.slice(0, 64);
  saveState(paths.state, state);

  // Deliberately no additionalContext: a plugin that saves tokens must not spend them. The
  // line below goes to the user only.
  try {
    if (gateInstalled(paths)) refreshGate(paths.projectDir, BIN);
  } catch (err) {
    recordError("refreshGate", err);
  }
  const s = summarizeLedger(readDecisions(paths.ledger, 5000));
  const report = firstRunReport(paths, cfg, s);
  if (report) return emit(withOutputStyle(cfg, { systemMessage: report }));
  const kept = s.today.heldBack ? ` · ~${fmtTokens(s.today.heldBack)} tokens kept out today` : "";
  const dash = liveDashboard(configDir(), paths.projectDir);
  const where = dash ? ` · dashboard http://127.0.0.1:${dash.port}/` : " · `snout dashboard` to watch it live";
  emit(withOutputStyle(cfg, { systemMessage: `Snout is on (${cfg.mode})${kept}${where}${cfg.output === "concise" ? " · concise output on" : ""}` }));
}

/**
 * Concise output (opt-in, `snout output concise`): one short instruction at session start.
 * Output tokens cost several times input tokens, and agents spend many of them recapping what
 * they just did and restating code they wrote. This is the only text Snout ever adds to the
 * agent's context, so it is off by default and kept to a few dozen tokens.
 */
const CONCISE_INSTRUCTION =
  "Output style, set by the user through Snout: be concise. Skip recaps of what you just did, don't restate code you wrote or files you read, and prefer short answers and diffs over long explanations unless asked. Keep the quality of the code and its tests unchanged.";

function withOutputStyle(cfg: Config, out: Record<string, unknown>): Record<string, unknown> {
  if (cfg.output !== "concise") return out;
  return { ...out, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CONCISE_INSTRUCTION } };
}

/**
 * `snout audit [--measure] [--days N] [dir]`: MCP servers this project's agents load, how often
 * each was used, and the ones that only add their tool list to every request.
 */
async function cmdAudit(args: string[]): Promise<void> {
  if (args[0] === "context") return cmdAuditContext(args.slice(1));
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const days = Math.max(1, Number(flag("--days")) || 30);
  const dir = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--days");
  const paths = resolvePaths(dir);
  const measure = args.includes("--measure");
  const reports = await auditServers(paths.projectDir, { days, measure });
  if (!reports.length) return say("No MCP servers are configured for this project, and none appear in its recent sessions. Nothing adds a tool list to your agent's requests.");
  const lines = [`MCP servers for ${paths.projectDir} · usage from the last ${days} days of Claude Code sessions`, ""];
  const unused = reports.filter((r) => r.calls === 0);
  for (const r of reports) {
    const used = r.calls === null ? "usage not tracked" : r.calls === 0 ? "never used" : `${r.calls} call${r.calls === 1 ? "" : "s"}`;
    const cost = r.listTokens !== undefined ? ` · ${r.tools} tools, ~${fmtTokens(r.listTokens)} tokens per request` : r.measureError ? ` · ${r.measureError}` : "";
    lines.push(`  ${r.calls === 0 ? "✗" : "·"} ${safeText(r.name, 40).padEnd(22)} ${used.padEnd(18)} ${r.source}${cost}`);
  }
  if (unused.length) {
    const perReq = unused.reduce((a, r) => a + (r.listTokens ?? 0), 0);
    lines.push("", `${unused.length} server${unused.length === 1 ? " was" : "s were"} never used, but still send ${unused.length === 1 ? "its" : "their"} tool list with every request${perReq ? ` (~${fmtTokens(perReq)} tokens each time)` : ""}. To turn ${unused.length === 1 ? "it" : "them"} off:`);
    for (const r of unused) lines.push(`  ${safeText(r.name, 40)}: ${disableHint(r)}`);
  } else lines.push("", "Every configured server was used. Nothing to turn off.");
  // What Snout saved on each server's results (trims and repeat skips), from this project's ledger.
  const saved = summarizeLedger(readDecisions(paths.ledger, 20_000)).byMcpServer.filter((m) => m.reads > 0);
  if (saved.length) {
    const held = saved.reduce((a, m) => a + m.heldBack, 0);
    const all = saved.reduce((a, m) => a + m.heldBack + m.inContext, 0);
    lines.push("", `Results Snout trimmed or skipped as repeats: ~${fmtTokens(held)} tokens saved, ${all ? Math.round((held / all) * 100) : 0}% of what MCP servers returned`);
    for (const m of saved) lines.push(`  ${safeText(m.key, 40).padEnd(22)} ${`${m.reads} result${m.reads === 1 ? "" : "s"}`.padEnd(12)} ~${fmtTokens(m.inContext)} in context · ~${fmtTokens(m.heldBack)} saved`);
  }
  if (!measure) lines.push("", "Add --measure to start each local server once and count what its tool list costs.");
  if (reports.some((r) => r.source === "Claude account connector")) lines.push("Connectors from your Claude account can't be listed from local files, so unused ones don't show here. Claude Code loads large tool sets on demand, which limits their cost; review them at claude.ai → Settings → Connectors.");
  say(lines.join("\n"));
}

/**
 * `snout audit context`: instruction files, skills, commands, agents and AI-written docs, what
 * each costs per session, whether it's used, and which are dead weight. Archives only on request,
 * after the user confirms, and every archive can be restored.
 */
async function cmdAuditContext(args: string[]): Promise<void> {
  const valued = new Set(["--days", "--restore", "--max-tokens"]);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const ai = args.indexOf("--archive");
  const archivePaths = ai >= 0 ? args.slice(ai + 1).filter((a) => !a.startsWith("-")) : [];
  const dir = ai >= 0 ? undefined : args.find((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
  const paths = resolvePaths(dir);
  const projectDir = paths.projectDir;

  if (args.includes("--restore")) {
    const id = flag("--restore");
    if (!id || id.startsWith("-")) {
      const list = listArchives(projectDir);
      if (!list.length) return say("No archives in .snout/archive/.");
      return say(["Archives (restore with: snout audit context --restore <id>)", ...list.map((m) => `  ${m.id}  ${m.files.length} file${m.files.length === 1 ? "" : "s"}: ${m.files.slice(0, 3).map((f) => f.path).join(", ")}${m.files.length > 3 ? ", …" : ""}`)].join("\n"));
    }
    try {
      const r = restoreArchive(projectDir, id);
      return say([`Restored ${r.restored.length} file${r.restored.length === 1 ? "" : "s"} from ${id}.`, ...r.restored.map((p) => `  ${p}`), ...(r.skipped.length ? [`Left in the archive (a file is back at that path, or it's missing): ${r.skipped.join(", ")}`] : [])].join("\n"));
    } catch (err) {
      return say(`snout audit context: ${(err as Error).message}`);
    }
  }

  if (ai >= 0) {
    if (!archivePaths.length) return say("Usage: snout audit context --archive <path> [more paths]");
    const audit = auditContext(projectDir, { days: Math.max(1, Number(flag("--days")) || 30), noGit: true });
    const kinds = new Map(audit.files.map((f) => [f.path, f]));
    const lines = archivePaths.map((p) => { const f = kinds.get(p.replace(/^\.\//, "")); return `  ${p}${f ? `  (${f.kind}${f.kind === "always" ? ", loaded into every session" : ""})` : ""}`; });
    const instructions = archivePaths.some((p) => kinds.get(p.replace(/^\.\//, ""))?.kind === "always");
    say([`Move ${archivePaths.length} file${archivePaths.length === 1 ? "" : "s"} to .snout/archive/ (restorable with --restore):`, ...lines, ...(instructions ? ["Includes instruction files your agents load every session; they will stop seeing them."] : [])].join("\n"));
    if (!args.includes("--yes")) {
      if (!process.stdin.isTTY) return say("Not moved. Confirm by running it again with --yes.");
      const answer = await new Promise<string>((done) => {
        process.stdout.write("Move them? [y/N] ");
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", (d) => { process.stdin.pause(); done(String(d).trim().toLowerCase()); });
      });
      if (answer !== "y" && answer !== "yes") return say("Not moved.");
    }
    try {
      const m = archiveFiles(projectDir, archivePaths);
      return say(`Archived to .snout/archive/${m.id}/. Undo with: snout audit context --restore ${m.id}`);
    } catch (err) {
      return say(`snout audit context: ${(err as Error).message}. Nothing was moved.`);
    }
  }

  const days = Math.max(1, Number(flag("--days")) || 30);
  const max = Number(flag("--max-tokens")) || undefined;
  const ledger = readDecisions(paths.ledger, 20_000).map((r) => ({ path: r.path, ts: r.ts }));
  const audit = auditContext(projectDir, { days, ledger, oversizedTokens: max });
  if (args.includes("--json")) return say(JSON.stringify(toJson(audit), null, 2));
  if (args.includes("--map")) return say(renderMap(audit));
  say(renderAudit(audit, { all: args.includes("--all") }));
}

function cmdOutput(paths: Paths, cfg: Config, args: string[]): void {
  const v = args[0];
  if (v === "concise" || v === "normal") {
    setConfigKey(paths.config, "output", v);
    return say(v === "concise"
      ? "Concise output on. New sessions start with one short instruction (~60 tokens) to skip recaps and restated code. Turn it off with `snout output normal`."
      : "Concise output off. Snout adds nothing to the agent's context.");
  }
  say(`Output style is "${cfg.output ?? "normal"}". Usage: snout output concise|normal`);
}

/** Reads observed before the one-time report is worth showing. */
const FIRST_RUN_MIN_READS = 3;

/**
 * Observe mode's payoff, said once: what enforce would have kept out of context so far, in
 * tokens and in dollars at the user's own model mix. Shown at the start of the session after
 * Snout has something to report, then never again.
 */
function firstRunReport(paths: Paths, cfg: Config, s: ReturnType<typeof summarizeLedger>): string | null {
  const flag = join(paths.snoutDir, "first-run.json");
  if (cfg.mode !== "observe" || existsSync(flag) || s.reads < FIRST_RUN_MIN_READS || s.couldHoldBack <= 0) return null;
  let usd = "";
  try {
    const rate = summarizeSpend([...readSpend(paths.projectDir, spendCache(paths), configDir()).values()].flat()).inputRate;
    if (rate) usd = ` (~$${((s.couldHoldBack * rate) / 1e6).toFixed(2)} at your model mix, counted once)`;
  } catch {
    // no agent logs: tokens only
  }
  try {
    writeAtomic(flag, JSON.stringify({ shownAt: new Date().toISOString() }) + "\n");
  } catch {
    return null; // without the flag it would repeat every session; better to say nothing
  }
  const junk = s.recent.filter((r) => r.outcome === "would hold back").length;
  return `Snout watched ${s.reads} read${s.reads === 1 ? "" : "s"}${junk ? `; ${junk} of them would have been trimmed` : ""}: in enforce mode it would have kept ~${fmtTokens(s.couldHoldBack)} tokens out of context${usd}. Turn it on with /snout:mode enforce (or snout mode enforce).`;
}

/** Changes mode and installs or removes the blocking gate to match. Shared by CLI and page. */
function setMode(paths: Paths, next: "observe" | "advise" | "enforce"): string {
  setConfigKey(paths.config, "mode", next);
  if (next === "observe") {
    removeGate(paths.projectDir);
    return "Observe: Snout records what agents read and trims nothing.";
  }
  installGate(paths.projectDir, BIN);
  return `${next === "enforce" ? "Enforce: Snout gates what enters context (trims bulky reads and results, sends long docs by section, skips repeats)" : "Advise: Snout asks before a read that would crowd context"}. New agent sessions pick it up; running ones after /reload-plugins.`;
}

/** What the dashboard's buttons do: the same code paths as the CLI commands. */
function dashboardActions(paths: Paths): DashboardActions {
  return {
    mode: () => loadConfig(paths).mode,
    setMode: (m) => {
      if (m !== "observe" && m !== "advise" && m !== "enforce") throw new Error("unknown mode");
      return setMode(paths, m);
    },
    allow: (p) => {
      const target = p.trim();
      if (!target || target.length > 300 || target.includes("\0") || target.split(/[\\/]/).includes("..")) throw new Error("not a project path");
      const cfg = loadConfig(paths);
      if (!cfg.alwaysAllow.includes(target)) setConfigKey(paths.config, "alwaysAllow", [...cfg.alwaysAllow, target]);
      return `${target} will always be read in full.`;
    },
    coach: () => loadConfig(paths).coach ?? "tip",
    setCoach: (v) => {
      if (v !== "off" && v !== "tip" && v !== "jev") throw new Error("unknown coach mode");
      setConfigKey(paths.config, "coach", v);
      return v === "off" ? "Prompt coach off." : "Prompt coach on.";
    },
    cloud: () => {
      const c = loadCredentials();
      return c ? { loggedIn: true, team: c.team } : { loggedIn: false };
    },
    login: () => {
      spawn(process.execPath, [BIN, "login", paths.projectDir], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
      return "Opening the sign-in page in your browser.";
    },
  };
}

/** Full outputs Squeeze replaced, newest kept, so the agent (or you) can read one in full. */
const SQUEEZE_LOGS_KEPT = 30;

/**
 * Squeeze: after a noisy command succeeds, hand the agent a slimmed output (problems and
 * summary kept) and save the full one. Enforce and advise only; observe never changes output.
 */
/**
 * True for the first hook process to handle this tool call. A compound command (`cd x && npm
 * test`) matches several of Squeeze's `if` filters, and Claude Code then runs the hook once per
 * match for the same call. Every run returns the same output; only the first records it.
 */
function firstForCall(paths: Paths, id: string | undefined): boolean {
  if (!id) return true;
  const dir = join(paths.snoutDir, "calls");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, createHash("sha256").update(id).digest("hex").slice(0, 24)), "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    return true; // can't tell: record rather than lose the row
  }
  try {
    const all = readdirSync(dir);
    if (all.length > 400) for (const f of all.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t).slice(0, all.length - 200)) rmSync(join(dir, f.f), { force: true });
  } catch {
    // pruning is housekeeping only
  }
  return true;
}

let duplicateCall = false;

function onSqueeze(input: HookInput, paths: Paths, cfg: Config): void {
  const started = Date.now();
  duplicateCall = !firstForCall(paths, input.tool_use_id);
  if ((input.tool_name ?? "").startsWith("mcp__")) return onMcpTrim(input, paths, cfg, started);
  const command = stringField(input.tool_input, "command") ?? "";
  const resp = input.tool_response as Record<string, unknown> | undefined;
  const kind = kindOf(command);
  if (cfg.mode === "observe" || !kind || !resp || typeof resp !== "object" || typeof resp.stdout !== "string" || resp.interrupted === true || resp.isImage === true) {
    emit({});
    return;
  }
  const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
  const full = stderr ? `${resp.stdout}\n${stderr}` : (resp.stdout as string);
  if (cfg.repeatReads !== false) {
    const state = loadState(paths.state, input.session_id ?? "unknown");
    const prior = repeatOutput(paths.snoutDir, state.session, input.agent_id, `Bash:${command}`, full, state.turn, input.tool_use_id);
    if (prior) {
      const note = `snout: same output as when you ran this command at turn ${prior.turn}, earlier in this conversation. Nothing changed; use that copy.`;
      recordRepeatOutput(input, paths, state, "Bash", `$ ${safeText(command, 80)}`, full.length, note.length, started, cfg);
      return emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...resp, stdout: note, stderr: "" } } });
    }
  }
  const dir = join(paths.snoutDir, "squeeze");
  const logName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${createHash("sha256").update(command).digest("hex").slice(0, 8)}.log`;
  const s = squeeze(kind, full, `.snout/squeeze/${logName}`);
  if (!s) {
    emit({});
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, logName), `$ ${command}\n\n${full}`);
    const logs = readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - SQUEEZE_LOGS_KEPT))) rmSync(join(dir, old), { force: true });
  } catch (err) {
    recordError("squeeze log", err);
    emit({}); // without the saved full output, don't hide anything
    return;
  }
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const before = estimateTokens(s.beforeBytes, "output.txt");
  const after = estimateTokens(s.afterBytes, "output.txt");
  recordRow(paths.ledger, {
    ts: new Date().toISOString(), session: state.session, turn: state.turn, tool: "Bash",
    path: `$ ${safeText(command, 80)}`, tier: 0, rule: "command-output", value: 1, confidence: 1,
    decision: "deny", mode: cfg.mode, reason: `Squeezed ${kind} output: kept ${s.afterLines} of ${s.beforeLines} lines`,
    bytes: s.beforeBytes, tokensAvoidedEst: Math.max(0, before - after), tokensReadEst: after, jevInputTokens: 0,
    latencyMs: Date.now() - started, model: null, reversedByUser: false, trimmed: true,
    ...(input.agent_id ? { agentId: input.agent_id, agentType: input.agent_type } : {}),
  });
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...resp, stdout: s.text, stderr: "" } } });
}

const mcpPath = (tool: string) => `mcp: ${tool.replace(/^mcp__/, "").replace(/__/g, " › ")}`;

function recordRepeatOutput(input: HookInput, paths: Paths, state: SessionState, tool: string, path: string, beforeChars: number, afterChars: number, started: number, cfg: Config): void {
  const before = estimateTokens(beforeChars, "output.json");
  const after = estimateTokens(afterChars, "output.json");
  recordRow(paths.ledger, {
    ts: new Date().toISOString(), session: state.session, turn: state.turn, tool, path, tier: 0, rule: "repeat-output",
    value: 1, confidence: 1, decision: "deny", mode: cfg.mode, reason: "Identical to a result this agent already received",
    bytes: beforeChars, tokensAvoidedEst: Math.max(0, before - after), tokensReadEst: after, jevInputTokens: 0,
    latencyMs: Date.now() - started, model: null, reversedByUser: false, trimmed: true,
    ...(input.agent_id ? { agentId: input.agent_id, agentType: input.agent_type } : {}),
  });
}

/** Large MCP results, trimmed with the same guarantees as Squeeze: full copy saved, never errors. */
function onMcpTrim(input: HookInput, paths: Paths, cfg: Config, started: number): void {
  const tool = safeText(input.tool_name ?? "mcp", 80);
  if (cfg.mode === "observe") return emit({});
  if (cfg.repeatReads !== false) {
    const text = JSON.stringify(input.tool_response ?? null);
    const state = loadState(paths.state, input.session_id ?? "unknown");
    const prior = repeatOutput(paths.snoutDir, state.session, input.agent_id, tool, text, state.turn, input.tool_use_id);
    if (prior) {
      const note = `snout: identical to this tool's result at turn ${prior.turn}, which is earlier in this conversation and still accurate. Use that copy.`;
      recordRepeatOutput(input, paths, state, tool, mcpPath(tool), text.length, note.length, started, cfg);
      return emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: [{ type: "text", text: note }] } });
    }
  }
  const dir = join(paths.snoutDir, "squeeze");
  const logName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${createHash("sha256").update(tool).digest("hex").slice(0, 8)}.json`;
  const t = trimMcp(input.tool_response, `.snout/squeeze/${logName}`);
  if (!t) {
    recordToolOutput(input, paths, loadState(paths.state, input.session_id ?? "unknown"), responseBytes(input.tool_response));
    return emit({});
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, logName), JSON.stringify({ tool, input: input.tool_input ?? null, output: input.tool_response }, null, 1));
    const logs = readdirSync(dir).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - SQUEEZE_LOGS_KEPT))) rmSync(join(dir, old), { force: true });
  } catch (err) {
    recordError("mcp trim log", err);
    return emit({});
  }
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const before = estimateTokens(t.beforeChars, "output.json");
  const after = estimateTokens(t.afterChars, "output.json");
  recordRow(paths.ledger, {
    ts: new Date().toISOString(), session: state.session, turn: state.turn, tool,
    path: mcpPath(tool), tier: 0, rule: "mcp-output", value: 1, confidence: 1,
    decision: "deny", mode: cfg.mode, reason: `Trimmed ${tool} result: ${t.beforeChars} → ${t.afterChars} characters`,
    bytes: t.beforeChars, tokensAvoidedEst: Math.max(0, before - after), tokensReadEst: after, jevInputTokens: 0,
    latencyMs: Date.now() - started, model: null, reversedByUser: false, trimmed: true,
    ...(input.agent_id ? { agentId: input.agent_id, agentType: input.agent_type } : {}),
  });
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: t.output } });
}

function onPromptSubmit(input: HookInput, paths: Paths, cfg: Config): void {
  const session = input.session_id ?? "unknown";
  const state = loadState(paths.state, session);
  state.turn += 1;
  state.goalHash = createHash("sha256").update(input.prompt ?? "").digest("hex").slice(0, 12);
  const tip = coachPrompt(input.prompt ?? "", paths, cfg, state);
  const files = cfg.repoMap ? suggestFiles(input.prompt ?? "", paths, cfg, state) : "";
  saveState(paths.state, state);
  emit({
    ...(tip ? { systemMessage: tip } : {}),
    ...(files ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: files } } : {}),
  });
}

/**
 * Number of candidate files offered per prompt. Every one costs tokens on every later turn, and on
 * short tasks the list cost as much as it saved (PointFive C1), so it stays short.
 */
const MAP_CANDIDATES = 4;

/** Rebuilds the repo map, rereading only files whose size or mtime changed. Snout's own trim rules keep low-value files out. */
function refreshMap(paths: Paths, cfg: Config): RepoMap {
  let prev: RepoMap | null = null;
  try { prev = JSON.parse(readFileSync(paths.map, "utf8")) as RepoMap; } catch { /* first build */ }
  const lowValue = (rel: string) => {
    try { return decide({ absPath: join(paths.projectDir, rel), projectDir: paths.projectDir, cfg }).value === 0; } catch { return false; }
  };
  const { map, read } = buildMap(paths.projectDir, prev, lowValue);
  if (read || !prev) {
    ensureDir(paths.snoutDir);
    writeAtomic(paths.map, JSON.stringify(map));
  }
  return map;
}

/**
 * The candidate-files line for a prompt (opt-in, `snout map on`), or "" when the prompt names
 * nothing the map links to more than one file. Paths only, never contents; names in it come from
 * a strict identifier pattern and paths go through safePath. Each suggestion is logged with its
 * size, so its cost is counted and the benchmark can see which suggested files were opened.
 */
function suggestFiles(prompt: string, paths: Paths, cfg: Config, state: SessionState): string {
  if (!prompt.trim()) return "";
  try {
    const cs = candidates(refreshMap(paths, cfg), prompt, MAP_CANDIDATES);
    if (!cs.some((c) => c.defines.some((name) => namedExactly(prompt, name)))) return "";
    const line = renderCandidates(cs.map((c) => ({ ...c, path: safePath(c.path) })));
    appendRow(join(paths.snoutDir, "map-suggestions.jsonl"), {
      ts: new Date().toISOString(), session: state.session, turn: state.turn,
      paths: cs.map((c) => c.path), tokensEst: estimateTokens(Buffer.byteLength(line), "x.txt"),
    });
    return line;
  } catch (err) {
    recordError("repoMap", err);
    return "";
  }
}

/**
 * True when the prompt names `name` itself, as code: the identifier appears verbatim and looks like
 * one (mixed case, an underscore or digit, or long enough not to be an ordinary word). Plain words
 * that merely join into a declared name ("tax rate" → taxRate) don't fire the suggestion.
 */
function namedExactly(prompt: string, name: string): boolean {
  if (!new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[$]/g, "\\$")}($|[^A-Za-z0-9_])`).test(prompt)) return false;
  return /[A-Z_0-9]/.test(name.slice(1)) || name.length >= 8 || (/^[A-Z]/.test(name) && name.length >= 6);
}

/** `snout map on|off` toggles suggestions; `snout map "<request>"` shows what a prompt would get. */
function cmdMap(paths: Paths, cfg: Config, args: string[]): void {
  const v = args[0];
  if (v === "on" || v === "off") {
    setConfigKey(paths.config, "repoMap", v === "on");
    return say(v === "on"
      ? "Repo map on. Each prompt that names code in this repo gets a short list of the files that define or use it (~300 tokens, paths only). Turn it off with `snout map off`."
      : "Repo map off. Snout adds nothing to your prompts.");
  }
  const t0 = Date.now();
  const map = refreshMap(paths, cfg);
  const n = Object.keys(map.files).length;
  const request = args.join(" ").trim();
  if (!request) return say(`Repo map: ${n} files indexed in ${Date.now() - t0} ms (${cfg.repoMap ? "on" : "off"}). Usage: snout map on|off · snout map "<request>"`);
  const line = renderCandidates(candidates(map, request, MAP_CANDIDATES).map((c) => ({ ...c, path: safePath(c.path) })));
  say(line || "No file in the map is linked to names in that request.");
}

/** Coaching needs this many turns between tips, so a user iterating on a task is not nagged. */
const COACH_GAP_TURNS = 3;

/**
 * Scores the prompt and records the result (no prompt text, only its signals) so the A/B
 * and the dashboard can relate prompt scope to what the session then read. Returns the tip
 * to show the user, or null.
 */
function coachPrompt(prompt: string, paths: Paths, cfg: Config, state: SessionState): string | null {
  const mode = cfg.coach ?? "tip";
  if (mode === "off" || !prompt) return null;
  try {
    const rules = scorePrompt(prompt);
    const c = mode === "jev" ? scoreWithJev(prompt, rules) : rules;
    const quiet = state.lastCoachTurn !== undefined && state.turn - state.lastCoachTurn < COACH_GAP_TURNS;
    const tip = c.tip && !quiet ? c.tip : null;
    if (tip) state.lastCoachTurn = state.turn;
    if (c.taskLike) {
      appendRow(join(paths.snoutDir, "prompts.jsonl"), {
        ts: new Date().toISOString(), session: state.session, turn: state.turn, words: c.words,
        score: c.score, target: c.target, behavior: c.behavior, verify: c.verify, missing: c.missing, tipped: !!tip, source: c.source,
        ...(client ? { client } : {}),
      });
    }
    return tip;
  } catch (err) {
    recordError("coach", err);
    return null;
  }
}

/** `snout coach "<prompt>"` scores a prompt by hand; `snout coach off|tip|jev` sets the mode. */
function cmdCoach(paths: Paths, cfg: Config, args: string[]): void {
  const first = args[0];
  if (first === "off" || first === "tip" || first === "jev") {
    setConfigKey(paths.config, "coach", first);
    const note = first === "jev"
      ? process.env.TYPESAFE_API_KEY ? " Prompts that look like tasks are now checked by TypeSafe's Jev; their text is sent to api.typesafe.ai." : " Set TYPESAFE_API_KEY first; until then the local rules are used."
      : first === "tip" ? " Local rules only; nothing leaves the machine." : "";
    return say(`Prompt coach: ${first}.${note}`);
  }
  const prompt = args.join(" ").trim();
  if (!prompt) {
    return say(`Prompt coach is "${cfg.coach ?? "tip"}". Usage:\n  snout coach "<prompt>"     score a prompt\n  snout coach off|tip|jev    tip = local rules (default), jev = TypeSafe Jev (sends the prompt)`);
  }
  const rules = scorePrompt(prompt);
  const c = (cfg.coach ?? "tip") === "jev" ? scoreWithJev(prompt, rules) : rules;
  const mark = (ok: boolean) => (ok ? "yes" : "no ");
  say([
    `prompt coach (${c.source}) · score ${c.score.toFixed(2)} · ${c.taskLike ? "task" : "not a task request, so no tip"}`,
    `  target    ${mark(c.target)}  the file, function or error it's about`,
    `  behavior  ${mark(c.behavior)}  what should happen, or what goes wrong now`,
    `  verify    ${mark(c.verify)}  the test or command that proves it`,
    c.tip ? `\n  ${c.tip}` : c.taskLike ? "\n  Scoped well: the agent can go straight to the work." : "",
  ].join("\n"));
}

function onPreTool(input: HookInput, paths: Paths, cfg: Config): void {
  const tool = input.tool_name ?? "";

  // A Bash command that prints a whole flagged file is the same read as the Read tool, and
  // the route a denied agent takes around the gate. Only whole-file dumps are gated (see
  // dumpTargets); targeted reads — grep, head, jq, a pipe — are what the deny points to.
  if (tool === "Bash") {
    const command = stringField(input.tool_input, "command");
    const targets = command ? dumpTargets(command, paths.projectDir) : [];
    const state = loadState(paths.state, input.session_id ?? "unknown");
    if (targets.length && cfg.repeatReads !== false && cfg.mode === "enforce") {
      const agentId = agentOf(input).agentId;
      const seen = targets.map((a) => ({ abs: a, rel: toRel(a, paths.projectDir) })).map((t) => ({ ...t, prior: repeatOf(paths.snoutDir, state.session, agentId, t.abs, t.rel, "full") }));
      if (seen.every((t) => t.prior)) return repeatDumpResponse(input, paths, state, seen as { abs: string; rel: string; prior: { turn: number } }[]);
    }
    for (const absPath of targets) {
      const g = classifyForGate(input, paths, cfg, state, absPath);
      // Allowed files are recorded by PostToolUse from what the command actually printed.
      if (g.d.verdict === "allow") continue;
      recordRow(paths.ledger, g.row);
      return gateResponse(input, paths, state, g, "Printing it whole with Bash is gated like a Read.");
    }
    emit({});
    return;
  }

  const filePath = stringField(input.tool_input, "file_path") ?? stringField(input.tool_input, "notebook_path");

  // Grep and Glob carry no single path. They are observed in PostToolUse, never gated here.
  if (!GATED_TOOLS.has(tool) || !filePath) {
    emit({});
    return;
  }

  const absPath = isAbsolute(filePath) ? filePath : join(paths.projectDir, filePath);
  const state = loadState(paths.state, input.session_id ?? "unknown");

  // The same window of an unchanged file is already in this agent's context.
  if (tool === "Read" && cfg.repeatReads !== false) {
    const rel = toRel(absPath, paths.projectDir);
    const window = requestedWindow(input.tool_input);
    // Claude Code answers an exact repeat itself; other agents (client set) get every case.
    const prior = repeatOf(paths.snoutDir, state.session, agentOf(input).agentId, absPath, rel, window, !client);
    if (prior) return repeatResponse(input, paths, state, absPath, rel, window, prior);
  }

  const windowBytes = readWindowBytes(input, absPath);
  const g = classifyForGate(input, paths, cfg, state, absPath, windowBytes);

  // Claude Code refuses a whole-file Read over 256 KB with a one-line "use offset and
  // limit, or search" note, which is cheaper than any window Snout could return. Step aside, and
  // record no saving: none of that file was ever going to reach the context.
  if (!client && tool === "Read" && windowBytes === undefined && overNativeReadLimit(absPath)) {
    recordRow(paths.ledger, { ...g.row, decision: "allow", tokensAvoidedEst: 0, tokensReadEst: 0, reason: "Over Claude Code's 256 KB read limit, which refuses this read itself" });
    emit({});
    return;
  }

  // Trim rather than deny when the file has a useful head: the read goes ahead, cut to its
  // first lines, with the outline attached. A deny costs the agent a turn to re-plan; a trim
  // costs nothing, and the head plus the outline is usually what it wanted.
  if (g.d.verdict === "deny" && windowBytes === undefined && tool === "Read") {
    const head = headWindow(absPath);
    if (head) return trimResponse(input, paths, g, head);
  }

  // A long doc or log read whole: its opening and section map (or its tail), not all of it.
  if ((g.d.verdict === "allow" || g.d.rule === "oversized") && tool === "Read" && windowBytes === undefined && cfg.mode === "enforce" && cfg.longDocs !== false && g.d.rule !== "always-allow") {
    const doc = longDocOf(absPath, g.rel);
    if (doc) return docResponse(input, paths, g, doc);
  }

  recordRow(paths.ledger, g.row);

  if (g.d.verdict === "allow") {
    // Nothing to say. Staying silent on the common path is most of the latency budget.
    emit({});
    return;
  }
  gateResponse(input, paths, state, g, "");
}

/** Claude Code's Read refuses a whole file over 256 KB ("exceeds maximum allowed size"). */
const NATIVE_READ_MAX_BYTES = 256 * 1024;
const overNativeReadLimit = (absPath: string): boolean => sizeOf(absPath) > NATIVE_READ_MAX_BYTES;

function isRegularFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Bytes a Read with `limit` would return, or undefined for a whole-file read. Only computed
 * when a limit is present, so the common path never reads the file here.
 */
function readWindowBytes(input: HookInput, absPath: string): number | undefined {
  const t = input.tool_input ?? {};
  const limit = typeof t.limit === "number" ? t.limit : Number(t.limit);
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  const offset = Math.max(1, typeof t.offset === "number" ? t.offset : Number(t.offset) || 1);
  try {
    const lines = readFileSync(absPath, "utf8").split("\n").slice(offset - 1, offset - 1 + limit);
    return Buffer.byteLength(lines.join("\n"));
  } catch {
    return undefined; // unreadable: judge it as a whole-file read, as before
  }
}

/**
 * What the deny reason says about the withheld file's contents: its outline, and whether it
 * is effectively one line. Reads at most 4 MB, only on the deny path, and never throws.
 */
function contentsOf(absPath: string, rel: string, rule: string): { outline: string; oneLine: boolean } {
  try {
    const size = sizeOf(absPath);
    if (size > 4 * 1024 * 1024) return { outline: "", oneLine: false };
    const text = readFileSync(absPath, "utf8");
    const lines = text.split("\n").length;
    return { outline: outline(rel, rule, text), oneLine: size / lines > 1000 };
  } catch {
    return { outline: "", oneLine: false };
  }
}

/** A trimmed read: the first ~60 lines, capped at TRIM_BYTES. */
const TRIM_LINES = 60;
const TRIM_BYTES = 6 * 1024;

/**
 * The head a trimmed read returns, or null when the file has no useful head: one huge line
 * (a bundle), where any line-based limit still returns the whole thing, or an unreadable file.
 */
function headWindow(absPath: string): { lines: number; bytes: number; totalLines: number } | null {
  try {
    if (sizeOf(absPath) > 16 * 1024 * 1024) return null;
    const all = readFileSync(absPath, "utf8").split("\n");
    let bytes = 0, lines = 0;
    for (const line of all.slice(0, TRIM_LINES)) {
      const b = Buffer.byteLength(line) + 1;
      if (bytes + b > TRIM_BYTES) break;
      bytes += b;
      lines++;
    }
    return lines >= 5 ? { lines, bytes, totalLines: all.length } : null;
  } catch {
    return null;
  }
}

function trimResponse(input: HookInput, paths: Paths, g: Gated, head: { lines: number; bytes: number; totalLines: number }): void {
  const { absPath, rel, d, estimated } = g;
  const headTokens = estimateTokens(head.bytes, rel);
  recordRow(paths.ledger, {
    ...g.row,
    tokensAvoidedEst: Math.max(0, estimated - headTokens),
    tokensReadEst: headTokens,
    trimmed: true,
    range: `1:${head.lines}`,
  });
  const contents = contentsOf(absPath, rel, d.rule);
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...(input.tool_input ?? {}), offset: 1, limit: head.lines },
      // Model-visible. Everything from the file went through outline()'s allow-list, and
      // the path through safePath (inside withOverride and d.reason).
      additionalContext: withOverride(
        `snout trimmed this read: ${d.reason} (~${fmtTokens(estimated)} tokens), so only lines 1–${head.lines} of ${head.totalLines} were returned.${contents.outline} Read other ranges with offset and limit.${searchHint(d.rule, rel, { oneLine: contents.oneLine })}`,
        rel,
      ),
    },
    systemMessage: `snout trimmed: ${safePath(rel)} · ${d.rule} · lines 1–${head.lines} of ${head.totalLines}, ~${fmtTokens(Math.max(0, estimated - headTokens))} tokens withheld`,
  });
}

function longDocOf(absPath: string, rel: string): DocWindow | null {
  try {
    const size = sizeOf(absPath);
    if (size > 16 * 1024 * 1024) return null;
    return docWindow(rel, size >= 32 * 1024 ? readFileSync(absPath, "utf8") : "", size);
  } catch {
    return null;
  }
}

/** Section read: the doc's opening plus a map of its headings, or a log's tail plus where errors are. */
function docResponse(input: HookInput, paths: Paths, g: Gated, doc: DocWindow): void {
  const { rel, estimated } = g;
  const got = estimateTokens(doc.bytes, rel);
  const end = doc.start + doc.lines - 1;
  const rule = doc.kind === "doc" ? "long-doc" : "long-log";
  const what = doc.kind === "doc" ? `a long document (~${fmtTokens(estimated)} tokens)` : `a long log (~${fmtTokens(estimated)} tokens)`;
  recordRow(paths.ledger, {
    ...g.row,
    rule,
    value: 1,
    confidence: 1,
    decision: "deny",
    reason: doc.kind === "doc" ? "Long document: opening and section map returned" : "Long log: last lines and error locations returned",
    tokensAvoidedEst: Math.max(0, estimated - got),
    tokensReadEst: got,
    trimmed: true,
    range: `${doc.start}:${doc.lines}`,
  });
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...(input.tool_input ?? {}), offset: doc.start, limit: doc.lines },
      additionalContext: withOverride(
        `snout: ${safePath(rel)} is ${what}, so only lines ${doc.start}–${end} of ${doc.totalLines} were returned.${doc.map} Read the part you need with offset and limit; any ranged read comes back in full.`,
        rel,
      ),
    },
    systemMessage: `snout section read: ${safePath(rel)} · lines ${doc.start}–${end} of ${doc.totalLines}, ~${fmtTokens(Math.max(0, estimated - got))} tokens not loaded`,
  });
}

/** A `cat` of files this agent already read whole, unchanged: blocked with a pointer, not re-sent. */
function repeatDumpResponse(input: HookInput, paths: Paths, state: SessionState, files: { abs: string; rel: string; prior: { turn: number } }[]): void {
  for (const f of files) {
    const bytes = sizeOf(f.abs);
    recordRow(paths.ledger, {
      ts: new Date().toISOString(), session: state.session, turn: state.turn, tool: "Bash", path: f.rel, tier: 0,
      rule: "repeat-read", value: 1, confidence: 1, decision: "deny", mode: "enforce",
      reason: "Unchanged since this agent last read it, so the full text is already in context.",
      bytes, tokensAvoidedEst: Math.max(0, estimateTokens(bytes, f.rel) - 30), tokensReadEst: 30, jevInputTokens: 0,
      latencyMs: Math.round(process.uptime() * 1000), model: null, reversedByUser: false, trimmed: true, ...agentOf(input),
    });
  }
  const names = files.map((f) => safePath(f.rel)).join(", ");
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `snout: ${names} ${files.length > 1 ? "are" : "is"} unchanged since you read ${files.length > 1 ? "them" : "it"} in full earlier in this conversation (turn ${files[0]!.prior.turn}). That copy is still accurate; use it instead of printing ${files.length > 1 ? "them" : "it"} again.`,
    },
  });
}

const describeWindow = (w: string) => {
  if (w === "full") return "the whole file";
  const [start, count] = w.split(":").map(Number);
  return `lines ${start}–${start! + count! - 1}`;
};

/**
 * A repeat read goes ahead as a one-line read, so the agent's flow is unchanged (no error to
 * route around), and the note says where the full text already is.
 */
function repeatResponse(input: HookInput, paths: Paths, state: SessionState, absPath: string, rel: string, window: string, prior: { turn: number; window: string }): void {
  const bytes = window === "full" ? sizeOf(absPath) : readWindowBytes(input, absPath) ?? sizeOf(absPath);
  const estimated = estimateTokens(bytes, rel);
  recordRow(paths.ledger, {
    ts: new Date().toISOString(),
    session: state.session,
    turn: state.turn,
    tool: input.tool_name ?? "",
    path: rel,
    tier: 0,
    rule: "repeat-read",
    value: 1,
    confidence: 1,
    decision: "allow",
    mode: "enforce",
    reason: "Unchanged since this agent last read it, so the full text is already in context.",
    bytes,
    tokensAvoidedEst: Math.max(0, estimated - 20),
    tokensReadEst: 20,
    jevInputTokens: 0,
    latencyMs: Math.round(process.uptime() * 1000),
    model: null,
    reversedByUser: false,
    trimmed: true,
    range: "1:1",
    ...readShape(input, absPath),
    ...agentOf(input),
  });
  const t = input.tool_input ?? {};
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...t, offset: Number(t.offset) || 1, limit: 1 },
      additionalContext: withOverride(
        `snout: ${safePath(rel)} is unchanged since you read ${describeWindow(prior.window)} earlier in this conversation${prior.turn ? ` (turn ${prior.turn})` : ""}${window === prior.window ? "" : `, which includes ${describeWindow(window)}`}, so only its first line was returned. Use that earlier copy; it is still accurate.`,
        rel,
      ),
    },
  });
}

interface Gated { absPath: string; rel: string; d: Decision; estimated: number; row: DecisionRow }

function classifyForGate(input: HookInput, paths: Paths, cfg: Config, state: SessionState, absPath: string, windowBytes?: number): Gated {
  const rel = toRel(absPath, paths.projectDir);
  // A ranged Read is judged by the lines it asks for, not the whole file: reading 40 lines
  // of a generated client is the targeted read a deny points the agent toward.
  const bytes = windowBytes ?? sizeOf(absPath);
  const estimated = estimateTokens(bytes, rel);
  let d = decide({ absPath, projectDir: paths.projectDir, cfg });
  // The size cap is about the whole file crowding out the conversation. A ranged read is the
  // narrow read the cap points the agent toward, so it is judged by its window, not the file
  // (PointFive C1: a 400-line read of a 1.4 MB log was asked about, which headless runs treat
  // as a refusal, and the agent spent 34 turns working around it).
  if (d.rule === "oversized" && windowBytes !== undefined && windowBytes <= cfg.sizeCapBytes) {
    d = { ...d, verdict: "allow", suppressedByMode: true };
  }
  // Too small to be worth the turn a deny costs, or not a file at all: record, don't block.
  if (d.verdict !== "allow" && !worthGating(d, isRegularFile(absPath), estimated)) {
    d = { ...d, verdict: "allow", suppressedByMode: true };
  }
  const flagged = d.value <= 1;

  const row: DecisionRow = {
    ts: new Date().toISOString(),
    session: state.session,
    turn: state.turn,
    tool: input.tool_name ?? "",
    path: rel,
    tier: d.tier,
    rule: d.rule,
    value: d.value,
    confidence: d.confidence,
    decision: d.verdict,
    mode: cfg.mode,
    reason: d.reason,
    bytes,
    tokensAvoidedEst: flagged ? estimated : 0,
    tokensReadEst: d.verdict === "allow" ? estimated : 0,
    jevInputTokens: 0,
    latencyMs: Math.round(process.uptime() * 1000),
    model: null,
    reversedByUser: false,
    ...readShape(input, absPath),
    ...agentOf(input),
  };
  return { absPath, rel, d, estimated, row };
}

function gateResponse(input: HookInput, paths: Paths, state: SessionState, g: Gated, lead: string): void {
  const { absPath, rel, d, estimated } = g;
  const contents = contentsOf(absPath, rel, d.rule);
  // Remember the decision so PostToolUse can spot a user override — our false-deny signal.
  rememberPending(paths, state, input.tool_use_id, rel, d.verdict);

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: d.verdict,
      permissionDecisionReason: withOverride(
        `${d.reason} (~${fmtTokens(estimated)} tokens, confidence ${d.confidence.toFixed(2)})${lead ? " " + lead : ""}${contents.outline}${searchHint(d.rule, rel, { oneLine: contents.oneLine })}`,
        rel,
      ),
    },
    // `rel` is attacker-controlled in any repository the user did not write, and this
    // string is shown to the user while the reason above is read by the model. Both go
    // through safePath.
    systemMessage: `snout ${d.verdict}: ${safePath(rel)} · ${d.rule} · ~${fmtTokens(estimated)} tokens`,
  });
}

/**
 * PostToolUse runs with `async: true`, so it never blocks the agent. That makes it the
 * right home for recording, and in observe mode it is the *only* hook that runs: paying
 * ~120 ms of Node start-up on the critical path to block nothing would be a bad trade.
 *
 * It also has something PreToolUse does not — the real size of what the read returned —
 * so `tokensReadEst` here is derived from the actual result rather than from a `stat`.
 */
function onPostTool(input: HookInput, paths: Paths, cfg: Config): void {
  maybeAutoSync(paths); // the team dashboard stays about a minute behind, mid-turn included
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const pending = state as SessionState & { pending?: Record<string, { path: string; decision: Verdict }> };
  const id = input.tool_use_id;

  const filePath = stringField(input.tool_input, "file_path") ?? stringField(input.tool_input, "notebook_path");
  const alreadyGated = Boolean(id && pending.pending?.[id]);

  // Remember what a completed Read returned, for the repeat-read skip.
  if (input.tool_name === "Read" && filePath) {
    const window = returnedWindow(input.tool_response);
    if (window) {
      const abs = isAbsolute(filePath) ? filePath : join(paths.projectDir, filePath);
      rememberRead(paths.snoutDir, state.session, agentOf(input).agentId, abs, toRel(abs, paths.projectDir), window, state.turn);
    }
  } else if (input.tool_name === "Bash") {
    const resp = input.tool_response as Record<string, unknown> | undefined;
    const command = stringField(input.tool_input, "command");
    if (command && resp && typeof resp.stdout === "string" && resp.interrupted !== true) {
      for (const abs of dumpTargets(command, paths.projectDir)) {
        rememberRead(paths.snoutDir, state.session, agentOf(input).agentId, abs, toRel(abs, paths.projectDir), "full", state.turn);
      }
    }
  }

  // When the blocking hook is not installed, this is where classification happens. When it
  // is, PreToolUse has already recorded the decision and we must not double-count.
  if (filePath && !alreadyGated && !hasPreToolRow(paths, state, filePath, agentOf(input).agentId)) {
    recordObservation(input, paths, cfg, filePath, state);
  } else if (!filePath && input.tool_name === "Bash") {
    recordBashReads(input, paths, cfg, state, alreadyGated ? pending.pending![id!]!.path : undefined);
  } else if (!filePath && input.tool_name === "Grep") {
    recordGrep(input, paths, cfg, state);
  } else if (!filePath && isToolOutput(input.tool_name)) {
    // In enforce mode the squeeze hook sees every MCP result and records it, trimmed or not.
    if (!(cfg.mode === "enforce" && (input.tool_name ?? "").startsWith("mcp__"))) recordToolOutput(input, paths, state, responseBytes(input.tool_response));
  }

  // The tool ran despite an ask/deny, which means the user overrode us. That is the
  // strongest false-positive signal we get in production, so it is recorded explicitly
  // and folded back into the always-allow list rather than just counted.
  if (id && pending.pending?.[id]) {
    const { path, decision } = pending.pending[id]!;
    recordRow(paths.ledger, {
      ts: new Date().toISOString(),
      session: state.session,
      turn: state.turn,
      tool: input.tool_name ?? "",
      path,
      tier: 0,
      rule: "reversal",
      value: 3,
      confidence: 1,
      decision: "allow",
      mode: "observe",
      reason: `You overrode a ${decision} decision for this file.`,
      bytes: 0,
      tokensAvoidedEst: 0,
      tokensReadEst: 0,
      jevInputTokens: 0,
      latencyMs: 0,
      model: null,
      reversedByUser: true,
      ...agentOf(input),
    } satisfies DecisionRow);
    debug("reversal", path, decision);
    delete pending.pending[id];
    saveState(paths.state, pending);
  }
  emit({});
}

function onPreCompact(input: HookInput, paths: Paths): void {
  // Compaction is the outcome this plugin exists to postpone, so we record every one.
  const state = loadState(paths.state, input.session_id ?? "unknown");
  forgetReads(paths.snoutDir, state.session);
  appendRow(paths.turns, {
    ts: new Date().toISOString(),
    session: state.session,
    turn: state.turn,
    goalHash: state.goalHash,
    decisions: { allow: 0, ask: 0, deny: 0 },
    tokensReadEst: 0,
    tokensAvoidedEst: 0,
    jevRequests: 0,
    jevInputTokens: 0,
    jevCostUsd: 0,
    latency: { p50: 0, p95: 0, max: 0 },
    compacted: true,
  } satisfies TurnRow);
  emit({});
}

function onStop(input: HookInput, paths: Paths, cfg: Config): void {
  maybeAutoSync(paths);
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const rows = readDecisions(paths.ledger, 2000).filter(
    (r) => r.session === state.session && r.turn === state.turn && r.rule !== "reversal",
  );
  if (rows.length === 0) {
    emit({});
    return;
  }
  const t = totalsOf(rows);
  // Stop is the natural moment to trim: the turn is over and nothing is waiting on us.
  rotateIfLarge(paths.ledger);
  rotateIfLarge(paths.turns);
  appendRow(paths.turns, {
    ts: new Date().toISOString(),
    session: state.session,
    turn: state.turn,
    goalHash: state.goalHash,
    decisions: { allow: t.allow, ask: t.ask, deny: t.deny },
    tokensReadEst: t.tokensReadEst,
    tokensAvoidedEst: t.tokensAvoidedEst,
    jevRequests: 0,
    jevInputTokens: t.jevInputTokens,
    jevCostUsd: (t.jevInputTokens / 1_000_000) * JEV_USD_PER_MTOK,
    latency: {
      p50: percentile(t.latencies, 50),
      p95: percentile(t.latencies, 95),
      max: Math.max(0, ...t.latencies),
    },
    compacted: false,
  } satisfies TurnRow);
  debug("turn", state.turn, "flagged", t.tokensAvoidedEst, "mode", cfg.mode);
  emit({});
}


/**
 * Classifies a file and records it without ever producing a permission decision. Used by
 * the non-blocking PostToolUse path, which is the default and the only path in observe
 * mode.
 */
/**
 * Files a Bash command printed into the transcript.
 *
 * Reading through Bash is not an edge case — auto mode instructs it — so a ledger that
 * counts only the Read tool measures a minority of context and reports it as the total.
 */
function recordBashReads(input: HookInput, paths: Paths, cfg: Config, state: SessionState, gatedRel?: string): void {
  const command = stringField(input.tool_input, "command");
  if (!command) return;
  // A file PreToolUse gated and the user then let through already has its row, plus the
  // override row below; recording it again would count it twice.
  const targets = readTargets(command, paths.projectDir).filter((p) => toRel(p, paths.projectDir) !== gatedRel);
  if (targets.length === 0) return;

  // The result is the concatenation of everything the command printed, so no single file's
  // share of it is knowable. Splitting it by on-disk size is the closest honest
  // approximation, and it keeps `head -c 100 big.lock` from being billed as the whole file.
  const returned = responseBytes(input.tool_response);
  const sizes = targets.map((p) => sizeOf(p));
  const total = sizes.reduce((a, b) => a + b, 0);

  targets.forEach((abs, i) => {
    const share = returned <= 0
      ? sizes[i]!
      : total > 0
        ? Math.round(returned * (sizes[i]! / total))
        : Math.round(returned / targets.length);
    recordObservation(input, paths, cfg, abs, state, share);
  });
}

/**
 * Grep in content mode prints lines from many files; each file's share is classified like
 * a read, so a search that drags in a lockfile shows up as lockfile waste. What cannot be
 * pinned on a file — and the whole output of files or count mode — is tool output.
 */
function recordGrep(input: HookInput, paths: Paths, cfg: Config, state: SessionState): void {
  const text = responseText(input.tool_response);
  if (!text) return;
  if (stringField(input.tool_input, "output_mode") !== "content") {
    recordToolOutput(input, paths, state, Buffer.byteLength(text));
    return;
  }
  const { files, rest } = splitGrepOutput(text, input.cwd ?? paths.projectDir, stringField(input.tool_input, "path") ?? undefined);
  for (const [abs, bytes] of files) recordObservation(input, paths, cfg, abs, state, bytes);
  if (rest > 0) recordToolOutput(input, paths, state, rest);
}

/** Tools whose output enters context but names no file to classify. */
function isToolOutput(tool: string | undefined): boolean {
  return tool === "Glob" || tool === "Grep" || tool === "WebFetch" || tool === "WebSearch" || (tool ?? "").startsWith("mcp__");
}

/**
 * Glob listings, web fetches, MCP payloads: measured so the report's total is honest, never
 * judged — there is no file to classify, so they are never flagged.
 */
function recordToolOutput(input: HookInput, paths: Paths, state: SessionState, bytes: number): void {
  if (bytes <= 0) return;
  const tool = input.tool_name ?? "";
  const t = input.tool_input ?? {};
  const label =
    tool === "WebFetch" ? stringField(t, "url") ?? "web"
    : tool === "WebSearch" ? `search: ${stringField(t, "query") ?? ""}`
    : tool === "Glob" || tool === "Grep" ? `${tool.toLowerCase()}: ${stringField(t, "pattern") ?? ""}`
    : tool;
  // Fetched pages come back as markdown; MCP payloads are mostly JSON; listings are paths.
  const shape = tool === "WebFetch" || tool === "WebSearch" ? "x.md" : tool.startsWith("mcp__") ? "x.json" : "x";
  const tokens = estimateTokens(bytes, shape);
  recordRow(paths.ledger, {
    ts: new Date().toISOString(),
    session: state.session,
    turn: state.turn,
    tool,
    path: label.slice(0, 300),
    tier: 0,
    rule: "tool-output",
    value: 2,
    confidence: 0,
    decision: "allow",
    mode: "observe",
    reason: "Tool output with no file to classify; measured, not judged.",
    bytes,
    tokensAvoidedEst: 0,
    tokensReadEst: tokens,
    jevInputTokens: 0,
    latencyMs: Math.round(process.uptime() * 1000),
    model: null,
    reversedByUser: false,
    observedOnly: true,
    ...agentOf(input),
  } satisfies DecisionRow);
}

function recordObservation(
  input: HookInput,
  paths: Paths,
  cfg: Config,
  filePath: string,
  state: SessionState,
  bytesHint?: number,
): void {
  const absPath = isAbsolute(filePath) ? filePath : join(paths.projectDir, filePath);
  const rel = toRel(absPath, paths.projectDir);
  const d = decide({ absPath, projectDir: paths.projectDir, cfg });

  // The real result length, which a pre-read `stat` cannot know: a ranged Read returns far
  // less than the file holds, and counting the whole file would inflate every total.
  const returned = bytesHint ?? responseBytes(input.tool_response);
  const bytes = returned > 0 ? returned : sizeOf(absPath);
  const estimated = estimateTokens(bytes, rel);
  const flagged = d.value <= 1;

  recordRow(paths.ledger, {
    ts: new Date().toISOString(),
    session: state.session,
    turn: state.turn,
    tool: input.tool_name ?? "",
    path: rel,
    tier: d.tier,
    rule: d.rule,
    value: d.value,
    confidence: d.confidence,
    // Nothing was gated: the read already happened. `decision` records what we would have
    // done, and `observedOnly` marks that we did not do it.
    decision: "allow",
    mode: cfg.mode,
    reason: d.reason,
    bytes,
    tokensAvoidedEst: flagged ? estimated : 0,
    tokensReadEst: estimated,
    jevInputTokens: 0,
    latencyMs: Math.round(process.uptime() * 1000),
    model: null,
    reversedByUser: false,
    observedOnly: true,
    ...readShape(input, absPath, bytesHint),
    ...agentOf(input),
  } satisfies DecisionRow);
}

/**
 * True when PreToolUse already wrote a row for this path in this turn, from this agent.
 * Matching on agent matters in an orchestration: two subagents reading the same file in
 * the same turn are two reads, and without it the second one was silently dropped.
 */
function hasPreToolRow(paths: Paths, state: SessionState, filePath: string, agentId: string | undefined): boolean {
  const rel = toRel(isAbsolute(filePath) ? filePath : join(paths.projectDir, filePath), paths.projectDir);
  return readDecisions(paths.ledger, 12).some(
    (r) => r.path === rel && r.turn === state.turn && r.session === state.session && r.agentId === agentId && !r.observedOnly,
  );
}

// ---------------------------------------------------------------- commands

function cmdReport(paths: Paths, cfg: Config, args: string[]): void {
  const all = readDecisions(paths.ledger, 5000);
  const allTurns = readTurns(paths.turns, 500);
  const session = currentSession(paths);
  const scoped = !args.includes("--all") && session !== null;
  const rows = scoped ? all.filter((r) => r.session === session) : all;
  const turns = scoped ? allTurns.filter((t) => t.session === session) : allTurns;

  let out = renderReport(rows, turns.filter((t) => !t.compacted), cfg.mode, {
    scope: scoped ? "this session" : "all sessions",
    gateInstalled: gateInstalled(paths),
    byAgent: args.includes("--by-agent"),
  });

  const earlier = all.length - rows.length;
  if (scoped && earlier > 0) {
    out += `\n\n  ${earlier} more row(s) from earlier sessions: snout report --all`;
  }
  try {
    const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const sp = summarizeSpend([...readSpend(paths.projectDir, spendCache(paths), configDir()).values()].flat(), since);
    if (sp.requests) {
      const held = dailyAggregates(rows, since).reduce((a, d) => a + d.heldBack, 0);
      out += `\n\n  SPEND (last 30 days, API list prices, from the agents' own logs)\n    $${sp.costUsd.toFixed(2)} across ${sp.requests.toLocaleString()} requests · top model ${sp.byModel[0]?.key ?? "?"}`;
      if (held) out += `\n    Snout kept ~${fmtTokens(held)} tokens out: about $${((held * sp.inputRate) / 1e6).toFixed(2)} at your blended input rate`;
      out += "\n    Every project on this machine: snout spend --all";
    }
  } catch (err) {
    recordError("report spend", err);
  }
  const tips = currentTips(paths, cfg);
  if (tips.length > 0) {
    out += `\n\n  ${tips.length} suggested change(s), each with a preview and undo: snout apply`;
  }
  const compactions = turns.filter((t) => t.compacted).length;
  if (compactions > 0) {
    out += `\n\n  Compacted ${compactions} time(s) — the outcome this plugin exists to postpone.`;
  }
  say(out);
}

/** The session the hooks last saw, or null before any hook has run. */
function currentSession(paths: Paths): string | null {
  try {
    const s = JSON.parse(readFileSync(paths.state, "utf8")) as Partial<SessionState>;
    return typeof s.session === "string" ? s.session : null;
  } catch {
    return null;
  }
}

function cmdStatusline(paths: Paths, cfg: Config): void {
  say(renderStatusline(readDecisions(paths.ledger, 500), cfg.mode));
}

function cmdMode(paths: Paths, cfg: Config, next?: string): void {
  if (!next || !isValidMode(next)) {
    say(`mode is "${cfg.mode}". Usage: /snout:mode observe|advise|enforce\n\n  observe  classify and report, block nothing (default)\n  advise   ask before a read that would crowd context\n  enforce  gate context: trim bulky reads and results, long docs by section, skip repeats`);
    return;
  }
  say(setMode(paths, next));
  if (next !== "observe") say("If Snout trims a file you need, `snout allow <file>` (or the button on the dashboard) keeps it whole.");
}

function cmdAllow(paths: Paths, cfg: Config, target?: string): void {
  if (!target) {
    say("Usage: /snout:allow <path-or-glob>");
    return;
  }
  if (cfg.alwaysAllow.includes(target)) {
    say(`${target} is already on the always-allow list.`);
    return;
  }
  setConfigKey(paths.config, "alwaysAllow", [...cfg.alwaysAllow, target]);
  say(`Added ${target} to always-allow. It will never be flagged again.`);
}

// ---------------------------------------------------------------- apply

/** One applied change, with what it replaced, so `--undo` restores it exactly. */
interface AppliedRow {
  ts: string;
  id: string;
  kind: Tip["kind"];
  target: string;
  file: string;
  /** Config key changed, and its previous value in that layer (undefined = key was absent). */
  key?: "mode" | "alwaysAllow";
  before?: unknown;
  /** CLAUDE.md: the exact line appended, and whether the file existed before. */
  line?: string;
  created?: boolean;
  undone?: string;
}

const appliedPath = (paths: Paths) => join(paths.snoutDir, "applied.jsonl");

function currentTips(paths: Paths, cfg: Config): Tip[] {
  let claudeMd = "";
  try {
    claudeMd = readFileSync(join(paths.projectDir, "CLAUDE.md"), "utf8");
  } catch {
    // absent is fine
  }
  return tipsOf(readDecisions(paths.ledger, 5000), {
    mode: cfg.mode,
    alwaysAllow: cfg.alwaysAllow,
    claudeMd,
    gateInstalled: gateInstalled(paths),
  });
}

/**
 * `apply`            list tips, and what earlier changes measurably did
 * `apply N`          preview tip N: evidence, exact change, expected effect
 * `apply N --yes`    make the change; `--user` writes a config tip to ~/.snout instead
 * `apply --undo`     revert the most recent change
 *
 * Nothing is written without `--yes`, and the command file tells the model never to add it.
 */
function cmdApply(paths: Paths, cfg: Config, args: string[]): void {
  if (args.includes("--undo")) return undoApply(paths);
  const n = Number(args.find((a) => /^\d+$/.test(a)));
  const tips = currentTips(paths, cfg);

  if (!n) {
    const out = ["snout apply — changes worth making, from your own history. Nothing changes until you confirm.", ""];
    if (tips.length === 0) out.push("  No tips yet. They appear once the same bulky file is read a few times.");
    tips.forEach((t, i) => {
      out.push(`  ${i + 1}. ${safeText(t.title, 90)}`);
      out.push(`     seen      ${safeText(t.evidence, 110)}`);
      out.push(`     effect    ${safeText(t.effect, 110)}`);
    });
    if (tips.length > 0) out.push("", "  Preview one: snout apply <n>");
    const results = appliedResults(paths);
    if (results.length > 0) out.push("", "  APPLIED", ...results);
    return say(out.join("\n"));
  }

  const tip = tips[n - 1];
  if (!tip) return say(`No tip ${n}. Run snout apply to list them.`);
  const toUser = args.includes("--user") && tip.kind !== "claude-md";
  const file = tip.kind === "claude-md" ? join(paths.projectDir, "CLAUDE.md") : toUser ? userConfigPath() : paths.config;

  if (!args.includes("--yes")) {
    const lines = [
      `${n}. ${safeText(tip.title, 90)}`,
      `  seen      ${safeText(tip.evidence, 110)}`,
      // Shown exactly as it will be written: tipsOf only offers paths that need no escaping.
      `  change    ${tip.change}`,
      `  file      ${safeText(file, 140)}`,
      `  effect    ${safeText(tip.effect, 110)}`,
      `  undo      snout apply --undo`,
      "",
      `  To apply: snout apply ${n} --yes${tip.kind === "claude-md" ? "" : "   (add --user to make it a default for every project)"}`,
    ];
    return say(lines.join("\n"));
  }

  const row: AppliedRow = { ts: new Date().toISOString(), id: tip.id, kind: tip.kind, target: tip.target, file };
  if (tip.kind === "claude-md") {
    const line = claudeMdLine(tip.target, tip.rule ?? "");
    const existed = existsSync(file);
    const prev = existed ? readFileSync(file, "utf8") : "";
    writeAtomic(file, prev + (prev === "" || prev.endsWith("\n") ? "" : "\n") + line + "\n");
    Object.assign(row, { line, created: !existed });
  } else {
    const key = tip.kind === "mode" ? "mode" : "alwaysAllow";
    const before = readLayer(file)[key];
    const value = key === "mode" ? tip.target : [...cfg.alwaysAllow, tip.target];
    setConfigKey(file, key, value as never);
    Object.assign(row, { key, before });
  }
  appendRow(appliedPath(paths), row);
  say(`Applied: ${safeText(tip.title, 90)}\n  ${safeText(tip.change, 140)}\n  Undo any time: snout apply --undo. Results show under snout apply once new sessions run.`);
}

function undoApply(paths: Paths): void {
  const rows = readRows<AppliedRow>(appliedPath(paths), 500);
  const undone = new Set(rows.filter((r) => r.undone).map((r) => r.undone));
  const last = [...rows].reverse().find((r) => !r.undone && !undone.has(r.ts));
  if (!last) return say("Nothing to undo.");
  if (last.kind === "claude-md" && last.line) {
    const text = existsSync(last.file) ? readFileSync(last.file, "utf8") : "";
    const i = text.lastIndexOf(last.line + "\n");
    if (i < 0) return say(`The line snout added to ${safeText(last.file, 120)} is no longer there; nothing changed.`);
    const next = text.slice(0, i) + text.slice(i + last.line.length + 1);
    if (last.created && next.trim() === "") rmSync(last.file, { force: true });
    else writeAtomic(last.file, next);
  } else if (last.key) {
    setConfigKey(last.file, last.key, last.before as never);
  }
  appendRow(appliedPath(paths), { ts: new Date().toISOString(), undone: last.ts, id: last.id });
  say(`Undone: ${safeText(last.id, 120)}`);
}

/**
 * What each applied change measurably did: bulky tokens per session for its target,
 * before vs after. Only sessions that started after the change count as "after".
 */
function appliedResults(paths: Paths): string[] {
  const rows = readRows<AppliedRow>(appliedPath(paths), 500);
  const undone = new Set(rows.filter((r) => r.undone).map((r) => r.undone));
  const live = rows.filter((r) => !r.undone && !undone.has(r.ts));
  if (live.length === 0) return [];
  const ledger = readDecisions(paths.ledger, 5000);
  return live.map((a) => {
    const relevant = a.kind === "mode" ? ledger : ledger.filter((r) => r.path === a.target);
    const split = (after: boolean) => {
      const inScope = ledger.filter((r) => (r.ts >= a.ts) === after);
      const sessions = new Set(inScope.map((r) => r.session)).size;
      const tokens = relevant.filter((r) => (r.ts >= a.ts) === after && r.value <= 1 && r.rule !== "unclassified").reduce((x, r) => x + (r.tokensAvoidedEst || 0), 0);
      return { sessions, per: sessions > 0 ? Math.round(tokens / sessions) : 0 };
    };
    const b = split(false);
    const f = split(true);
    const result = f.sessions === 0 ? "no sessions since — results appear after the next one" : `~${fmtTokens(b.per)} → ~${fmtTokens(f.per)} bulky tokens per session (${f.sessions} session(s) since)`;
    return `    ${safeText(a.id, 70)}  ·  ${a.ts.slice(0, 10)}  ·  ${result}`;
  });
}

function cmdExplain(paths: Paths, cfg: Config, args: string[]): void {
  const json = args.includes("--json");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    say("Usage: /snout:explain <path> [--json]");
    return;
  }
  const absPath = isAbsolute(target) ? target : join(paths.projectDir, target);
  const rel = toRel(absPath, paths.projectDir);
  const bytes = sizeOf(absPath);
  const tokens = estimateTokens(bytes, rel);
  const input = { absPath, projectDir: paths.projectDir, cfg };
  const d = decide(input);
  const raw = tier0(input);
  const scores = scoreFile(input);
  const band = bandOf(raw);
  const label = labelOf(raw);
  const enforce = raw ? applyMode(raw, "enforce").verdict : "allow";
  const history = readDecisions(paths.ledger, 5000).filter((r) => r.path === rel);

  if (json) {
    say(JSON.stringify({
      path: rel, bytes, tokensEst: tokens, label, rule: d.rule, tier: d.tier, value: d.value,
      confidence: d.confidence, band, thresholds: THRESHOLDS, mode: cfg.mode, verdict: d.verdict,
      enforceVerdict: enforce, reason: d.reason, scores, seen: history.length,
    }, null, 2));
    return;
  }

  const lines = [
    `${safePath(rel)}`,
    `  size            ${bytes} bytes (~${fmtTokens(tokens)} tokens estimated)`,
    `  label           ${label}  ·  confidence ${d.confidence.toFixed(2)}  ·  rule ${d.rule} (tier ${d.tier})`,
    `  band            ${band.padEnd(5)} ${BAND_TEXT[band]}`,
    `  thresholds      act ≥ ${THRESHOLDS.denyMinConfidence.toFixed(2)}  ·  ask ≥ ${THRESHOLDS.askMinConfidence.toFixed(2)}  ·  below that, always read`,
    `  context value   ${d.value}/3`,
    `  verdict         ${d.verdict}${d.suppressedByMode ? ` in ${cfg.mode} mode (enforce would ${enforce})` : ""}`,
    `  why             ${d.reason}`,
  ];
  if (history.length > 0) {
    lines.push(`  seen            ${history.length} time(s); last ${history[history.length - 1]!.ts}`);
  }
  lines.push("", "  SCORES          independent per label; read = 1 − the strongest flag");
  for (const x of scores) {
    const note = x.hint ? `near miss (${x.rule}), below the ask threshold: never acted on` : x.label === "read" ? "" : x.rule;
    lines.push(`    ${x.label.padEnd(13)} ${x.score.toFixed(2)}  ${bar(x.score, 20)}  ${note}`.trimEnd());
  }
  if (d.value <= 1) {
    lines.push("", `  Disagree? /snout:allow ${rel}`);
  }
  say(lines.join("\n"));
}

const BAND_TEXT: Record<Band, string> = {
  act: "enforce withholds it; advise asks; observe records it",
  ask: "enforce and advise ask first; observe records it",
  read: "every mode reads it",
};

function bar(frac: number, width: number): string {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return "█".repeat(n) + "·".repeat(width - n);
}

/** Directories never descended by scan. `.git` is object storage no agent reads. */
const SCAN_SKIP = new Set([".git", ".hg", ".svn"]);

/** Tracked plus untracked-but-not-ignored files under `root`, or null outside a git repo. */
function gitListed(root: string): string[] | null {
  try {
    const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}
const SCAN_MAX_FILES = 100_000;

/**
 * `snout scan [dir]` — the per-label distribution for a whole tree, before an agent reads
 * any of it: what each label would cost, and which threshold band it falls in. The same
 * rules the hooks run; nothing is recorded.
 */
function cmdScan(paths: Paths, cfg: Config, args: string[]): void {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const json = args.includes("--json");
  const t = { ...THRESHOLDS };
  for (const [name, key] of [["--deny", "denyMinConfidence"], ["--ask", "askMinConfidence"]] as const) {
    const v = flag(name);
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) return say(`${name} takes a number from 0 to 1.`);
    t[key] = n;
  }
  if (t.askMinConfidence > t.denyMinConfidence) return say("--ask must not be above --deny.");
  const modeArg = flag("--mode");
  if (modeArg !== undefined && !isValidMode(modeArg)) return say("--mode takes observe, advise or enforce.");
  const mode = (modeArg as Config["mode"] | undefined) ?? "enforce";
  const topN = Math.max(0, Math.min(100, Number(flag("--top") ?? 10) || 10));

  const valued = new Set(["--deny", "--ask", "--mode", "--top"]);
  const target = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  const root = target ? (isAbsolute(target) ? target : join(paths.projectDir, target)) : paths.projectDir;

  const started = Date.now();
  const files: ScannedFile[] = [];
  let truncated = false;
  const add = (abs: string) => {
    const input = { absPath: abs, projectDir: paths.projectDir, cfg };
    files.push({ rel: toRel(abs, paths.projectDir), bytes: sizeOf(abs), raw: tier0(input) });
  };
  // In a git repo, count what an agent would browse: tracked files plus new ones git does not
  // ignore. `--all` counts everything on disk, node_modules and build output included.
  const listed = args.includes("--all") ? null : gitListed(root);
  if (listed) {
    for (const rel of listed) {
      if (files.length >= SCAN_MAX_FILES) { truncated = true; break; }
      const abs = join(root, rel);
      if (isRegularFile(abs)) add(abs);
    }
  }
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        add(abs);
      }
    }
  };
  if (!listed) walk(root);
  const ms = Date.now() - started;
  const sum = summarize(files, mode, t, topN);

  if (json) {
    say(JSON.stringify({ root: toRel(root, paths.projectDir) || ".", truncated, ms, ...sum }, null, 2));
    return;
  }
  say(renderScan(sum, toRel(root, paths.projectDir) || ".", truncated, ms));
}

function renderScan(sum: Summary, root: string, truncated: boolean, ms: number): string {
  const pct = (n: number) => (sum.tokens > 0 ? `${Math.round((n / sum.tokens) * 100)}%` : "0%");
  const t = sum.thresholds;
  const lines = [
    `snout scan — ${safePath(root)} · ${sum.files} file(s) · ~${fmtTokens(sum.tokens)} tokens if every file were read whole · ${ms} ms`,
    `  thresholds: act ≥ ${t.denyMinConfidence.toFixed(2)} · ask ≥ ${t.askMinConfidence.toFixed(2)} · below that, always read`,
    "",
    "  BY LABEL          files      ~tokens   share",
  ];
  for (const r of sum.labels) {
    const share = sum.tokens > 0 ? r.tokens / sum.tokens : 0;
    lines.push(`    ${r.label.padEnd(13)} ${String(r.files).padStart(7)}  ${("~" + fmtTokens(r.tokens)).padStart(10)}  ${pct(r.tokens).padStart(5)}  ${bar(share, 20)}`);
  }
  lines.push(
    "",
    "  BY BAND           files      ~tokens   share",
    `    act             ${String(sum.bands.act.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.act.tokens)).padStart(10)}  ${pct(sum.bands.act.tokens).padStart(5)}   enforce withholds`,
    `    ask             ${String(sum.bands.ask.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.ask.tokens)).padStart(10)}  ${pct(sum.bands.ask.tokens).padStart(5)}   asks first`,
    `    read            ${String(sum.bands.read.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.read.tokens)).padStart(10)}  ${pct(sum.bands.read.tokens).padStart(5)}   always read`,
  );
  if (sum.top.length > 0) {
    lines.push("", "  LARGEST FLAGGED");
    for (const f of sum.top) {
      lines.push(`    ${("~" + fmtTokens(f.tokens)).padStart(8)}  ${f.label.padEnd(11)} ${f.confidence.toFixed(2)}  ${f.band.padEnd(4)}  ${safePath(f.rel)}`);
    }
  }
  lines.push(
    "",
    `  An agent pays only for what it reads, so this is the exposure, not a session's cost —`,
    `  /snout:report shows what was actually read. What-if: --deny 0.95 --ask 0.6 · --json for scripts.`,
  );
  if (truncated) lines.push(`  Stopped at ${SCAN_MAX_FILES} files; pass a subdirectory to scan the rest.`);
  return lines.join("\n");
}

function cmdReset(paths: Paths): void {
  for (const p of [paths.ledger, paths.turns, paths.errors, paths.hooks, paths.state]) {
    try {
      if (existsSync(p)) writeAtomic(p, "");
    } catch (err) {
      recordError("reset", err);
    }
  }
  say("Cleared .snout/ledger.jsonl, turns.jsonl, errors.jsonl, hooks.jsonl and state.json.");
}

function cmdDoctor(paths: Paths, cfg: Config): void {
  const rows = readDecisions(paths.ledger, 5000);
  const t = totalsOf(rows.filter((r) => r.rule !== "reversal"));
  const errors = existsSync(paths.errors) ? readFileSync(paths.errors, "utf8").trim().split("\n").filter(Boolean) : [];

  const lines = [
    `snout ${VERSION}`,
    `  node            ${process.version}`,
    `  bundle          ${runningBundle()}`,
    `  project         ${paths.projectDir}`,
    `  .snout            ${existsSync(paths.snoutDir) ? "present" : "MISSING"}`,
    `  config          ${existsSync(paths.config) ? paths.config : "no project file"}`,
    `  user defaults   ${existsSync(userConfigPath()) ? userConfigPath() : "none (~/.snout/config.json)"}`,
    `  mode from       ${configSource(paths, "mode")}`,
    `  mode            ${cfg.mode}`,
    `  decisions       ${rows.length}`,
    `  p95 latency     ${percentile(t.latencies, 95)} ms`,
    `  errors logged   ${errors.length}`,
    `  blocking hook   ${blockingHookLine(gateMatcher(paths))}`,
  ];

  // Registration is the first question doctor must answer, because every other number on
  // this screen is meaningless if no hook ever ran. A zero decision count reads as "nothing
  // was worth flagging" when the truth may be "the plugin is not wired in at all".
  const seen = lastSeenByEvent(paths);
  lines.push("", "  HOOKS SEEN");
  if (seen.size === 0) {
    lines.push(
      "    none — no hook has ever run in this project.",
      "",
      "    That is an installation problem, not a quiet session. Check that /plugin lists",
      "    snout as enabled, then restart Claude Code: hooks are registered when",
      "    the session starts, so a plugin enabled mid-session does nothing until then.",
    );
  } else {
    for (const event of RECORDING_HOOKS) {
      const ts = seen.get(event);
      lines.push(`    ${event.padEnd(14)} ${ts ? ago(ts) : "never"}`);
    }
    if (!seen.has("post-tool")) {
      // A missing post-tool has two causes that look identical in the log: the session is
      // too young to have read anything, or it reads through Bash. A stop heartbeat newer
      // than the latest session start means a turn has finished, which separates them.
      // ISO timestamps compare correctly as strings.
      const started = seen.get("session-start") ?? "";
      const stopped = seen.get("stop");
      const turnFinished = stopped !== undefined && stopped > started;
      lines.push(
        "",
        "    Hooks are firing, but post-tool has never run — that is the one that classifies",
        ...(turnFinished
          ? [
              "    reads. It matches Read, Bash, Grep, Glob, web and MCP tools. A turn has finished without one",
              "    firing, so either this session read nothing, or the running plugin predates the",
              "    Bash matcher — check the bundle line above, reinstall, and restart.",
            ]
          : [
              "    reads. No turn has finished since the session started, so the likeliest reason",
              "    is that nothing has used the Read tool yet. Read one file and run doctor again;",
              "    if post-tool is still never, the installed copy may be stale: check its version",
              "    with /plugin and restart Claude Code after updating.",
            ]),
      );
    }
  }

  // The one inconsistency a user can create: asking for enforcement without the hook that
  // enforces. Nothing will be blocked, and nothing will say why.
  if (cfg.mode !== "observe" && !gateInstalled(paths)) {
    lines.push(
      "",
      `  Mode is "${cfg.mode}" but the blocking hook is not installed, so nothing can be`,
      "  blocked. Run /snout:mode " + cfg.mode + " again to install it.",
    );
  }
  if (cfg.mode === "observe" && gateInstalled(paths)) {
    lines.push(
      "",
      "  The blocking hook is installed but mode is \"observe\", so it allows every read",
      "  and still costs a process per read. Run /snout:mode observe to remove it.",
    );
  }
  if (errors.length > 0) lines.push("", "  Most recent error:", `  ${errors[errors.length - 1]}`);

  // A transcript read is the only place we get real numbers, so doctor proves it works.
  const tp = process.env.SNOUT_TRANSCRIPT;
  if (tp && existsSync(tp)) {
    const u = readTranscriptUsage(readFileSync(tp, "utf8"));
    lines.push(
      "",
      "  MEASURED FROM TRANSCRIPT",
      `    requests      ${u.requests}`,
      `    input (new)   ${fmtTokens(u.inputUncached)}`,
      `    cache create  ${fmtTokens(u.cacheCreate)}`,
      `    cache read    ${fmtTokens(u.cacheRead)}`,
      `    output        ${fmtTokens(u.output)}`,
    );
  }
  say(lines.join("\n"));
}

// ---------------------------------------------------------------- plumbing

const HELP = `snout ${VERSION} · the context gate for coding agents

  snout                      status: mode, what's been kept out, what it saved
  snout init [agent]         set up claude, codex, cursor or gemini in this project
  snout scan                 how much of this repo is low-value context
  snout report               what was read, kept out and saved, with spend (--all for every session)
  snout dashboard            live savings in the browser
  snout mode observe|enforce record only, or trim low-value reads
  snout explain <file>       why a file was trimmed        snout allow <file>   never trim it
  snout login                team dashboard (syncs daily totals, never code)

  Docs and advanced commands: https://github.com/biffbuster/snout-context#cli`;

/**
 * Reads the hook payload from stdin.
 *
 * `readFileSync(0)` is the obvious implementation and it is wrong: when stdin is a pipe
 * whose writer has not yet written, the read fails with EAGAIN. Measured on macOS, that
 * happened on roughly 57% of invocations — the hook silently did nothing, and because the
 * payload carries `cwd`, the ones that failed also resolved the project directory to
 * wherever the process happened to start. Both failures are invisible: the hook still
 * exits 0 and the agent proceeds.
 *
 * So we read in a loop, treat EAGAIN as "not ready yet" rather than as end of input, and
 * give up after a bounded wait.
 */
function readStdin(timeoutMs = 1000): string {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  const buf = Buffer.allocUnsafe(65_536);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        sleepSync(2);
        continue;
      }
      if (code === "EOF" || code === "EBADF" || code === "ENXIO") break;
      throw err;
    }
    if (n === 0) break; // genuine end of input
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A synchronous sleep. The hook has no event loop to yield to before its work is done. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHookInput(): HookInput {
  try {
    const raw = readStdin();
    if (!raw.trim()) return {};
    return JSON.parse(raw) as HookInput;
  } catch (err) {
    recordError("readHookInput", err);
    return {};
  }
}

/** Set while another agent's hook runs through the gate: its response is translated, not printed. */
let capturing = false;
let captured: Record<string, unknown> | null = null;
/** The agent whose hook is being translated, stamped on its ledger rows. Absent for Claude Code. */
let client: string | undefined;

/**
 * A ledger row, tagged with the agent that made the read, and with the session's model when
 * the row doesn't name one, so the dashboards can split savings by model.
 */
function recordRow(path: string, row: object): void {
  if (duplicateCall) return;
  const r = row as { model?: string | null; session?: string };
  let model = r.model;
  if (!model) {
    try {
      const st = JSON.parse(readFileSync(join(dirname(path), "state.json"), "utf8")) as Partial<SessionState>;
      if (st.model && st.session === r.session) model = st.model;
    } catch {
      // no state yet: the row goes out without a model
    }
  }
  appendRow(path, { ...row, ...(model ? { model } : {}), ...(client ? { client } : {}) });
}

function emit(payload: Record<string, unknown>): void {
  if (Object.keys(payload).length === 0) return; // silence is a valid hook response
  if (capturing) {
    captured = payload;
    return;
  }
  writeOut(JSON.stringify(payload));
}

function say(text: string): void {
  writeOut(text + "\n");
}

/**
 * Writes to stdout synchronously.
 *
 * `process.stdout.write` is asynchronous when stdout is a pipe, and this process ends with
 * `process.exit(0)`, which does not flush pending writes. For a short hook response that
 * never bites; for a long report it is a truncated answer with no error. writeSync removes
 * the question, and handles the partial-write case a pipe can return.
 */
function writeOut(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue; // a full pipe; the reader will drain it
      if (code === "EPIPE") return; // the reader went away, which is not our error
      throw err;
    }
  }
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | null {
  const v = obj?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function rememberPending(paths: Paths, state: SessionState, id: string | undefined, path: string, decision: Verdict): void {
  if (!id) return;
  const s = state as SessionState & { pending?: Record<string, { path: string; decision: Verdict }> };
  s.pending ??= {};
  s.pending[id] = { path, decision };
  // Cap the map: a long session would otherwise grow state.json without bound.
  const keys = Object.keys(s.pending);
  if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete s.pending[k];
  saveState(paths.state, s);
}

/**
 * Is the opt-in PreToolUse hook present in the project's settings? Recording runs through
 * a non-blocking PostToolUse hook that the plugin ships; only enforcement needs the
 * blocking one, and only /snout:mode installs it.
 */
/**
 * Which copy of the plugin is executing.
 *
 * `claude plugin install` takes a snapshot into its own cache, so a repo checkout and the
 * running plugin can silently diverge — editing `src/` then wondering why nothing changed
 * costs an afternoon exactly once. Naming the path makes that visible.
 */
function runningBundle(): string {
  const self = process.argv[1] ?? "unknown";
  const kind = self.includes("/.claude/plugins/cache/") ? "plugin" : /node_modules|\/bin\/snout$/.test(self) ? "npm" : "local checkout";
  return `${self}  (${kind})`;
}

function gateInstalled(paths: Paths): boolean {
  return gateMatcher(paths) !== null;
}

function blockingHookLine(matcher: string | null): string {
  if (matcher === null) return "not installed — recording only";
  if (!matcher.split("|").includes("Bash")) {
    return `installed (PreToolUse: ${matcher}) — Bash is not gated, so a denied file can still be cat'd; run /snout:mode again to update`;
  }
  return "installed (PreToolUse)";
}

/**
 * The tools Snout's PreToolUse entries gate, joined like a matcher ("Read|NotebookRead|Bash"),
 * or null when none is installed. /snout:mode now installs Read and Bash as separate entries
 * (Bash split into one `if`-filtered handler per printing command), so every entry counts.
 */
function gateMatcher(paths: Paths): string | null {
  const tools = new Set<string>();
  let found = false;
  for (const f of ["settings.json", "settings.local.json"]) {
    const p = join(paths.projectDir, ".claude", f);
    if (!existsSync(p)) continue;
    try {
      // Parsed, not grepped: the previous regex matched the two strings anywhere in the
      // file, so an unrelated PreToolUse hook plus any mention of snout.mjs read as "ours".
      const settings = JSON.parse(readFileSync(p, "utf8")) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      const entries = settings.hooks?.PreToolUse ?? [];
      for (const entry of entries) {
        if (!(entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("snout.mjs"))) continue;
        found = true;
        for (const t of (entry.matcher ?? "").split("|")) if (t) tools.add(t);
      }
    } catch (err) {
      // A settings file we cannot parse is the user's problem to see, not ours to guess at.
      recordError("gateInstalled", err);
    }
  }
  return found ? [...tools].join("|") : null;
}

/**
 * Sets one key in one layer's file, leaving every other key as written. Previously the
 * whole merged config was persisted, so running `/snout:allow` with `SNOUT_MODE=enforce` set
 * silently made enforce permanent, and user-level defaults would have been copied into
 * every project. `undefined` removes the key, handing it back to the layer below.
 */
function setConfigKey<K extends keyof Config>(file: string, key: K, value: Config[K] | undefined): void {
  try {
    const layer = readLayer(file) as Record<string, unknown>;
    if (value === undefined) delete layer[key];
    else layer[key] = value;
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify(layer, null, 2) + "\n");
  } catch (err) {
    recordError("writeConfig", err);
  }
}

try {
  main();
} catch (err) {
  // The last line of defence. A classifier must never be the reason a session fails.
  recordError("main", err);
}
// The MCP server keeps running until its client closes stdin; everything else is one-shot.
// So does the dashboard, until Ctrl-C.
// So do the cloud commands, which exit when their request finishes.
if (!["mcp", "dashboard", "login", "logout", "sync", "audit"].includes(process.argv[2] ?? "")) process.exit(0);
