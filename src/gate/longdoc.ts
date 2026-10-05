/**
 * Section reads for long documents and logs. Agents open markdown docs, changelogs, design
 * notes, plans and logs whole, and the whole text then rides along on every later turn. Most
 * of the time they need one section (or, in a log, the end).
 *
 * A whole-file Read of a long doc returns its opening plus a map of its headings with line
 * numbers, so the agent goes straight to the section it needs with offset and limit. A long
 * log returns its last lines plus the line numbers where errors appear. Any explicit ranged
 * read goes through untouched, so the full text is always one read away.
 *
 * Instruction files (CLAUDE.md, AGENTS.md, skills, rules, commands) are never cut: the agent
 * has to follow all of them.
 *
 * As in outline.ts, the file is untrusted and the note is model-visible, so heading text is
 * reduced to a strict character set and capped; log lines contribute numbers only.
 *
 * Pure: no Node imports.
 */

/** Below this a doc costs less than the turn a section read might add. ~8k tokens. */
export const LONG_DOC_BYTES = 32 * 1024;
const HEAD_LINES = 60;
const HEAD_BYTES = 6 * 1024;
const TAIL_LINES = 120;
const TAIL_BYTES = 8 * 1024;
const MAX_HEADINGS = 60;
const MAX_ERROR_LINES = 30;

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt|org)$/i;
const LOG_EXT = /\.(log|out|err)$/i;
const LOG_DIR = /(^|\/)(logs?|tmp\/logs?)\//i;

/** Files the agent must follow in full: instructions, skills, rules, commands, memory. */
const INSTRUCTION_NAMES = /^(claude|agents|gemini|copilot-instructions|readme|contributing|security|skill|memory)(\.[a-z]+)*$/i;
const INSTRUCTION_DIRS = /(^|\/)(\.claude|\.cursor|\.gemini|\.codex|\.github\/instructions|\.windsurf|\.clinerules)\//i;

export type DocKind = "doc" | "log";

export function docKindOf(rel: string): DocKind | null {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (INSTRUCTION_DIRS.test(rel) || INSTRUCTION_NAMES.test(base) || base === ".cursorrules") return null;
  if (LOG_EXT.test(base) || (LOG_DIR.test(rel) && /\.(txt|json|jsonl)$/i.test(base))) return "log";
  if (DOC_EXT.test(base)) return "doc";
  return null;
}

export interface DocWindow {
  kind: DocKind;
  start: number;
  lines: number;
  bytes: number;
  totalLines: number;
  /** The model-visible map: headings for a doc, error line numbers for a log. */
  map: string;
}

const byteLen = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
  }
  return n;
};

/** Heading text, reduced to characters that cannot carry markup or instructions' punctuation. */
function cleanHeading(raw: string): string {
  return raw.replace(/[`*_~[\]<>{}]/g, "").replace(/[^\p{L}\p{N} .,:;()'/&+#-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * The window to return for a whole-file read of a long doc or log, or null when the file is
 * not one, is short enough to read whole, or has nothing useful to map.
 */
export function docWindow(rel: string, text: string, totalBytes: number): DocWindow | null {
  const kind = docKindOf(rel);
  if (!kind || totalBytes < LONG_DOC_BYTES) return null;
  const all = text.split("\n");
  if (all.length < HEAD_LINES * 2) return null; // a few giant lines: nothing to page through
  return kind === "doc" ? docHead(all) : logTail(all);
}

function docHead(all: string[]): DocWindow | null {
  let bytes = 0, lines = 0;
  for (const line of all.slice(0, HEAD_LINES)) {
    const b = byteLen(line) + 1;
    if (bytes + b > HEAD_BYTES) break;
    bytes += b;
    lines++;
  }
  const items: string[] = [];
  let total = 0, fence = false;
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    // ATX ("## Setup") on this line, or setext (a title underlined with === or ---) on the line above.
    const atx = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    const setext = !atx && i > 0 && /^(=+|-{3,})\s*$/.test(line) && /\S/.test(all[i - 1]!) && !/^\s*[-*+>|]/.test(all[i - 1]!);
    if (!atx && !setext) continue;
    const level = atx ? atx[1]!.length : line[0] === "=" ? 1 : 2;
    const text = cleanHeading(atx ? atx[2]! : all[i - 1]!);
    if (!text) continue;
    total++;
    if (items.length < MAX_HEADINGS) items.push(`${"#".repeat(level)} ${text} L${atx ? i + 1 : i}`);
  }
  if (lines < 5 || items.length < 2) return null;
  const more = total > items.length ? ` (+${total - items.length} more)` : "";
  return { kind: "doc", start: 1, lines, bytes, totalLines: all.length, map: ` Its sections, with line numbers: ${items.join(" · ")}${more}.` };
}

function logTail(all: string[]): DocWindow | null {
  // A trailing newline leaves an empty last element; it is not a line.
  const n = all.length - (all[all.length - 1] === "" ? 1 : 0);
  let bytes = 0, lines = 0;
  for (let i = n - 1; i >= 0 && lines < TAIL_LINES; i--) {
    const b = byteLen(all[i]!) + 1;
    if (bytes + b > TAIL_BYTES) break;
    bytes += b;
    lines++;
  }
  if (lines < 5) return null;
  const start = n - lines + 1;
  const errors: number[] = [];
  let total = 0;
  for (let i = 0; i < start - 1; i++) {
    if (!/\b(error|fail(ed|ure)?|exception|panic|fatal|traceback)\b/i.test(all[i]!)) continue;
    total++;
    if (errors.length < MAX_ERROR_LINES) errors.push(i + 1);
  }
  const map = errors.length
    ? ` Earlier lines that mention an error or failure: ${errors.map((l) => `L${l}`).join(", ")}${total > errors.length ? ` (+${total - errors.length} more)` : ""}.`
    : " No earlier line mentions an error or failure.";
  return { kind: "log", start, lines, bytes, totalLines: n, map };
}
