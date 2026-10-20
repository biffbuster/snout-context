/**
 * Installs and removes the blocking gate: the PreToolUse hooks enforce mode needs.
 *
 * The plugin ships only non-blocking hooks, so observe mode costs nothing. Enforce adds a
 * PreToolUse hook to the project's `.claude/settings.local.json` (personal, not committed):
 * every Read, and Bash only for the commands that can print a file whole. Each Bash handler
 * carries an `if` filter, so `git`, `npm test`, `rg` and every other command never start Node.
 *
 * The command names this Snout's own bundle by absolute path, because `${CLAUDE_PLUGIN_ROOT}`
 * is only set for hooks that ship inside a plugin. A plugin update moves that path, so
 * session start re-points an installed gate at the current bundle (`refreshGate`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../util/atomic.js";
import { configDir } from "../config.js";
import { SQUEEZE_IFS } from "../squeeze/squeeze.js";

/** Bash commands that can print a whole file. Anything else is never gated. */
export const PRINTING_COMMANDS = ["cat", "head", "tail", "less", "more", "bat", "nl", "tac", "rev", "sed", "awk", "jq", "xxd", "od", "strings"];

const MARK = "snout.mjs";
const SETTINGS = ["settings.json", "settings.local.json"];

type Hook = { type: string; command?: string; url?: string; timeout?: number; if?: string };

/**
 * The fast path: blocking hooks POST to a long-running `snout serve` on this port instead of
 * starting Node for every call (about 90 ms of process start each). The port is per user, so on a
 * shared machine one user's hooks never reach another user's server. SNOUT_PORT overrides it.
 */
export const HOOK_PORT = Number(process.env.SNOUT_PORT) || 47613 + ((process.getuid?.() ?? 0) % 1000);
const URL_MARK = "/snout/v1/";
/** True for an HTTP hook pointed at `snout serve`. */
export const isSnoutUrl = (url: unknown): boolean => typeof url === "string" && url.includes(URL_MARK);
export const hookUrl = (event: string): string => `http://127.0.0.1:${HOOK_PORT}${URL_MARK}${event}`;
/** A command hook, or with `fast` an HTTP hook to `snout serve` for the same event. */
const hookFor = (bin: string, event: string, fast: boolean, extra: Partial<Hook> = {}): Hook =>
  fast ? { type: "http", url: hookUrl(event), timeout: 5, ...extra } : { type: "command", command: `node "${bin}" ${event}`, timeout: 5, ...extra };
type Entry = { matcher?: string; hooks?: Hook[] };

/**
 * Squeeze: a foreground PostToolUse hook for noisy command families only. A command hook needs an
 * `if` filter per family so other commands never start Node; the fast gate's server decides the
 * same thing in about a millisecond (`kindOf`), so it gets one entry. Agents read settings files,
 * and 56 filters made Snout's own block about 13 KB of context.
 */
export function squeezeEntries(bin: string, fast = false): Entry[] {
  if (fast) return [{ matcher: "Bash|mcp__.*", hooks: [hookFor(bin, "squeeze", true)] }];
  return [
    { matcher: "Bash", hooks: SQUEEZE_IFS.map((c) => hookFor(bin, "squeeze", fast, { if: `Bash(${c})` })) },
    // Every MCP tool: large results (browser snapshots, diffs, query rows) are trimmed the same way.
    { matcher: "mcp__.*", hooks: [hookFor(bin, "squeeze", fast)] },
  ];
}

export function gateEntries(bin: string, fast = false): Entry[] {
  // The server skips any Bash command that prints no file (`readTargets`), as the `if` filters do.
  if (fast) return [{ matcher: "Read|NotebookRead|Bash", hooks: [hookFor(bin, "pre-tool", true)] }];
  return [
    { matcher: "Read|NotebookRead", hooks: [hookFor(bin, "pre-tool", fast)] },
    { matcher: "Bash", hooks: PRINTING_COMMANDS.map((c) => hookFor(bin, "pre-tool", fast, { if: `Bash(${c} *)` })) },
  ];
}

/**
 * The fast gate's own starter: `snout serve --ensure` at session start and on each prompt. HTTP
 * hooks can't start the server they call, and the plugin's hooks may not run (an npm install
 * with no plugin, a host that doesn't load plugins), so without this nothing brings the server
 * up and every gated call fails with "connection refused". When it is already up this is one
 * health check.
 */
const ENSURE = "serve --ensure";
export function starterEntries(bin: string): Entry[] {
  // The starter itself bounds its child to 4 s; a second hook timeout only enlarges settings.
  return [{ hooks: [{ type: "command", command: `node "${starterPath()}" "${bin}" ${ENSURE}` }] }];
}

