/**
 * `snout init <agent>`: writes that agent's project hook config so its hooks call
 * `snout hook <agent> <event>`. Merges into an existing file, replaces Snout's own earlier
 * entries rather than adding duplicates, and never touches anyone else's hooks.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "../util/atomic.js";
import type { Agent } from "./adapt.js";

type Json = Record<string, any>;

/** How the agent should start this very bundle: node plus its absolute, quoted path. */
export function selfCommand(): string {
  let script = process.argv[1] ?? "snout";
  try {
    script = realpathSync(script);
  } catch {
    // keep what we were started with
  }
  return `node "${script}"`;
}

const OURS = /snout[\s\S]*\bhook (gemini|cursor|codex)\b/;

export function initAgent(agent: Agent, projectDir: string, cmd = selfCommand()): { file: string; events: string[] } {
  const hook = (event: string) => `${cmd} hook ${agent} ${event}`;
  if (agent === "cursor") {
    const file = join(projectDir, ".cursor", "hooks.json");
    const cfg = load(file);
    cfg.version ??= 1;
    cfg.hooks ??= {};
    const events = ["beforeReadFile", "beforeShellExecution"];
    for (const e of events) {
      cfg.hooks[e] = (Array.isArray(cfg.hooks[e]) ? cfg.hooks[e] : []).filter((h: Json) => !OURS.test(String(h?.command ?? "")));
      cfg.hooks[e].push({ command: hook(e), timeout: 10 });
    }
    save(file, cfg);
    return { file, events };
  }

  const file = agent === "gemini" ? join(projectDir, ".gemini", "settings.json") : join(projectDir, ".codex", "hooks.json");
  const cfg = load(file);
  cfg.hooks ??= {};
  const groups: [string, string | undefined][] =
    agent === "gemini"
      ? [["BeforeTool", "read_file|run_shell_command"], ["AfterTool", ".*"], ["SessionStart", undefined]]
      : [["PreToolUse", "^Bash$"], ["PostToolUse", ".*"], ["SessionStart", undefined], ["UserPromptSubmit", undefined], ["Stop", undefined]];
  for (const [e, matcher] of groups) {
    const kept = (Array.isArray(cfg.hooks[e]) ? cfg.hooks[e] : []).filter(
      (g: Json) => !(Array.isArray(g?.hooks) && g.hooks.some((h: Json) => OURS.test(String(h?.command ?? "")))),
    );
    const entry: Json = { type: "command", command: hook(e) };
    if (agent === "gemini") Object.assign(entry, { name: "snout", timeout: 10000 });
    kept.push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
    cfg.hooks[e] = kept;
  }
  save(file, cfg);
  return { file, events: groups.map(([e]) => e) };
}

function load(file: string): Json {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

function save(file: string, cfg: Json): void {
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(cfg, null, 2) + "\n");
}
