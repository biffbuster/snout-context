/**
 * Project memory restored after compaction. Measured failure (long-session benchmark, 2026-10-09):
 * after a compaction the agent forgot how the project's tests run, installed and ran another test
 * runner, and waited past the time limit. Claude Code's summary is a paraphrase; this restores a
 * few exact facts instead, right after compaction (SessionStart with source "compact"), with no
 * model and no search. Codex fires the same hook; its session file is read through compact/codex.ts.
 *
 * - session facts, taken by fixed rules from the whole session transcript (compactions included):
 *   the test command that ran, tools the environment lacks, commands that ran too long for the
 *   tool's time limit (the sympy failure: whole suites, then a 30-minute wait), files changed, the
 *   session's first request and the current one, the last error not yet followed by a passing run,
 *   and open to-dos;
 * - pins the user wrote in `.snout/pins.md`, verbatim; a pin marked `[re-read N]` brings the first N
 *   lines of its file from disk, so the content is current, not the pre-compaction copy.
 *
 * The block is capped (MAX_CHARS) so it stays constant as sessions grow. What would change the agent's
 * next answer comes first and is never what the cap cuts: the user's instructions (a later one holds
 * where two conflict), the agent's own notes, pins, then the facts; the list of changed files takes
 * whatever room is left, most recent first.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchesAny } from "../util/glob.js";
import { codexRows } from "./codex.js";

const TAIL_BYTES = 16 * 1024 * 1024;
const HEAD_BYTES = 2 * 1024 * 1024;
export const MAX_CHARS = 6000; // ~1.5k tokens
const TEST = /\b(pytest|runtests\.py|bin\/test|jest|vitest|mocha|go test|cargo test|(?:npm|pnpm|yarn)(?:\.cmd)? (?:run )?test|node --test|rspec|phpunit|tox|unittest)\b/;
/** A test run that actually ran: the runner printed a count or a verdict. */
const RAN = /\b\d+ (passed|failed|errors?|skipped)\b|\bRan \d+ tests?\b|tests finished|^OK\b|\bOK \(|^FAILED\b|\bTests?:\s+\d+|^[#ℹ]?\s*pass\s+\d+\s*$/m;
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
      const abs = isAbsolute(cd) ? cd : resolve(projectDir, cd);
      const r = relative(projectDir, abs).split(sep).join("/");
      if (r) run = `cd ${r.startsWith("..") ? cd : r} && ${run}`;
    }
    runs.push(run);
  }
  return runs.length ? runs.join(" && ") : undefined;
}

/** The environment lacks a tool or module. */
const MISSING: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/No module named ['"]?([\w.]+)['"]?/, (m) => m[1]!],
  [/(?:^|\s)([\w.-]+): command not found/m, (m) => m[1]!],
  [/command not found: ([\w.-]+)/, (m) => m[1]!],
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
  missing: { name: string; evidence: string }[];
  changed: string[];
  todos: string[];
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
/** A test verdict with nothing failing. */
const PASSED = (verdict: string) => RAN.test(verdict) && !/\b[1-9]\d* (failed|errors?)\b|FAILED|\b(failures|errors)=\d|\bfail [1-9]/i.test(verdict);

function errorLine(out: string): string | undefined {
  const lines = out.split("\n").map((l) => l.trim());
  // Python prints the exception last; test runners list failures in a summary near the end.
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i]!)) return lines[i];
  return undefined;
}
const RULE_CHARS = 1600;

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
        for (const r of instructions(request)) {
          const key = r.toLowerCase();
          facts.rules = [...facts.rules.filter((x) => x.toLowerCase() !== key), r];
        }
      }
    }
    if (!Array.isArray(content)) continue;
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
      for (const [re, name] of MISSING) {
        const m = out.match(re);
        if (!m) continue;
        const n = name(m);
        if (projectModule(n, projectDir)) continue;
        missing = true;
        facts.missing = [{ name: n, evidence: oneLine(m[0], 80) }, ...facts.missing.filter((x) => x.name !== n)];
      }
      const runner = !missing && RAN.test(out) ? testCommand(command, projectDir) : undefined;
      let verdict = "";
      if (runner) {
        const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
        verdict = [...lines].reverse().find((l) => RAN.test(l)) ?? "";
        // node --test prints `ℹ pass N` then `ℹ fail N`; a failure count belongs in the verdict.
        const failed = out.match(/^\s*[#ℹ]?\s*fail\s+[1-9]\d*\s*$/m);
        if (failed && verdict && !verdict.includes(failed[0].trim())) verdict = `${verdict} · ${failed[0].trim()}`;
        facts.test = { command: oneLine(runner, 200), result: oneLine(verdict, 120) };
      }
      // A file printed or searched may contain error text; only a command that ran can fail.
      const prints = NOT_RUNNER.has(command.trim().split(/\s+/)[0] ?? "");
      const err = missing || prints ? undefined : errorLine(out);
      const cmd = oneLine(command, 160);
      if (err && !(runner && PASSED(verdict))) facts.error = { line: oneLine(err, 200), command: cmd };
      else if ((runner && PASSED(verdict)) || facts.error?.command === cmd) facts.error = undefined;
    }
  }
  // A tool the working test command uses is evidently available now.
  if (facts.test) facts.missing = facts.missing.filter((m) => !facts.test!.command.includes(m.name));
  const projectFirst = (list: string[]) => [...list.filter((p) => !isAbsolute(p)), ...list.filter((p) => isAbsolute(p))];
  facts.changed = projectFirst(facts.changed);
  facts.missing = facts.missing.slice(0, 5);
  // The most recent instructions, within a fixed share of the restore.
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

