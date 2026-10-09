/**
 * Project memory restored after compaction. Measured failure (long-session benchmark, 2026-10-09):
 * after a compaction the agent forgot how the project's tests run, installed and ran another test
 * runner, and waited past the time limit. Claude Code's summary is a paraphrase; this restores a
 * few exact facts instead, right after compaction (SessionStart with source "compact"), with no
 * model and no search:
 *
 * - session facts, taken by fixed rules from the whole session transcript (compactions included):
 *   the test command that ran, tools the environment lacks, commands that ran too long for the
 *   tool's time limit (the sympy failure: whole suites, then a 30-minute wait), files changed, the
 *   current request and open to-dos;
 * - pins the user wrote in `.snout/pins.md`, verbatim; a pin marked `[re-read N]` brings the first N
 *   lines of its file from disk, so the content is current, not the pre-compaction copy.
 *
 * The block is capped (MAX_CHARS) so it stays constant as sessions grow.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { matchesAny } from "../util/glob.js";

const TAIL_BYTES = 16 * 1024 * 1024;
export const MAX_CHARS = 4000; // ~1k tokens
const TEST = /\b(pytest|runtests\.py|bin\/test|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm test|yarn test|node --test|rspec|phpunit|tox|unittest)\b/;
/** A test run that actually ran: the runner printed a count or a verdict. */
const RAN = /\b\d+ (passed|failed|errors?|skipped)\b|\bRan \d+ tests?\b|tests finished|^OK\b|\bOK \(|^FAILED\b|\bTests?:\s+\d+/m;
/** The environment lacks a tool or module. */
const MISSING: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/No module named ['"]?([\w.]+)['"]?/, (m) => m[1]!],
  [/(?:^|\s)([\w.-]+): command not found/m, (m) => m[1]!],
  [/command not found: ([\w.-]+)/, (m) => m[1]!],
];
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

const resultText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? "").join("\n") : "";

/** Claude Code's note when a command outlives the Bash tool's limit and moves to the background. */
const SLOW = /did not complete within its \d+s timeout|moved to the background/;

export interface SessionFacts {
  request?: string;
  slow: string[];
  test?: { command: string; result: string };
  missing: { name: string; evidence: string }[];
  changed: string[];
  todos: string[];
}

/** Facts from the whole session transcript, across compactions. */
export function sessionFacts(transcriptPath: string, projectDir: string): SessionFacts {
  const rel = (p: string) => {
    if (!isAbsolute(p)) return p;
    const r = relative(projectDir, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
  };
  const facts: SessionFacts = { missing: [], slow: [], changed: [], todos: [] };
  const uses = new Map<string, any>();
  for (const line of tail(transcriptPath).split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const content = o.message?.content;
    if (o.type === "user" && !o.isMeta && !o.isCompactSummary) {
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
      if (text.trim() && !/^<(command-|local-command|system-reminder)/.test(text.trim())) facts.request = oneLine(text, 400);
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
      if (SLOW.test(out)) { const c = oneLine(command, 160); facts.slow = [c, ...facts.slow.filter((x) => x !== c)].slice(0, 3); }
      let missing = false;
      for (const [re, name] of MISSING) {
        const m = out.match(re);
        if (!m) continue;
        missing = true;
        const n = name(m);
        facts.missing = [{ name: n, evidence: oneLine(m[0], 80) }, ...facts.missing.filter((x) => x.name !== n)];
      }
      if (!missing && TEST.test(command) && RAN.test(out)) {
        const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
        const verdict = [...lines].reverse().find((l) => RAN.test(l)) ?? "";
        facts.test = { command: oneLine(command, 200), result: oneLine(verdict, 120) };
      }
    }
  }
  // A tool the working test command uses is evidently available now.
  if (facts.test) facts.missing = facts.missing.filter((m) => !facts.test!.command.includes(m.name));
  const projectFirst = (list: string[]) => [...list.filter((p) => !isAbsolute(p)), ...list.filter((p) => isAbsolute(p))];
  facts.changed = projectFirst(facts.changed);
  facts.missing = facts.missing.slice(0, 5);
  return facts;
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

/** The text added to the context right after a compaction, or "" when there is nothing to restore. */
export function memoryText(facts: SessionFacts, pins: Pin[], projectDir: string, secrets?: Secrets): string {
  const sections: string[][] = [];
  if (pins.length) sections.push(["Pinned for this project:", ...pinLines(pins, projectDir, secrets)]);
  const f: string[] = [];
  if (facts.test) f.push(`- Tests run here with: \`${facts.test.command}\`${facts.test.result ? ` (last result: ${facts.test.result})` : ""}`);
  for (const m of facts.missing) f.push(`- Not available here: ${m.name} (${m.evidence})`);
  for (const c of facts.slow) f.push(`- Ran past the 2-minute tool limit here (prefer narrower tests): \`${c}\``);
  if (facts.request) f.push(`- Current request: ${facts.request}`);
  if (facts.changed.length) f.push(`- Files changed this session: ${facts.changed.slice(0, 12).join(", ")}`);
  if (facts.todos.length) f.push(`- Open to-dos: ${facts.todos.slice(0, 6).join("; ")}`);
  if (f.length) sections.push(["From this session:", ...f]);
  if (!sections.length) return "";
  let text = ["Snout restored these exact facts after compaction (from this session and .snout/pins.md):", ...sections.flat()].join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`;
  return text;
}
