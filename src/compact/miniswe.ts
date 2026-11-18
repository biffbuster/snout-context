/**
 * mini-swe-agent trajectories read as Claude Code rows, so one reader (memory.ts) gives the same
 * session facts for them as for Claude Code and Codex: the task, the test command that ran and its
 * result, the first failure the session got past, the files it changed, and its last words.
 *
 * A trajectory is the agent's message list (`*.traj.json`, format mini-swe-agent-1.1 or the legacy
 * one without `info`): the task in the first user message, each step an assistant message whose
 * shell commands are in `extra.actions` (or its `tool_calls`), each command's output in the `tool`
 * message with the same `tool_call_id`, and the submitted diff in the `exit` message.
 */
type Entry = Record<string, unknown>;

/** A command that writes, shows or submits the final patch rather than working on the code. */
const SUBMITTING = /COMPLETE_TASK_AND_SUBMIT|\bpatch\.(?:txt|diff)\b|^\s*(?:cd \S+ && )?git (?:diff|status)\b/;

/** The task inside mini-swe-agent's prompt: the text of its <pr_description> (or <issue>), else the message. */
export function minisweTask(text: string): string {
  const m = /<(pr_description|issue)>\s*(?:Consider the following PR description:\s*)?([\s\S]*?)<\/\1>/.exec(text);
  return (m ? m[2]! : text).trim();
}

/** Files a unified diff changes (its `+++ b/` side; a deleted file is not one to look at again). */
export function diffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const m of diff.matchAll(/^\+\+\+ b\/(.+?)\s*$/gm)) if (!files.includes(m[1]!)) files.push(m[1]!);
  return files;
}

function commandsOf(msg: any): { id: string; command: string }[] {
  const actions = msg?.extra?.actions;
  if (Array.isArray(actions) && actions.length) return actions.filter((a: any) => typeof a?.command === "string").map((a: any, i: number) => ({ id: String(a.tool_call_id ?? `${i}`), command: a.command }));
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  return calls.flatMap((c: any) => {
    try {
      const command = JSON.parse(c?.function?.arguments ?? "{}").command;
      return typeof command === "string" ? [{ id: String(c.id), command }] : [];
    } catch {
      return [];
    }
  });
}

/** Tool output as the agent saw it: the raw output, else the message text without its <returncode>/<output> wrapper. */
function outputOf(msg: any): string {
  const raw = msg?.extra?.raw_output;
  if (typeof raw === "string") return raw;
  const text = typeof msg?.content === "string" ? msg.content : "";
  return text.replace(/<\/?(returncode|output)>/g, "").trim();
}

export function minisweRows(messages: unknown[]): string[] {
  const rows: string[] = [];
  const push = (e: Entry) => rows.push(JSON.stringify(e));
  let asked = false;
  let n = 0;
  for (const msg of messages as any[]) {
    const role = msg?.role;
    if (role === "user" && !asked && typeof msg.content === "string") {
      asked = true;
      push({ type: "user", message: { content: minisweTask(msg.content) } });
    } else if (role === "assistant") {
      const commands = commandsOf(msg);
      // Its visible text is mostly empty; what it said it was doing is in its reasoning. Steps that only
      // write, show or submit the patch say nothing about the fix, so their words are not its last.
      const housekeeping = commands.length > 0 && commands.every((c) => SUBMITTING.test(c.command));
      const said = housekeeping ? undefined : [msg.content, msg.reasoning_content].find((t) => typeof t === "string" && t.trim().length >= 20);
      const content: Entry[] = said ? [{ type: "text", text: said }] : [];
      for (const c of commands) content.push({ type: "tool_use", id: `miniswe-${c.id}`, name: "Bash", input: { command: c.command } });
      if (content.length) push({ type: "assistant", message: { content } });
    } else if (role === "tool") {
      const id = msg.tool_call_id ?? msg.extra?.actions?.[0]?.tool_call_id;
      if (id !== undefined) push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `miniswe-${id}`, content: outputOf(msg), is_error: Number(msg.extra?.returncode ?? 0) !== 0 }] } });
    } else if (role === "exit") {
      const diff = typeof msg.extra?.submission === "string" ? msg.extra.submission : typeof msg.content === "string" ? msg.content : "";
      const edits = diffFiles(diff).map((f) => ({ type: "tool_use", id: `miniswe-edit-${n++}`, name: "Edit", input: { file_path: f } }));
      if (edits.length) push({ type: "assistant", message: { content: edits } });
    }
  }
  return rows;
}