export interface Pin { text: string; path?: string; reread?: number }

/**
 * `.snout/pins.md`: one pin per `- ` line. A pin that starts with a path (in backticks or bare) is a
 * file pointer; `[re-read N]` anywhere in it brings the file's first N lines (max 40) from disk.
 * Anything else is a fact, kept verbatim.
 */
export function readPins(projectDir: string, snoutDir: string): Pin[] {
  const file = join(snoutDir, "pins.md");
  if (!existsSync(file)) return [];
  const pins: Pin[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const m = raw.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!m) continue;
    const text = m[1]!;
    const reread = Number(text.match(/\[re-?read (\d+)\]/i)?.[1] ?? 0) || undefined;
    const first = text.match(/^`([^`]+)`|^(\S+)/);
    const candidate = first?.[1] ?? first?.[2] ?? "";
    // A backticked first word is a path by intent; a bare one needs a slash, a dotfile or an extension.
    const looksLikePath = !/^https?:/.test(candidate) && (first?.[1] !== undefined || /[/\\]|^\.\w|\.\w{1,10}$/.test(candidate));
    pins.push(looksLikePath ? { text, path: candidate, reread: reread ? Math.min(reread, 40) : undefined } : { text });
    if (pins.length >= 10) break;
  }
  return pins;
}

/** Credential-file patterns (Snout's `redact` / `redactExempt` config): pinned files never inlined. */
export interface Secrets { redact: readonly string[]; redactExempt: readonly string[] }

function pinLines(pins: Pin[], projectDir: string, secrets?: Secrets): string[] {
  const out: string[] = [];
  for (const p of pins) {
    out.push(`- ${p.text.replace(/\s*\[re-?read \d+\]/i, "")}`);
    if (!p.path || !p.reread) continue;
    const abs = isAbsolute(p.path) ? p.path : resolve(projectDir, p.path);
    if (!existsSync(abs)) { out.push(`  (not on disk now: ${p.path})`); continue; }
    const rel = relative(projectDir, abs);
    const asPattern = rel && !rel.startsWith("..") ? rel : abs.replace(/^\/+/, "");
    if (secrets && matchesAny(asPattern, secrets.redact) && !matchesAny(asPattern, secrets.redactExempt)) { out.push("  (contents not restored: the file matches a credential pattern)"); continue; }
    try {
      const lines = readFileSync(abs, "utf8").split("\n").slice(0, p.reread);
      out.push("  ```", ...lines.map((l) => `  ${l.slice(0, 200)}`), "  ```");
    } catch {
      out.push(`  (could not read ${p.path})`);
    }
  }
  return out;
}

/**
 * The agent's own working notes. Facts from the transcript can't carry its reasoning (the approach it
 * chose, what failed and why), so after a compaction the agent is asked to keep a few lines in
 * `.snout/progress.md`, and the next compaction restores them verbatim. Notes older than this
 * session (`sinceMs`, the transcript's creation) belong to other work and are not restored.
 */
export const PROGRESS_FILE = "progress.md";
const PROGRESS_MAX_CHARS = 1500;
/** The ask names where the notes go: `.snout/progress.md`, or the file under SNOUT_DIR when Snout keeps its records elsewhere. */
const progressAsk = (file: string) => `- Keep \`${file}\` current while you work, at most 10 lines: the goal, your current approach, what failed and why, the next step. Snout restores it verbatim after the next compaction.`;