/**
 * The starter goes through a small script at a fixed path, not straight to `bin`: a plugin
 * update moves the bundle to a new versioned folder and may delete the old one, and when the
 * plugin's own hooks don't run nothing re-points the gate. The script runs the current plugin
 * bundle (from Claude Code's install record) when `bin` was a plugin bundle, else `bin`, else
 * whichever of the two still exists.
 */
export const starterPath = (): string => join(configDir(), "starter.mjs");
const STARTER = `// Written by Snout (snout fast on). Starts the local Snout server for the fast gate.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const [bin, ...args] = process.argv.slice(2);
function plugin() {
  try {
    const j = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plugins", "installed_plugins.json"), "utf8"));
    for (const e of (j.plugins ?? j)["snout@snout-context"] ?? []) {
      const p = e?.installPath && join(e.installPath, "dist", "snout.mjs");
      if (p && existsSync(p)) return p;
    }
  } catch {}
  return null;
}
const inPlugin = /[\\\\/]\\.claude[\\\\/]plugins[\\\\/]/.test(bin ?? "");
const run = (inPlugin ? plugin() : null) ?? (bin && existsSync(bin) ? bin : null) ?? plugin();
if (run) spawnSync(process.execPath, [run, ...args], { stdio: "ignore", timeout: 4000, windowsHide: true });
`;

function writeStarter(): void {
  const file = starterPath();
  try {
    if (readFileSync(file, "utf8") === STARTER) return;
  } catch {
    // not written yet
  }
  mkdirSync(configDir(), { recursive: true });
  writeAtomic(file, STARTER);
}
const STARTER_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;

const ours = (h: Hook, event: string) =>
  (typeof h.command === "string" && h.command.includes(MARK) && h.command.includes(event)) || (typeof h.url === "string" && h.url.includes(URL_MARK + event));
const isGate = (e: Entry) => (e.hooks ?? []).some((h) => ours(h, "pre-tool"));
const isSqueeze = (e: Entry) => (e.hooks ?? []).some((h) => ours(h, "squeeze"));
const isStarter = (e: Entry) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes(ENSURE));

function read(file: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function write(file: string, settings: Record<string, any>): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeAtomic(file, JSON.stringify(settings, null, 2) + "\n");
}

/** Removes Snout's gate and squeeze hooks from a settings object, leaving every other hook alone. */
function strip(settings: Record<string, any>): boolean {
  let changed = false;
  for (const [event, mine] of [["PreToolUse", isGate], ["PostToolUse", isSqueeze], ...STARTER_EVENTS.map((ev) => [ev, isStarter] as const)] as const) {
    const list: Entry[] | undefined = settings.hooks?.[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !mine(e));
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}

/** Installs the gate (replacing any older Snout gate) in the personal settings file. */
export function installGate(projectDir: string, bin: string, fast = false): string {
  removeGate(projectDir);
  const file = join(projectDir, ".claude", "settings.local.json");
  const settings = read(file);
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...(settings.hooks.PreToolUse ?? []), ...gateEntries(bin, fast)];
  settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse ?? []), ...squeezeEntries(bin, fast)];
  if (fast) writeStarter();
  if (fast) for (const ev of STARTER_EVENTS) settings.hooks[ev] = [...(settings.hooks[ev] ?? []), ...starterEntries(bin)];
  write(file, settings);
  return file;
}

/** Removes the gate from both settings files. Returns whether anything was removed. */
export function removeGate(projectDir: string): boolean {
  let removed = false;
  for (const name of SETTINGS) {
    const file = join(projectDir, ".claude", name);
    if (!existsSync(file)) continue;
    const settings = read(file);
    if (strip(settings)) {
      write(file, settings);
      removed = true;
    }
  }
  return removed;
}

/**
 * Re-points an installed gate at `bin` when a plugin update has moved the bundle, and gives an
 * HTTP gate installed before it had one its starter. Keeps the gate's kind (command or HTTP).
 */
export function refreshGate(projectDir: string, bin: string): boolean {
  for (const name of SETTINGS) {
    const file = join(projectDir, ".claude", name);
    if (!existsSync(file)) continue;
    const hooks: Record<string, Entry[]> = read(file).hooks ?? {};
    const gate = (hooks.PreToolUse ?? []).filter(isGate);
    if (!gate.length) continue;
    const fast = gate.some((e) => (e.hooks ?? []).some((h) => isSnoutUrl(h.url)));
    const elsewhere = (e: Entry) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && !h.command.includes(`"${bin}"`));
    const starters = STARTER_EVENTS.map((ev) => (hooks[ev] ?? []).filter(isStarter));
    // A fast gate written with per-command filters (0.3.0 and before) is rewritten in the short form.
    const filtered = fast && gate.some((e) => (e.hooks ?? []).some((h) => h.if));
    const stale = gate.some(elsewhere) || starters.some((l) => l.some(elsewhere)) || (fast && starters.some((l) => !l.length)) || filtered;
    if (stale) {
      installGate(projectDir, bin, fast);
      return true;
    }
  }
  return false;
}
