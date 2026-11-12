/**
 * File history notes (memoryFileHistory, an opt-in experiment of 2026-11-10): when the agent first reads
 * a source file in a session, the few commits that last changed it, as one short note after the read.
 *
 * Why: in two replay pilots (Hugo, vuejs/core) the agent never searched memory and never ran `git log`,
 * yet on 5 of 7 history-dependent tasks the commit that last changed the fix's lines was among the last
 * three commits of a file the agent itself opened, and 4 of those 5 tasks failed in every arm. The note
 * is tied to what the agent reads, not to a guess at what its task needs. It lists commits; it never
 * says one caused anything.
 *
 * Only history the checkout holds: `git log` from HEAD, within FILE_HISTORY_DAYS before HEAD's own
 * commit date (not today's), so a replay at an old base sees only what came before it. At most
 * FILE_HISTORY_COMMITS per file, FILE_HISTORY_NOTES files per session and FILE_HISTORY_TOKENS in all.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { estimateTokens } from "../ledger/tokens.js";
import { safeText } from "../util/safe.js";

export const FILE_HISTORY_COMMITS = 3;
export const FILE_HISTORY_DAYS = 183;
export const FILE_HISTORY_NOTES = 8;
export const FILE_HISTORY_TOKENS = 600;

/** Source code only: tests, lockfiles, generated output and docs say little about where a bug came from. */
const SOURCE = /\.(?:go|ts|tsx|mts|cts|js|mjs|cjs|jsx|vue|svelte|py|rs|java|kt|rb|c|cc|cpp|h|hpp|cs|swift|php)$/;
const NOT_SOURCE = /(?:^|\/)(?:__tests__|tests?|spec|testdata|fixtures?|node_modules|dist|build|vendor)\/|[._](?:test|spec)\.[a-z]+$|_test\.go$|\.d\.ts$|\.min\.js$/;
export const isSourceFile = (rel: string) => SOURCE.test(rel) && !NOT_SOURCE.test(rel);

/**
 * Project files a shell command reads: path-like words with a source extension, resolved against the
 * command's folder and any folder it `cd`s into, kept when the file exists. Wider than the gate's
 * whole-file printers on purpose: agents read code with `sed -n`, `head` and `grep` too.
 */
export function commandFiles(command: string, cwd: string): string[] {
  const dirs = [cwd];
  for (const m of command.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    const d = m[1]!.replace(/^["']|["']$/g, "");
    for (const base of [...dirs]) dirs.push(isAbsolute(d) ? d : resolve(base, d));
  }
  const out: string[] = [];
  for (const m of command.matchAll(/[\w.@/\\:-]+\.[A-Za-z]{1,5}\b/g)) {
    const word = m[0];
    for (const d of dirs) {
      const abs = isAbsolute(word) ? word : resolve(d, word);
      try { if (existsSync(abs) && statSync(abs).isFile() && !out.includes(abs)) { out.push(abs); break; } } catch { /* not a file */ }
    }
  }
  return out;
}

export interface FileCommit { sha: string; date: string; subject: string }

/** The commits that last changed `rel`, newest first, within FILE_HISTORY_DAYS before HEAD's commit date. */
export function fileCommits(projectDir: string, rel: string, n = FILE_HISTORY_COMMITS): FileCommit[] {
  const git = (args: string[]) => spawnSync("git", args, { cwd: projectDir, encoding: "utf8", timeout: 3000, windowsHide: true });
  const head = git(["log", "-1", "--format=%cI", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) return [];
  const since = new Date(Date.parse(head.stdout.trim()) - FILE_HISTORY_DAYS * 86_400_000).toISOString();
  const r = git(["log", `-n${n}`, `--since=${since}`, "--format=%h%x09%cs%x09%s", "HEAD", "--", rel]);
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((l) => { const [sha = "", date = "", ...s] = l.split("\t"); return { sha, date, subject: s.join("\t") }; });
}

/** A subject cut at a word, never in the middle: the start of a commit subject says what it changed. */
const subjectOf = (s: string, max = 90) => { const t = safeText(s, 400); return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, "")}…`; };

/** The note for one file, or "" when its recent history is empty. */
export function fileHistoryLine(rel: string, commits: FileCommit[]): string {
  if (!commits.length) return "";
  return `Snout: recent commits to ${safeText(rel, 120)} (this checkout's history, newest first; records, not a diagnosis): ${commits.map((c) => `${c.sha} ${c.date} ${subjectOf(c.subject)}`).join(" · ")}`;
}

export interface FileHistoryState { files: string[]; tokens: number }

/**
 * Notes for the files a read touched that this session has not had one for, within the per-session caps.
 * Returns the note text (empty when there is nothing to add) and the state to keep.
 */
export function fileHistoryNotes(projectDir: string, absFiles: string[], state: FileHistoryState): { text: string; state: FileHistoryState; files: { file: string; commits: string[]; subjects: string[] }[] } {
  const lines: string[] = [], files: { file: string; commits: string[]; subjects: string[] }[] = [];
  let next = { files: [...state.files], tokens: state.tokens };
  for (const abs of absFiles) {
    const rel = relative(projectDir, abs).split(sep).join("/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !isSourceFile(rel) || next.files.includes(rel)) continue;
    if (next.files.length >= FILE_HISTORY_NOTES) break;
    next.files.push(rel);
    const commits = fileCommits(projectDir, rel);
    const line = fileHistoryLine(rel, commits);
    if (!line) continue;
    const t = estimateTokens(Buffer.byteLength(line), "x.md");
    if (next.tokens + t > FILE_HISTORY_TOKENS) break;
    next.tokens += t;
    lines.push(line);
    files.push({ file: rel, commits: commits.map((c) => c.sha), subjects: commits.map((c) => c.subject) });
  }
  return { text: lines.join("\n"), state: next, files };
}

export const fileHistoryStateFile = (snoutDir: string, session: string) => join(snoutDir, "sessions", `${session.replace(/[^\w.-]/g, "_")}.file-history.json`);