/** When the session began: the first timestamp in its transcript (file times differ by platform). */
export function sessionStartMs(transcriptPath: string): number {
  try {
    const fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(64 * 1024);
    let n = 0;
    try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
    const t = Date.parse(buf.toString("utf8", 0, n).match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
    return Number.isFinite(t) ? t : statSync(transcriptPath).birthtimeMs || 0;
  } catch {
    return 0;
  }
}

export function readProgress(snoutDir: string, sinceMs: number): string | undefined {
  const file = join(snoutDir, PROGRESS_FILE);
  try {
    if (statSync(file).mtimeMs < sinceMs) return undefined;
    const text = readFileSync(file, "utf8").trim();
    return text ? (text.length > PROGRESS_MAX_CHARS ? `${text.slice(0, PROGRESS_MAX_CHARS - 1)}…` : text) : undefined;
  } catch {
    return undefined;
  }
}

/** The text added to the context right after a compaction, or "" when there is nothing to restore. */
export function memoryText(facts: SessionFacts, pins: Pin[], projectDir: string, secrets?: Secrets, progress?: string, progressFile = ".snout/progress.md"): string {
  const ask = progressAsk(progressFile);
  const sections: string[][] = [];
  if (progress) sections.push(["Your progress notes (.snout/progress.md, written before the compaction):", ...progress.split("\n").slice(0, 25)]);
  // Before the facts, so the cap never cuts them: they are the user's own words about how to work.
  if (facts.rules?.length) sections.push(["Your instructions this session, verbatim (oldest first; where two conflict, the later one holds):", ...facts.rules.map((r) => `- ${r}`)]);
  if (pins.length) sections.push(["Pinned for this project:", ...pinLines(pins, projectDir, secrets)]);
  const f: string[] = [];
  if (facts.test) f.push(`- Tests run here with: \`${facts.test.command}\`${facts.test.result ? ` (last result: ${facts.test.result})` : ""}`);
  for (const m of facts.missing) f.push(`- Not available here: ${m.name} (${m.evidence})`);
  for (const c of facts.slow) f.push(`- Ran past the 2-minute tool limit here (prefer narrower tests): \`${c}\``);
  if (facts.error) f.push(`- Last error, not yet followed by a passing run: ${facts.error.line} (from \`${facts.error.command}\`)`);
  if (facts.goal && facts.goal !== facts.request) f.push(`- First request this session: ${facts.goal}`);
  if (facts.request) f.push(`- Current request: ${facts.request}`);
  if (facts.todos.length) f.push(`- Open to-dos: ${facts.todos.slice(0, 6).join("; ")}`);
  const head = "Snout restored these exact facts after compaction (from this session and .snout/pins.md):";
  // The ask is always whole: it is what keeps the next restore useful.
  const room = MAX_CHARS - head.length - ask.length - 2;
  const render = () => [...sections, ...(f.length ? [["From this session:", ...f]] : [])].flat().join("\n");
  // Changed files last, as many as fit (most recent first): a long session edits more than the rest leaves room for.
  if (facts.changed.length) {
    const label = "- Files changed this session: ";
    let left = room - render().length - 1 - label.length - (f.length ? 0 : "From this session:\n".length);
    const listed: string[] = [];
    for (const p of facts.changed) {
      const cost = p.length + (listed.length ? 2 : 0);
      if (cost > left) break;
      listed.push(p);
      left -= cost;
    }
    if (listed.length) f.push(`${label}${listed.join(", ")}${listed.length < facts.changed.length ? ` (and ${facts.changed.length - listed.length} more)` : ""}`);
  }
  let body = render();
  if (!body) return "";
  if (body.length > room) body = `${body.slice(0, room - 1)}…`;
  return [head, body, ask].join("\n");
}
