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
import { SQUEEZE_IFS } from "../squeeze/squeeze.js";

/** Bash commands that can print a whole file. Anything else is never gated. */
export const PRINTING_COMMANDS = ["cat", "head", "tail", "less", "more", "bat", "nl", "tac", "rev", "sed", "awk", "jq", "xxd", "od", "strings"];

const MARK = "snout.mjs";
const SETTINGS = ["settings.json", "settings.local.json"];

type Hook = { type: string; command: string; timeout?: number; if?: string };
type Entry = { matcher?: string; hooks?: Hook[] };

/** Squeeze: a foreground PostToolUse hook for noisy command families only. */
export function squeezeEntries(bin: string): Entry[] {
  const command = `node "${bin}" squeeze`;
  return [
    { matcher: "Bash", hooks: SQUEEZE_IFS.map((c) => ({ type: "command", if: `Bash(${c})`, command, timeout: 5 })) },
    // Every MCP tool: large results (browser snapshots, diffs, query rows) are trimmed the same way.
    { matcher: "mcp__.*", hooks: [{ type: "command", command, timeout: 5 }] },
  ];
}

export function gateEntries(bin: string): Entry[] {
  const command = `node "${bin}" pre-tool`;
  return [
    { matcher: "Read|NotebookRead", hooks: [{ type: "command", command, timeout: 5 }] },
    { matcher: "Bash", hooks: PRINTING_COMMANDS.map((c) => ({ type: "command", if: `Bash(${c} *)`, command, timeout: 5 })) },
  ];
}

const isGate = (e: Entry) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes("pre-tool"));
const isSqueeze = (e: Entry) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes("squeeze"));

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
  for (const [event, mine] of [["PreToolUse", isGate], ["PostToolUse", isSqueeze]] as const) {
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
export function installGate(projectDir: string, bin: string): string {
  removeGate(projectDir);
  const file = join(projectDir, ".claude", "settings.local.json");
  const settings = read(file);
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...(settings.hooks.PreToolUse ?? []), ...gateEntries(bin)];
  settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse ?? []), ...squeezeEntries(bin)];
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

/** Re-points an installed gate at `bin` when a plugin update has moved the bundle. */
export function refreshGate(projectDir: string, bin: string): boolean {
  for (const name of SETTINGS) {
    const file = join(projectDir, ".claude", name);
    if (!existsSync(file)) continue;
    const pre: Entry[] = read(file).hooks?.PreToolUse ?? [];
    const stale = pre.some((e) => isGate(e) && (e.hooks ?? []).some((h) => h.command.includes(MARK) && !h.command.includes(`"${bin}"`)));
    if (stale) {
      installGate(projectDir, bin);
      return true;
    }
  }
  return false;
}
