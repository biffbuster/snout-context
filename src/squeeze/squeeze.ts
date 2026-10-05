/**
 * Squeeze: slims the output of noisy commands that succeeded before the agent reads it.
 *
 * A passing test run prints a line per test, an install prints progress and deprecation
 * notices, a build prints the same warning forty times. The agent needs the summary and
 * anything that looks like a problem. Squeeze keeps those, drops the rest, and says so in a
 * footer that names where the full output was saved.
 *
 * Only successful commands reach here: Claude Code can replace a tool's output after it ran
 * (PostToolUse `updatedToolOutput`) but not a failed command's, and a failure's details are
 * what the agent most needs anyway. The command itself is never changed, so permission rules
 * apply exactly as the user wrote them.
 */
export type SqueezeKind = "test" | "install" | "build" | "search";

/** Rules for deciding what a command is. The `if` filters on the hook mirror these. */
const KINDS: [SqueezeKind, RegExp][] = [
  ["test", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(jest|vitest|mocha|playwright\s+test)\b|(jest|vitest|mocha|pytest|rspec|phpunit)\b|python3?\s+-m\s+pytest\b|go\s+test\b|cargo\s+test\b|node\s+--test\b|deno\s+test\b)/],
  ["install", /(^|[\s;&|(])((npm|pnpm)\s+(i|install|ci|add)\b|yarn(\s+(install|add))?\s*($|[;&|])|bun\s+(i|install|add)\b|pip3?\s+install\b|poetry\s+install\b|bundle(\s+install)?\s*($|[;&|])|go\s+mod\s+(download|tidy)\b|cargo\s+fetch\b|brew\s+install\b)/],
  ["build", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?build\b|npx\s+(tsc|vite|next|webpack)\b|\btsc\b|vite\s+build\b|next\s+build\b|webpack\b|cargo\s+build\b|go\s+build\b|make\b|mvn\b|\.?\/?gradlew?\b|docker\s+build\b)/],
  // Searches that walk a tree: recursive grep, ripgrep and friends, git grep, find, ls -R.
  ["search", /(^|[\s;&|(])(grep\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]|rg\s|ag\s|ack\s|git\s+grep\b|find\s+(\.|\/|~|\S+\s+-)|ls\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*R)/],
];

export function kindOf(command: string): SqueezeKind | null {
  for (const [k, re] of KINDS) if (re.test(command)) return k;
  return null;
}

/** Below this many bytes (~1.5k tokens) output is left alone: the saving isn't worth a footer. */
const MIN_BYTES = 4000;
/**
 * Above Claude Code's own limit it saves the output to a file and shows a preview, judged on
 * the ORIGINAL size, so a replacement only lands in that preview and the agent opens the full
 * file anyway (measured: more turns, higher cost). Squeeze stays out of that range entirely.
 * BASH_MAX_OUTPUT_LENGTH is Claude Code's setting for it; 30,000 characters is its default.
 */
