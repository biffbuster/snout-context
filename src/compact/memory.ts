/**
 * Session facts, taken by fixed rules from a session transcript (compactions included), with no model
 * and no search: the test command that ran, tools the environment lacks, commands that ran too long
 * for the tool's time limit, files changed, the session's first request and the current one, the
 * user's instructions, the last error not yet followed by a passing run, and open to-dos. They fill
 * each session's memory card (memory/memory.ts). Codex session files are read through compact/codex.ts.
 *
 * Measured failure behind these rules (long-session benchmark, 2026-10-09): after a compaction the
 * agent forgot how the project's tests run, installed and ran another test runner, and waited past
 * the time limit.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { codexRows } from "./codex.js";

const TAIL_BYTES = 16 * 1024 * 1024;
const HEAD_BYTES = 2 * 1024 * 1024;
// A project's own test script counts too (`node scripts/test.mjs`, `./run-tests.sh`, `make test`,
// `manage.py test`): many projects wrap their runner, and that wrapper is how tests run there.
const TEST = /\b(pytest|runtests\.py|bin\/test|jest|vitest|mocha|go test|cargo test|(?:npm|pnpm|yarn|bun)(?:\.cmd)? (?:run )?test|node --test|rspec|phpunit|tox|unittest|deno test|bun test|make (?:test|check)|manage\.py test)\b|(?:^|[\s/])(?:run[-_])?tests?(?:[-_]\w+)?\.(?:m?[jt]s|sh|py)\b/;
/** A test run that actually ran: the runner printed a count or a verdict. */
const RAN = /\b\d+ (passed|failed|errors?|skipped)\b|\bRan \d+ tests?\b|tests finished|^OK\b|\bOK \(|^FAILED\b|\bTests?:\s+\d+|^[#ℹ]?\s*pass\s+\d+\s*$|^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)|^FAIL\b/m;
/** `go test` names a failure on its own lines (`--- FAIL: TestX`, `FAIL\tpkg`), above a last line that may read `ok`. */
/** A result line that counts tests: "14 passed in 0.52s", "Ran 12 tests", "Tests: 3", "ℹ pass 7". */
const COUNTED = /\b\d+ (?:passed|failed|errors?|skipped)\b|\bRan \d+ tests?\b|\bTests?:\s+\d+|^[#ℹ]?\s*pass\s+\d+\s*$/;
const GO_FAIL =/^(?:--- FAIL:|FAIL\b)/m;
/** First words that only mention a runner (`grep pytest`, `pip install pytest`), never run one. */
const NOT_RUNNER = new Set(["cat", "grep", "rg", "sed", "awk", "head", "tail", "echo", "printf", "ls", "find", "pip", "pip3", "conda", "apt", "apt-get", "brew", "which", "type", "man"]);

/**
 * The test-runner part of a shell command, or undefined when none runs one. The runner must appear
 * outside quotes and heredoc bodies (a `python -c "...pytest..."` script is not how tests run
 * here), in its own `&&` / `;` / `|` segment; `cd` into the project and output filters are dropped.
 */
export function testCommand(command: string, projectDir: string): string | undefined {
  const noHeredoc = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "");
  const segments: { text: string; bare: string }[] = [];
  let text = "", bare = "", quote = "";
  const flush = () => { if (text.trim()) segments.push({ text: text.trim(), bare: bare.trim() }); text = ""; bare = ""; };
  for (let i = 0; i < noHeredoc.length; i++) {
    const ch = noHeredoc[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') { text += ch + (noHeredoc[++i] ?? ""); continue; }
      text += ch;
      if (ch === quote) { quote = ""; bare += '""'; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; text += ch; continue; }
    const two = noHeredoc.slice(i, i + 2);
    if (two === "&&" || two === "||") { flush(); i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n") { flush(); continue; }
    text += ch;
    bare += ch;
  }
  flush();
  const runs: string[] = [];
  let cd: string | undefined;
  for (const s of segments) {
    const words = s.bare.split(/\s+/);
    if (words[0] === "cd") { cd = s.text.slice(2).trim().replace(/^['"]|['"]$/g, ""); continue; }
    // Leading env assignments and `timeout N` wrap the runner; they don't make it a different one.
    while (words.length && (/^\w+=/.test(words[0]!) || words[0] === "timeout" || /^\d+[smh]?$/.test(words[0]!))) words.shift();
    if (!words.length || NOT_RUNNER.has(words[0]!) || !TEST.test(s.bare)) continue;
    let run = s.text.replace(/\s*2>&1\s*$/, "").split(`${projectDir}/`).join("");
    if (cd) {
      // Git Bash on Windows names the drive as a folder: /c/Users/... is C:/Users/...
      const dir = process.platform === "win32" ? cd.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:") : cd;
      const abs = isAbsolute(dir) ? dir : resolve(projectDir, dir);
      const r = relative(projectDir, abs).split(sep).join("/");
      if (r) run = `cd ${r.startsWith("..") ? cd : r} && ${run}`;
    }
    runs.push(run);
  }
  return runs.length ? runs.join(" && ") : undefined;
}

/** The environment lacks a tool or module. The last field marks a Python module, not a program. */
const MISSING: [RegExp, (m: RegExpMatchArray) => string, boolean][] = [
  [/No module named ['"]?([\w.]+)['"]?/, (m) => m[1]!, true],
  [/(?:^|\s)([\w.-]+): command not found/m, (m) => m[1]!, false],
  [/command not found: ([\w.-]+)/, (m) => m[1]!, false],
  // cmd.exe and PowerShell say it their own way.
  [/'([\w.-]+)' is not recognized as an internal or external command/, (m) => m[1]!, false],
  [/The term '([\w.-]+)' is not recognized as (?:the )?name of a cmdlet/, (m) => m[1]!, false],
];
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The first request in a transcript too long for its start to be in the tail. */
function firstRequest(file: string): string | undefined {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.min(HEAD_BYTES, statSync(file).size));
  try { readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
  for (const line of buf.toString("utf8").split("\n")) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const text = userText(o);
    const request = text === undefined ? undefined : requestText(text.replace(/<issue>[\s\S]*?(<\/issue>|$)/g, " "));
    if (request) return request;
  }
  return undefined;
}

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

const resultText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? "").join("\n") : "";

/** Claude Code's note when a command outlives the Bash tool's limit and moves to the background. */
const SLOW = /did not complete within its \d+s timeout|moved to the background/;

/**
 * A wrong import path, not a missing tool: a dotted name (`sympy.core.evaluate`: its package
 * exists) or a module the project itself contains.
 */
function projectModule(name: string, projectDir: string): boolean {
  if (name.includes(".")) return true;
  return existsSync(join(projectDir, name)) || existsSync(join(projectDir, `${name}.py`));
}

/** How many of the user's messages a Stop keeps in hand to check a lesson's quote against. */
const SAID = 40;

export interface SessionFacts {
  /** The session's first request: the task, which a summary paraphrases (arXiv 2609.20804 keeps it verbatim). */
  goal?: string;
  request?: string;
  /** The last error a command printed, until a test run passes or the same command runs clean. */
  error?: { line: string; command: string };
  /** Standing instructions the user gave, verbatim, oldest first. */
  rules: string[];
  slow: string[];
  test?: { command: string; result: string };
  /** `module`: a Python import that failed, which says the environment is wrong, not that a program is absent. */
  missing: { name: string; evidence: string; module?: boolean }[];
  changed: string[];
  todos: string[];
  /** The agent's last message: its own account of what it did and why, verbatim. */
  outcome?: string;
  /** The first command that failed, when a test run passed after it: the session hit a problem and got past it. */
  recovered?: { line: string; command: string };
  /** What the user typed this session, one line each, newest last: a lesson's quoted words are checked against it (memory/review.ts). Not kept on the card. */
  said?: string[];
}

/**
 * What the user asked, without what they pasted or attached; undefined for hook and command
 * echoes and for text that isn't mostly words (stray keystrokes).
 */
function requestText(text: string): string | undefined {
  const t = text.trim();
  if (!t || /^<(command-|local-command|system-reminder|task-notification)/.test(t)) return undefined;
  const own = t.replace(/<\\?pasted_content\b[^>]*>[\s\S]*?(<\\?\/pasted_content>|$)/g, " ").replace(/\[Image #\d+\]/g, " ").replace(/\s+/g, " ").trim();
  const letters = own.replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, "").length;
  // Mostly letters, and no key held down (a run of one character).
  return own.length >= 3 && letters / own.replace(/\s+/g, "").length >= 0.6 && !/(.)\1{5,}/.test(own) ? own : undefined;
}

/**
 * A sentence that tells the agent how to work ("Do not modify the existing tests", "make sure the
 * commit message is short"): it starts with the constraint, and it isn't a question.
 */
const INSTRUCTION = /^(?:(?:please|also|and|but|so|ok(?:ay)?|now|then|again|remember|note)[,:]?\s+)*(always|never|don'?t|do not|must|only|make sure|ensure|avoid|keep|no new|ask (?:me )?(?:first|before)|use|run|stop|leave|strip|remove|commit|push)\b/i;
const MAX_RULES = 12;
/**
 * The line that names an error: a Python exception (the traceback's last line), a failing test as
 * pytest, Django/unittest or a compiler reports it, or a thrown JavaScript error.
 */
const ERROR_LINE = /^(?:[\w.]+(?:Error|Exception)\b(?::.*)?|(?:FAILED|ERROR) [\w./:\[\]-]+.*|(?:FAIL|ERROR): \w+ \(.*|error\[\w+\]: .+|[^\s:]+:\d+(?::\d+)?: error: .+|(?:\S+:\s+)?error TS\d+: .+)$/;
/**
 * A test verdict with nothing failing. "failed" counts unless a count of zero comes before it:
 * cargo, Deno and Jest print "0 failed" on every passing run.
 */
export const PASSED = (verdict: string) => RAN.test(verdict) && !/\b[1-9]\d* (failed|errors?)\b|(?<!\b0 )\bfailed\b|\b(failures|errors)=\d|\bfail [1-9]|^FAIL\b|· FAIL\b/i.test(verdict);

function errorLine(out: string): string | undefined {
  const lines = out.split("\n").map((l) => l.trim());
  // Python prints the exception last; test runners list failures in a summary near the end.
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i]!)) return lines[i];
  return undefined;
}
const RULE_CHARS = 1600;
const OUTCOME_CHARS = 600;

function instructions(request: string): string[] {
  return request.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length >= 15 && x.length <= 300 && !x.endsWith("?") && INSTRUCTION.test(x));
}

/** What the user typed in this entry, or undefined when it isn't the user's message. */
function userText(o: any): string | undefined {
  const content = o.message?.content;
  // A message typed while the agent was working is recorded as a queued-command attachment.
  if (o.type === "attachment" && o.attachment?.type === "queued_command" && typeof o.attachment.prompt === "string") return o.attachment.prompt;
  if (o.type !== "user" || o.isMeta || o.isCompactSummary || o.isSidechain) return undefined;
  return typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
}

/** Claude Code facts from the whole session transcript, across compactions. */
export function sessionFacts(transcriptPath: string, projectDir: string): SessionFacts {
  const first = statSync(transcriptPath).size > TAIL_BYTES ? firstRequest(transcriptPath) : undefined;
  return factsFromClaudeRows(tail(transcriptPath).split("\n"), projectDir, first);
}

function factsFromClaudeRows(lines: Iterable<string>, projectDir: string, first?: string): SessionFacts {
  const rel = (p: string) => {
    if (!isAbsolute(p)) return p;
    const r = relative(projectDir, p);
    // Forward slashes on every platform: these paths are shown to the agent, not opened.
    return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : p;
  };
  const facts: SessionFacts = { rules: [], missing: [], slow: [], changed: [], todos: [] };
  let problem: SessionFacts["recovered"];
  const uses = new Map<string, any>();
  if (first) facts.goal = oneLine(first, 600);
  for (const line of lines) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const content = o.message?.content;
    const text = userText(o);
    if (text !== undefined) {
      // Issue text pasted in tags is the task's material, not the user's instructions.
      const request = requestText(text.replace(/<issue>[\s\S]*?(<\/issue>|$)/g, " "));
      if (request) {
        facts.goal ??= oneLine(request, 600);
        facts.request = oneLine(request, 400);
        facts.said = [...(facts.said ?? []), oneLine(request, 2000)].slice(-SAID);
        for (const r of instructions(request)) {
          const key = r.toLowerCase();
          facts.rules = [...facts.rules.filter((x) => x.toLowerCase() !== key), r];
        }
      }
    }
    if (!Array.isArray(content)) continue;
    if (o.type === "assistant") {
      const said = content.filter((b: any) => b.type === "text" && typeof b.text === "string").map((b: any) => b.text).join(" ").trim();
      if (said.length >= 20) facts.outcome = oneLine(said, OUTCOME_CHARS);
    }
    for (const b of content) {
      if (b.type === "tool_use") {
        uses.set(b.id, b);
        const file = b.input?.file_path ?? b.input?.notebook_path;
        if (EDITS.has(b.name) && typeof file === "string") {
          const p = rel(file);
          facts.changed = [p, ...facts.changed.filter((x) => x !== p)];
        }
        if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) facts.todos = b.input.todos.filter((t: any) => t?.status !== "completed").map((t: any) => oneLine(String(t.content ?? ""), 120));
        continue;
      }
      if (b.type !== "tool_result") continue;
      const use = uses.get(b.tool_use_id);
      if (use?.name !== "Bash") continue;
      const command = String(use.input?.command ?? "");
      const out = resultText(b.content);
      // Only test runs: a wait loop or a one-off probe that ran long says nothing about how to test here.
      const slowTest = SLOW.test(out) ? testCommand(command, projectDir) : undefined;
      if (slowTest) { const c = oneLine(slowTest, 160); facts.slow = [c, ...facts.slow.filter((x) => x !== c)].slice(0, 3); }
      let missing = false;
      for (const [re, name, module] of MISSING) {
        const m = out.match(re);
        if (!m) continue;
        const n = name(m);
        if (projectModule(n, projectDir)) continue;
        missing = true;
        // `pytest x` failing with "No module named pytest": the program the command runs is what's missing.
        const runs = module && new RegExp(`(?:^|[\\s;&|(])(?:-m\\s+)?${n.replace(/[.]/g, "\\.")}\\b`).test(command.replace(/"[^"]*"|'[^']*'/g, ""));
        facts.missing = [{ name: n, evidence: oneLine(m[0], 80), ...(module && !runs ? { module } : {}) }, ...facts.missing.filter((x) => x.name !== n)];
      }
      const runner = !missing && RAN.test(out) ? testCommand(command, projectDir) : undefined;
      let verdict = "";
      if (runner) {
        const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
        verdict = [...lines].reverse().find((l) => RAN.test(l)) ?? "";
        // tox and unittest end on a line without a count ("py312: OK", "OK"): keep the count line with it.
        const counted = [...lines].reverse().find((l) => COUNTED.test(l));
        if (verdict && counted && !COUNTED.test(verdict)) verdict = `${counted} · ${verdict}`;
        // node --test prints `ℹ pass N` then `ℹ fail N`; a failure count belongs in the verdict.
        const failed = out.match(/^\s*[#ℹ]?\s*fail\s+[1-9]\d*\s*$/m);
        if (failed && verdict && !verdict.includes(failed[0].trim())) verdict = `${verdict} · ${failed[0].trim()}`;
        if (verdict && !/FAIL/.test(verdict) && GO_FAIL.test(out)) verdict = `${verdict} · FAIL`;
        facts.test = { command: oneLine(runner, 200), result: oneLine(verdict, 120) };
      }
      // A file printed or searched may contain error text; only a command that ran can fail.
      const prints = NOT_RUNNER.has(command.trim().split(/\s+/)[0] ?? "");
      const err = missing || prints ? undefined : errorLine(out);
      const cmd = oneLine(command, 160);
      if (err && !(runner && PASSED(verdict))) facts.error = { line: oneLine(err, 200), command: cmd };
      else if ((runner && PASSED(verdict)) || facts.error?.command === cmd) facts.error = undefined;
      // A failure (an error line, a missing tool, a non-zero exit) before a passing test run.
      const passed = !!runner && PASSED(verdict);
      if (!passed && !prints && !problem && (err || missing || b.is_error === true)) problem = { line: oneLine(err ?? out.trim().split("\n").pop() ?? "", 200), command: cmd };
      if (passed && problem) facts.recovered = problem;
    }
  }
  // A tool the working test command uses is evidently available now.
  if (facts.test) facts.missing = facts.missing.filter((m) => !facts.test!.command.includes(m.name));
  const projectFirst = (list: string[]) => [...list.filter((p) => !isAbsolute(p)), ...list.filter((p) => isAbsolute(p))];
  facts.changed = projectFirst(facts.changed);
  facts.missing = facts.missing.slice(0, 5);
  // The most recent instructions, within a fixed share of the card.
  const kept: string[] = [];
  let chars = 0;
  for (const r of [...facts.rules].reverse()) {
    if (kept.length >= MAX_RULES || chars + r.length > RULE_CHARS) break;
    kept.unshift(r);
    chars += r.length;
  }
  facts.rules = kept;
  return facts;
}

/** Codex facts, by the same rules: its session file read as Claude rows (compact/codex.ts). */
export function codexSessionFacts(transcriptPath: string, projectDir: string): SessionFacts {
  return factsFromClaudeRows(codexRows(tail(transcriptPath).split(/\n/)), projectDir);
}
