/**
 * Codex session files (`~/.codex/sessions/**\/rollout-*.jsonl`) as Claude Code transcript rows, so
 * the facts restored after a compaction come from the same rules for both agents. The on-disk
 * format is not a stable API, so this is best-effort: an unknown record is skipped, never fatal.
 *
 * A Codex line is `{ type, payload }`. What carries a fact:
 *   response_item message (role user)   what the user typed; context Codex injects as a user turn
 *       (AGENTS.md, environment) is marked by `content_item_kinds` without `user.text`, or in older
 *       sessions by its `# AGENTS.md instructions for` header or a leading tag, and skipped
 *   event_msg item_completed CommandExecution   a command and its output (CLI)
 *   response_item function_call shell_command | shell | exec_command, local_shell_call   a command
 *   response_item custom_tool_call exec   code mode (desktop app): JavaScript that calls
 *       `tools.exec_command`, `tools.shell_command`, `tools.apply_patch`, `tools.update_plan`
 *   response_item custom_tool_call / function_call apply_patch   files changed
 *   response_item function_call update_plan   the plan, as to-dos
 *   response_item function_call_output / custom_tool_call_output   a call's output, by call_id
 */
import { isAbsolute, resolve } from "node:path";

type Entry = Record<string, any>;

const SHELL_TOOLS = new Set(["shell_command", "shell", "exec_command", "local_shell", "container.exec"]);
const SHELLS = /^(?:.*[\\/])?(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?$/i;
/** A JavaScript string literal: "…", '…' or `…`. */
const STR = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60)`;

/** A Codex session file's lines as Claude-shaped transcript rows, in order. */
export function codexRows(lines: Iterable<string>): string[] {
  const rows: string[] = [];
  const push = (...entries: Entry[]) => { for (const e of entries) rows.push(JSON.stringify(e)); };
  const use = (id: string, name: string, input: Entry): Entry => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, content: string): Entry => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  let cwd: string | undefined;
  let synthetic = 0;
  const abs = (f: string) => (cwd && !isAbsolute(f) ? resolve(cwd, f) : f);
  const edits = (patch: string) => patchFiles(patch).map((f) => use(`codex-edit-${synthetic++}`, "Edit", { file_path: abs(f) }));
  for (const line of lines) {
    if (!line) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row?.payload;
    if (!p || typeof p !== "object") continue;
    if (row.type === "session_meta" || row.type === "turn_context") {
      if (typeof p.cwd === "string") cwd = p.cwd;
      continue;
    }
    if (row.type === "event_msg") {
      const item = p.item;
      if (p.type === "item_completed" && item?.type === "CommandExecution") {
        const cmd = commandText(item.command);
        const output = item.aggregated_output ?? item.formatted_output ?? [item.stdout, item.stderr].filter(Boolean).join("\n");
        if (cmd && typeof output === "string") { const id = `codex-command-${synthetic++}`; push(use(id, "Bash", { command: cmd }), result(id, output)); }
      }
      continue;
    }
    if (row.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
      if (Array.isArray(kinds) && !kinds.includes("user.text")) continue;
      let text = Array.isArray(p.content) ? p.content.filter((c: any) => c?.type === "input_text").map((c: any) => c.text ?? "").join(" ") : "";
      // With files attached, the desktop app lists them first and puts what the user typed under a heading.
      const typed = /^\s*# Files mentioned by the user:[\s\S]*?\n## My request(?: for Codex)?:\s*\n([\s\S]*)$/.exec(text);
      if (typed) text = typed[1]!;
      // Sessions without that metadata still mark injected instructions with this header.
      if (text.trim() && !/^\s*(?:# AGENTS\.md instructions for |<[a-z_-]+[\s>])/.test(text)) push({ type: "user", message: { content: text } });
      continue;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      push(result(p.call_id, outputText(p.output)));
      continue;
    }
    const id = String(p.call_id ?? p.id ?? `codex-call-${synthetic++}`);
    const name = String(p.name ?? "");
    if (p.type === "local_shell_call") {
      const command = commandText(p.action?.command);
      if (command) push(use(id, "Bash", { command }));
      continue;
    }
    if (p.type === "custom_tool_call") {
      const input = String(p.input ?? "");
      if (name === "apply_patch") push(...edits(input));
      if (name !== "exec") continue;
      // Code mode: the cell's output is one result for every command it ran.
      if (/\bapply_patch\b/.test(input)) push(...edits(unescapeJs(input)));
      const plan = codeModePlan(input);
      if (plan) push(use(`codex-plan-${synthetic++}`, "TodoWrite", { todos: plan }));
      const command = codeModeCommands(input);
      if (command) push(use(id, "Bash", { command }));
      continue;
    }
    if (p.type !== "function_call") continue;
    let args: any = {};
    try { args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments ?? {}; } catch { /* malformed call */ }
    if (name === "apply_patch") {
      const patch = typeof args === "string" ? args : args?.input ?? args?.patch;
      if (typeof patch === "string") push(...edits(patch));
    } else if (name === "update_plan" && Array.isArray(args?.plan)) {
      push(use(`codex-plan-${synthetic++}`, "TodoWrite", { todos: args.plan.map((s: any) => ({ content: String(s?.step ?? ""), status: s?.status })) }));
    } else if (SHELL_TOOLS.has(name)) {
      const command = commandText(args?.command ?? args?.cmd);
      if (command) push(use(id, "Bash", { command }));
    }
  }
  return rows;
}

/** A command given as a string, or as argv (`["bash", "-lc", "npm test"]` is `npm test`). */
function commandText(c: unknown): string | undefined {
  if (typeof c === "string") return c || undefined;
  if (!Array.isArray(c) || !c.every((x) => typeof x === "string")) return undefined;
  if (c.length >= 3 && SHELLS.test(c[0]!) && /^-(?:l?c|Command)$/i.test(c[c.length - 2]!)) return c[c.length - 1];
  return c.join(" ") || undefined;
}

/**
 * The commands a code-mode cell runs (`tools.exec_command({ cmd: "..." })`, `tools.shell_command({
 * command: '...' })`), one per line. The cell is JavaScript, not JSON, so the string literals given
 * as `cmd` or `command` are read rather than the call parsed.
 */
function codeModeCommands(code: string): string | undefined {
  if (!/\btools\.(exec_command|shell_command)\(/.test(code)) return undefined;
  const cmds: string[] = [];
  for (const m of code.matchAll(new RegExp(String.raw`["']?\b(?:cmd|command)["']?\s*:\s*${STR}`, "g"))) {
    const c = unescapeJs(m[1]!.slice(1, -1)).trim();
    if (c) cmds.push(c);
  }
  return cmds.length ? cmds.join("\n") : undefined;
}