export const agentOutputLimit = (): number => Number(process.env.BASH_MAX_OUTPUT_LENGTH) || 30_000;
/** And only if squeezing removes at least this share. */
const MIN_CUT = 0.3;
const KEEP_HEAD = 5;
const KEEP_TAIL = 15;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
/** Anything that reads as trouble is always kept, whatever the kind. */
const TROUBLE = /\b(error|errors|err!|fail(ed|ure|ing)?|fatal|panic|exception|traceback|warn(ing)?s?|deprecated|vulnerab|critical|denied|cannot|can't|unable|not found|missing|undefined|timeout|timed out|segmentation)\b|✗|✕|×|❌|⚠|^\s*\(!\)/i;
/** Passing-test lines: the bulk of a green run. */
const PASSING = /^\s*(✓|✔|√|ok\s+\d+\b|PASS\b|\.{3,}$|test\s+\S+.*\.\.\.\s+ok$|--- PASS:|=== RUN\b|RUN\s|\[\s*PASSED\s*\]|\s*passed\s*$)/;
/** Summary lines worth keeping from any run. */
const SUMMARY = /\b(tests?:|suites?:|passed|passing|failed|failing|skipped|pending|todo|duration|time:|elapsed|total|ran \d+|\d+ (tests?|specs?|examples?)|added \d+ packages?|removed \d+|changed \d+|audited \d+|up to date|found \d+ vulnerabilit|built in|compiled|done in|successfully|finished)\b|^#\s*(tests|pass|fail|suites|duration)/i;
/** Progress and chatter: spinners, fetch lines, percentages. */
const NOISE = /^\s*([|/\\\-]\s*$|\d{1,3}%|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Downloading\b|Fetching\b|Resolving\b|Collecting\b|Using cached\b|Requirement already satisfied\b|Compiling \S+ v?\d|Checking \S+ v?\d|npm (http|timing|sill|verb)\b|#\d+ \[)/i;

export interface Squeezed {
  kind: SqueezeKind;
  text: string;
  beforeLines: number;
  afterLines: number;
  beforeBytes: number;
  afterBytes: number;
}

/** Cleans terminal artifacts: colour codes, carriage-return progress, trailing space. */
function clean(text: string): string[] {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((l) => (l.includes("\r") ? l.slice(l.lastIndexOf("\r") + 1) : l).replace(/\s+$/, ""));
}

/**
 * The squeezed text, or null when the output is small or squeezing wouldn't cut enough.
 * `savedTo` is the path the full output was written to, named in the footer.
 */
export function squeeze(kind: SqueezeKind, output: string, savedTo: string): Squeezed | null {
  if (Buffer.byteLength(output) < MIN_BYTES || output.length > agentOutputLimit()) return null;
  if (kind === "search") return squeezeSearch(output, savedTo);
  const lines = clean(output);
  const n = lines.length;
  const keep = new Array<boolean>(n).fill(false);
  for (let i = 0; i < Math.min(KEEP_HEAD, n); i++) keep[i] = true;
  for (let i = Math.max(0, n - KEEP_TAIL); i < n; i++) keep[i] = true;
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    if (TROUBLE.test(l)) {
      keep[i] = true;
      // A problem's next few lines are usually its location or detail.
      for (let j = i + 1; j < Math.min(n, i + 4); j++) if (lines[j]!.trim() && !PASSING.test(lines[j]!)) keep[j] = true;
      continue;
    }
    if (SUMMARY.test(l)) keep[i] = true;
    else if (kind === "test" && PASSING.test(l)) keep[i] = false;
    else if (NOISE.test(l)) keep[i] = false;
  }

  // Kept lines, with runs of drops shown as a count and repeats collapsed.
  const out: string[] = [];
  let dropped = 0;
  let last = "";
  let repeats = 0;
  const flushRepeats = () => {
    if (repeats > 0) out.push(`  (same line ${repeats} more time${repeats === 1 ? "" : "s"})`);
    repeats = 0;
  };
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    if (!keep[i] || (!l.trim() && (out.length === 0 || !out[out.length - 1]!.trim()))) {
      if (l.trim()) dropped += 1;
      continue;
    }
    if (dropped > 0) {
      flushRepeats();
      out.push(`  … ${dropped} line${dropped === 1 ? "" : "s"} omitted`);
      dropped = 0;
      last = "";
    }
    if (l === last && l.trim()) {
      repeats += 1;
      continue;
    }
    flushRepeats();
    out.push(l);
    last = l;
  }
  flushRepeats();
  if (dropped > 0) out.push(`  … ${dropped} line${dropped === 1 ? "" : "s"} omitted`);

  const body = out.join("\n");
  const text = `${body}\n\n[Snout squeezed this ${kind} output: ${out.length} of ${n} lines kept, problems and summary included. Full output: ${savedTo}]`;
  const beforeBytes = Buffer.byteLength(output);
  const afterBytes = Buffer.byteLength(text);
  if (afterBytes > beforeBytes * (1 - MIN_CUT)) return null;
  return { kind, text, beforeLines: n, afterLines: out.length, beforeBytes, afterBytes };
}

