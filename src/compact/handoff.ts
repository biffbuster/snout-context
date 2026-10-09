/**
 * Compaction handoff. Claude Code adds whatever a PreCompact hook prints to the instructions for
 * the compaction summary. A summary that drops which files were in play and where the tests stood
 * makes the agent re-read and re-run after every compaction, and that re-reading is what decides
 * whether a smaller context budget saves money. So before a compaction Snout lists that working
 * state, read from the transcript since the last compaction, with no model: the current request,
 * files changed, files read recently, the last test run and open to-dos. A few hundred tokens.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

const TAIL_BYTES = 8 * 1024 * 1024;
const TEST = /\b(pytest|runtests\.py|bin\/test|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm test|yarn test|node --test|rspec|phpunit|tox)\b/;
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function tail(file: string): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const text = buf.toString("utf8");
  return start ? text.slice(text.indexOf("\n") + 1) : text;
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export interface WorkingState {
  request?: string;
  changed: string[];
  read: string[];
  test?: { command: string; result: string };
  todos: string[];
}

/** The working state since the last compaction, from a Claude Code transcript. */
export function workingState(transcriptPath: string, projectDir: string): WorkingState {
  // Inside the project: relative. Outside it (scratch files): the absolute path the agent used.
  const rel = (p: string) => {
    if (!isAbsolute(p)) return p;
    const r = relative(projectDir, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
  };
  const rows: any[] = [];
  for (const line of tail(transcriptPath).split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === "system" && o.subtype === "compact_boundary") rows.length = 0;
    else rows.push(o);
  }
  const state: WorkingState = { changed: [], read: [], todos: [] };
  const uses = new Map<string, any>();
  let lastTestId: string | undefined;
  for (const o of rows) {
    const content = o.message?.content;
    if (o.type === "user" && !o.isMeta && !o.isCompactSummary) {
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
      if (text.trim() && !/^<(command-|local-command|system-reminder)/.test(text.trim())) state.request = oneLine(text, 400);
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use") {
        uses.set(b.id, b);
        const file = b.input?.file_path ?? b.input?.notebook_path;
        if (typeof file === "string") {
          const list = EDITS.has(b.name) ? state.changed : b.name === "Read" ? state.read : null;
          if (list) { const p = rel(file); const i = list.indexOf(p); if (i >= 0) list.splice(i, 1); list.unshift(p); }
        }
        if (b.name === "Bash" && TEST.test(String(b.input?.command ?? ""))) lastTestId = b.id;
        if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) state.todos = b.input.todos.filter((t: any) => t?.status !== "completed").map((t: any) => oneLine(String(t.content ?? ""), 120));
      }
      if (b.type === "tool_result" && b.tool_use_id === lastTestId) {
        const out = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((p: any) => p.text ?? "").join("\n") : "";
        const lines = out.split("\n").map((l: string) => l.trim()).filter(Boolean);
        const verdict = [...lines].reverse().find((l) => /\b(passed|failed|error|errors|ok|FAILED|OK)\b/.test(l)) ?? lines.at(-1) ?? "";
        state.test = { command: oneLine(String(uses.get(b.tool_use_id)?.input?.command ?? ""), 160), result: oneLine(verdict, 200) };
      }
    }
  }
  // Project files first: scratch scripts outside the project matter less after a compaction.
  const projectFirst = (list: string[]) => [...list.filter((p) => !p.startsWith("..") && !isAbsolute(p)), ...list.filter((p) => p.startsWith("..") || isAbsolute(p))];
  state.changed = projectFirst(state.changed);
  state.read = projectFirst(state.read.filter((p) => !state.changed.includes(p)));
  return state;
}

/** The text for Claude Code's compaction instructions, or "" when there is nothing to hand over. */
export function handoffText(s: WorkingState): string {
  const lines: string[] = [];
  if (s.request) lines.push(`- Current request: ${s.request}`);
  if (s.changed.length) lines.push(`- Files changed: ${s.changed.slice(0, 12).join(", ")}`);
  if (s.read.length) lines.push(`- Files read recently: ${s.read.slice(0, 10).join(", ")}`);
  if (s.test) lines.push(`- Last test run: \`${s.test.command}\` → ${s.test.result}`);
  if (s.todos.length) lines.push(`- Open to-dos: ${s.todos.slice(0, 6).join("; ")}`);
  if (!lines.length) return "";
  return ["Keep this working state in the summary, with file paths exactly as written, so work continues without re-reading:", ...lines].join("\n");
}