/** The plan a code-mode cell sets through `tools.update_plan({ plan: [{ step, status }] })`. */
function codeModePlan(code: string): { content: string; status: string }[] | undefined {
  if (!/\btools\.update_plan\(/.test(code)) return undefined;
  const steps = [...code.matchAll(new RegExp(String.raw`["']?\bstep["']?\s*:\s*${STR}\s*,\s*["']?status["']?\s*:\s*${STR}`, "g"))];
  return steps.length ? steps.map((m) => ({ content: unescapeJs(m[1]!.slice(1, -1)), status: unescapeJs(m[2]!.slice(1, -1)) })) : undefined;
}

/** A JavaScript string literal's text: `\n` and `\t` become themselves, any other `\x` becomes x. */
function unescapeJs(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/** Files a patch adds, updates or moves to (a deleted file is not one to look at again). */
function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\s*\*\*\* (?:(?:Add|Update) File|Move to): ([^\n"'`]+?)\s*$/gm)) if (!files.includes(m[1]!)) files.push(m[1]!);
  return files;
}

function outputText(out: unknown): string {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return parts(out);
  if (out && typeof out === "object") {
    const o = out as Entry;
    return typeof o.output === "string" ? o.output : typeof o.content === "string" ? o.content : Array.isArray(o.content) ? parts(o.content) : "";
  }
  return "";
}

function parts(content: unknown[]): string {
  return content.map((x: any) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : "")).join("");
}
