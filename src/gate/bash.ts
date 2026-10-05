/**
 * Which files a Bash command printed into the transcript.
 *
 * An agent does not read files only through the Read tool. Claude Code's auto mode
 * actively encourages `cat`, `head`, `sed -n` and friends, so a session can pull a 44 KB
 * bundle into context and leave the ledger empty. This module is the ingress for that
 * path: it turns a command line into the files it read, so PostToolUse can classify them.
 *
 * It is deliberately conservative. A file we fail to recognise is an undercount, which is
 * the error this project can live with; a path we invent is a ledger row about a read that
 * never happened, which is the error it cannot. So every candidate must survive parsing,
 * the command must be one whose job is to print file contents, and the path must exist on
 * disk before a row is written.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Commands that put file contents on stdout, and therefore into the transcript. */
const READ_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "bat", "nl", "tac", "rev",
  "sed", "awk", "jq", "xxd", "od", "strings",
]);

/**
 * Commands whose first bare operand is a program, not a path: `sed -n '1,5p' file`,
 * `awk '{print}' file`, `jq '.deps' file`. Skipped unless the program came from a flag.
 */
const SCRIPT_FIRST = new Set(["sed", "awk", "jq"]);

/** Flags that consume the next token, per command. Everything else is a path candidate. */
const VALUE_FLAGS: Record<string, Set<string>> = {
  head: new Set(["-n", "-c", "--lines", "--bytes"]),
  tail: new Set(["-n", "-c", "--lines", "--bytes"]),
  sed: new Set(["-e", "-f", "--expression", "--file"]),
  awk: new Set(["-f", "-v", "--file", "--assign"]),
  jq: new Set(["-f", "--arg", "--argjson", "--slurpfile", "--rawfile", "--indent"]),
  od: new Set(["-N", "-j", "-A", "-t", "-w"]),
  xxd: new Set(["-l", "-s", "-c", "-g"]),
  strings: new Set(["-n", "--bytes"]),
  nl: new Set(["-w", "-s", "-v"]),
};

/** Flags that supply the script to a SCRIPT_FIRST command, so its first operand is a path. */
const SCRIPT_FLAGS = new Set(["-e", "-f", "--expression", "--file"]);

/**
 * A command can name many files (`cat a b c`), and a runaway loop could name hundreds.
 * The cap bounds the work a single hook does; the ledger is a measurement, not an audit.
 */
const MAX_TARGETS = 8;

/** Segment separators: each side of a pipe or list runs as its own command. */
const SEPARATORS = new Set(["|", "||", "&&", ";", "&", "\n"]);

/**
 * Absolute paths the command read, in order, deduped and capped.
 *
 * `cwd` is the directory the command ran in, which is the only thing that makes a relative
 * path meaningful.
 */
export function readTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const segment of splitSegments(tokenize(command))) {
    for (const p of segmentTargets(segment, cwd)) {
      if (!out.includes(p)) out.push(p);
      if (out.length >= MAX_TARGETS) return out;
    }
  }
  return out;
}

/**
 * Commands whose only job is to print a whole file. `head`, `tail`, `sed -n`, `awk`, `jq`
 * and `grep` are the targeted reads a gate should push an agent toward, so they are never
 * gated; only these are.
 */
const DUMP_COMMANDS = new Set(["cat", "less", "more", "bat", "nl", "tac", "rev"]);

/**
 * Files a Bash command would print whole into the transcript: a DUMP_COMMANDS segment whose
 * stdout is neither piped nor redirected. `cat lock | grep x` and `cat a > b` put only the
 * filtered output, or nothing, into context, so they are left alone. This is the input to
 * the blocking hook, so it errs toward returning nothing.
 */
export function dumpTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  let seg: string[] = [];
  const flush = (next: string | undefined) => {
    if (seg.length && next !== "|" && isDump(seg)) {
      for (const p of segmentTargets(seg, cwd)) if (!out.includes(p) && out.length < MAX_TARGETS) out.push(p);
    }
    seg = [];
  };
  const tokens = tokenize(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // `cat a &> b` tokenizes as `cat a`, `&`, `> b`: a redirect, not a background job.
    if (t === "&" && tokens[i + 1]?.startsWith(">")) { seg = []; continue; }
    if (SEPARATORS.has(t)) flush(t);
    else seg.push(t);
  }
  flush(undefined);
  return out;
}