/** Search results: matches kept per file, files listed before collapsing the rest. */
const MATCHES_PER_FILE = 3;
const FILES_LISTED = 40;
const LIST_LINES = 60;
/** "path:line:text" or "path:text", the shape grep -rn, rg and git grep print. */
const MATCH_LINE = /^([^\s:][^:]{0,300}?):(\d+[:-])?(.*)$/;

/**
 * Grouped search results. Matches: each file keeps its first few hits and a count of the rest,
 * and past FILES_LISTED files the remainder is summarised by count. Plain path lists (find,
 * ls -R): the first lines, then a count per top-level directory.
 */
function squeezeSearch(output: string, savedTo: string): Squeezed | null {
  const lines = clean(output).filter((l) => l.trim());
  const n = lines.length;
  const matched = lines.map((l) => MATCH_LINE.exec(l));
  const matchShare = matched.filter(Boolean).length / Math.max(n, 1);
  const out: string[] = [];
  let summary: string;

  if (matchShare >= 0.6) {
    const files = new Map<string, string[]>();
    lines.forEach((l, i) => {
      const file = matched[i]?.[1] ?? "(other)";
      const list = files.get(file);
      if (list) list.push(l); else files.set(file, [l]);
    });
    let shown = 0;
    let hiddenFiles = 0, hiddenMatches = 0;
    for (const [file, hits] of files) {
      if (shown >= FILES_LISTED) { hiddenFiles++; hiddenMatches += hits.length; continue; }
      shown++;
      out.push(...hits.slice(0, MATCHES_PER_FILE));
      if (hits.length > MATCHES_PER_FILE) out.push(`  (+${hits.length - MATCHES_PER_FILE} more in ${file})`);
    }
    if (hiddenFiles) out.push(`  … ${hiddenFiles} more file${hiddenFiles === 1 ? "" : "s"} with ${hiddenMatches} match${hiddenMatches === 1 ? "" : "es"}`);
    summary = `${n} matches in ${files.size} files; first ${MATCHES_PER_FILE} per file shown`;
  } else {
    out.push(...lines.slice(0, LIST_LINES));
    const rest = lines.slice(LIST_LINES);
    if (rest.length) {
      const dirs = new Map<string, number>();
      for (const l of rest) {
        const parts = l.replace(/^\.\//, "").split("/");
        const top = parts.length > 2 ? parts.slice(0, 2).join("/") + "/" : parts.length === 2 ? parts[0] + "/" : "(top level)";
        dirs.set(top, (dirs.get(top) ?? 0) + 1);
      }
      out.push(`  … ${rest.length} more:`);
      for (const [d, c] of [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`    ${d}  ${c}`);
      if (dirs.size > 15) out.push(`    and ${dirs.size - 15} more directories`);
    }
    summary = `${n} lines; first ${Math.min(n, LIST_LINES)} shown, the rest counted by directory`;
  }

  const text = `${out.join("\n")}\n\n[Snout grouped this search output: ${summary}. Narrow the search, or open the full output: ${savedTo}]`;
  const beforeBytes = Buffer.byteLength(output);
  const afterBytes = Buffer.byteLength(text);
  if (afterBytes > beforeBytes * (1 - MIN_CUT)) return null;
  return { kind: "search", text, beforeLines: n, afterLines: out.length, beforeBytes, afterBytes };
}

/**
 * The `if` filters the hook is installed with, one per command family, so any other command
 * never starts Snout. Kept deliberately broad; `kindOf` decides precisely.
 */
export const SQUEEZE_IFS = [
  "npm *", "pnpm *", "yarn *", "bun *", "npx *", "node --test *",
  "pytest *", "python -m pytest *", "python3 -m pytest *", "pip install *", "pip3 install *", "poetry install *",
  "go *", "cargo *", "make *", "tsc *", "mvn *", "gradle *", "./gradlew *", "docker build *",
  "bundle *", "rspec *", "jest *", "vitest *", "deno test *", "brew install *",
  "grep *", "rg *", "ag *", "ack *", "git grep *", "find *", "ls -R*",
];