function isDump(tokens: string[]): boolean {
  const i = commandIndex(tokens);
  const raw = tokens[i];
  if (raw === undefined || !DUMP_COMMANDS.has(raw.slice(raw.lastIndexOf("/") + 1))) return false;
  // Stdout redirected (`>`, `>>`, `1>`, `&>`, `>file`): nothing reaches the transcript.
  return !tokens.slice(i + 1).some((t) => /^(1|&)?>/.test(t));
}

/** Index of the command itself, past `FOO=bar sudo -n` and similar prefixes. */
function commandIndex(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || tokens[i] === "sudo" || tokens[i] === "command" || tokens[i] === "time")) i++;
  return i;
}

/**
 * Shell-ish tokenizer: quotes group, backslash escapes the next character, and operators
 * separate. It does not aim to be a shell — it aims to never mistake half a quoted path
 * for a whole one.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let had = false; // distinguishes an empty quoted token from no token at all

  const push = () => {
    if (cur !== "" || had) tokens.push(cur);
    cur = "";
    had = false;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      had = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|") {
      push();
      // Collapse the two-character forms so a segment split sees one operator.
      const next = command[i + 1];
      if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
        tokens.push(c + next);
        i++;
      } else {
        tokens.push(c === "\n" ? "\n" : c);
      }
      continue;
    }
    cur += c;
  }
  if (quote) return []; // unbalanced quotes: we cannot trust any token we produced
  push();
  return tokens;
}

function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (SEPARATORS.has(t)) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) segments.push(cur);
  return segments;
}

function segmentTargets(tokens: string[], cwd: string): string[] {
  // Strip what precedes the command itself: `FOO=bar sudo -n cat file`.
  let i = commandIndex(tokens);
  const raw = tokens[i];
  if (raw === undefined) return [];
  const cmd = raw.slice(raw.lastIndexOf("/") + 1); // /bin/cat and cat are the same command
  if (!READ_COMMANDS.has(cmd)) return [];

  const valueFlags = VALUE_FLAGS[cmd] ?? new Set<string>();
  const out: string[] = [];
  let scriptSeen = !SCRIPT_FIRST.has(cmd);
  let sawOperand = false;

  for (i++; i < tokens.length; i++) {
    const t = tokens[i]!;

    // Redirections. `< file` is a read like any other; `> file` names a file being
    // written, which must never be recorded as something that entered context.
    if (t === "<") {
      const target = tokens[++i];
      if (target) add(target);
      continue;
    }
    if (t === ">" || t === ">>" || /^\d?>>?$/.test(t)) {
      i++;
      continue;
    }
    if (t.startsWith(">") || t.startsWith("<")) continue;

    if (t === "--") continue;
    if (t.startsWith("-") && t !== "-") {
      const flag = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (SCRIPT_FLAGS.has(flag)) scriptSeen = true;
      // `-n5` and `--lines=5` carry their value; only the detached form eats a token.
      if (valueFlags.has(flag) && !t.includes("=") && flag === t) i++;
      continue;
    }

    if (!scriptSeen && !sawOperand) {
      // The program text for sed/awk/jq, e.g. `sed -n '1,5p'`.
      sawOperand = true;
      continue;
    }
    sawOperand = true;
    add(t);
  }
  return out;

  function add(token: string): void {
    // Unexpanded globs, substitutions and process substitutions name no single file we can
    // resolve, and guessing at one would fabricate a read.
    if (/[*?[\]$`~]/.test(token) || token.includes("(")) return;
    const abs = isAbsolute(token) ? resolve(token) : resolve(join(cwd, token));
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return;
    } catch {
      return; // a path we cannot stat is a path we will not claim was read
    }
    if (!out.includes(abs)) out.push(abs);
  }
}
