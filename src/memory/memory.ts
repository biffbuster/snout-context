import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SessionFacts } from "../compact/memory.js";
import { writeAtomic } from "../util/atomic.js";
import { safeText } from "../util/safe.js";

/**
 * Cross-session memory: one card per agent session, written locally at each Stop from the session's
 * own transcript (no model call), linked to the commits the session made, and recalled when a later
 * prompt bears on it. One file per card, so a team that commits `.snout/memory/` never gets a
 * merge conflict on it.
 */
export interface Card {
  v: 1;
  id: string;
  session: string;
  agent: "claude" | "codex";
  started: string;
  updated: string;
  branch?: string;
  author?: string;
  task?: string;
  request?: string;
  changed: string[];
  test?: { command: string; result: string };
  error?: { line: string; command: string };
  rules: string[];
  commits: Commit[];
}

export interface Commit { sha: string; subject: string; ts: string; files: string[] }

export const MEMORY_DIR = "memory";
/** Cards older than this are not recalled: the code they describe has likely moved on. */
const MAX_AGE_DAYS = 90;
const MAX_CARDS = 3;
/** The brief stays short: it is paid for on every later turn of the session. */
const MAX_BRIEF_CHARS = 2400;

const dirOf = (snoutDir: string) => join(snoutDir, MEMORY_DIR);
const fileOf = (snoutDir: string, session: string) => join(dirOf(snoutDir), `${session.replace(/[^\w.-]/g, "_").slice(0, 80)}.json`);

export function readCard(snoutDir: string, session: string): Card | null {
  try { return JSON.parse(readFileSync(fileOf(snoutDir, session), "utf8")) as Card; } catch { return null; }
}

export function readCards(snoutDir: string): Card[] {
  let names: string[];
  try { names = readdirSync(dirOf(snoutDir)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const cards: Card[] = [];
  for (const n of names) {
    try {
      const c = JSON.parse(readFileSync(join(dirOf(snoutDir), n), "utf8")) as Card;
      if (c?.v === 1 && typeof c.session === "string") cards.push(c);
    } catch { /* a half-written or foreign file is skipped */ }
  }
  return cards;
}

function writeCard(snoutDir: string, card: Card): void {
  mkdirSync(dirOf(snoutDir), { recursive: true });
  writeAtomic(fileOf(snoutDir, card.session), `${JSON.stringify(card, null, 1)}\n`);
}

export function forgetCard(snoutDir: string, session: string): boolean {
  try { unlinkSync(fileOf(snoutDir, session)); return true; } catch { return false; }
}

function git(projectDir: string, args: string[]): string | undefined {
  try {
    const r = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", timeout: 2000, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

const emptyCard = (session: string, agent: Card["agent"], now: string): Card =>
  ({ v: 1, id: session, session, agent, started: now, updated: now, changed: [], rules: [], commits: [] });

/**
 * Writes or refreshes this session's card from the facts its transcript gives. A session that asked
 * nothing, changed nothing and committed nothing leaves no card.
 */
export function captureSession(snoutDir: string, projectDir: string, session: string, agent: Card["agent"], facts: SessionFacts, now = new Date().toISOString()): Card | null {
  const prev = readCard(snoutDir, session);
  if (!facts.goal && !facts.changed.length && !prev?.commits.length) return null;
  const card: Card = {
    ...(prev ?? emptyCard(session, agent, now)),
    updated: now,
    branch: git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? prev?.branch,
    author: prev?.author ?? git(projectDir, ["config", "user.name"]),
    task: facts.goal ?? prev?.task,
    request: facts.request !== facts.goal ? facts.request : undefined,
    changed: facts.changed.filter((p) => !/^[A-Za-z]:|^\//.test(p)).slice(0, 20),
    test: facts.test,
    error: facts.error,
    rules: facts.rules,
  };
  writeCard(snoutDir, card);
  return card;
}

/** A Bash command that may have made a commit. */
export const COMMITS = /\bgit\b[^|;&]*\b(commit|merge|cherry-pick|revert|am)\b/;

/** Links HEAD to this session's card when it is a commit the card doesn't have yet. */
export function linkCommit(snoutDir: string, projectDir: string, session: string, agent: Card["agent"], now = new Date().toISOString()): Commit | null {
  const head = git(projectDir, ["log", "-1", "--format=%H%x1f%s%x1f%cI", "--name-only"]);
  if (!head) return null;
  const [first, ...rest] = head.split("\n");
  const [sha, subject, ts] = first!.split("\x1f");
  if (!sha || !ts) return null;
  const card = readCard(snoutDir, session) ?? emptyCard(session, agent, now);
  if (card.commits.some((c) => c.sha === sha)) return null;
  // Only a commit made during this session: an older HEAD is someone else's work.
  if (Date.parse(ts) < Date.parse(card.started) - 60_000) return null;
  const commit: Commit = { sha, subject: subject ?? "", ts, files: rest.map((l) => l.trim()).filter(Boolean).slice(0, 30) };
  card.commits.push(commit);
  card.updated = now;
  writeCard(snoutDir, card);
  return commit;
}

// ---------- Recall ----------

const STOP = new Set(("the and for are but not you all any can had her was one our out has his how its may new now old see two way who did get let put say she too use this that with from have what when where which will your into than then them they there these those were been being does done just also only some such more most very about after again could should would here make made want need like look fix add bug issue error file files code please thanks okay yes run test tests work works working change changes update").split(" "));

/** Lowercased words of three or more letters, with camelCase and snake_case split into parts too. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}/g)) {
    const w = m[0];
    const parts = w.split(/_|(?<=[a-z0-9])(?=[A-Z])/).filter((p) => p.length >= 3);
    for (const t of new Set([w, ...parts].map((x) => x.toLowerCase()))) if (!STOP.has(t)) out.push(t);
  }
  return out;
}

function cardText(c: Card): string {
  return [c.task, c.request, ...c.changed, ...c.commits.flatMap((k) => [k.subject, ...k.files]), c.error?.line, c.branch].filter(Boolean).join(" ");
}

const cardFiles = (c: Card) => [...new Set([...c.changed, ...c.commits.flatMap((k) => k.files)])];

export interface Recalled { card: Card; score: number; matched: string[]; files: string[] }

export interface RecallOptions {
  /** The current session: its own card is never recalled to it. */
  session?: string;
  /** Point in time: only cards started before it (a replay must not see the future). */
  asOf?: string;
  now?: number;
  projectDir?: string;
}

/**
 * The past sessions that bear on a prompt, best first, or none. BM25 over each card's task, files
 * and commit subjects, plus a boost when the prompt names a file the session changed. A card is
 * recalled only above a floor (two or more distinct prompt terms, or a named file): recall that
 * can't tell when it is right costs tokens on every turn that follows.
 */
export function recall(cards: Card[], prompt: string, opts: RecallOptions = {}): Recalled[] {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ? Date.parse(opts.asOf) : undefined;
  const live = cards.filter((c) => {
    if (c.session === opts.session) return false;
    if (asOf !== undefined) return Date.parse(c.started) < asOf;
    return now - Date.parse(c.updated) <= MAX_AGE_DAYS * 86_400_000;
  }).map((c) => (asOf === undefined ? c : { ...c, commits: c.commits.filter((k) => Date.parse(k.ts) < asOf) }));
  if (!live.length) return [];
  const q = [...new Set(terms(prompt))];
  if (!q.length) return [];
  const docs = live.map((c) => terms(cardText(c)));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const lower = prompt.toLowerCase();
  const out: Recalled[] = [];
  live.forEach((card, i) => {
    const d = docs[i]!;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    const matched: string[] = [];
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      matched.push(t);
      const n = df.get(t)!;
      const idf = Math.log(1 + (live.length - n + 0.5) / (n + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg));
    }
    // A file the prompt names by path or by file name.
    let files = cardFiles(card).filter((p) => lower.includes(p.toLowerCase()) || (p.split("/").pop()!.length >= 6 && lower.includes(p.split("/").pop()!.toLowerCase())));
    score += files.length * 3;
    if (matched.length < 2 && !files.length) return;
    // Files that no longer exist are not offered: the brief would send the agent looking for them.
    if (opts.projectDir) files = files.filter((p) => existsSync(join(opts.projectDir!, p)));
    out.push({ card, score, matched, files });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_CARDS);
}

/** One line, no control characters or backticks: a card may come from a teammate's commit, so its text is untrusted. */
const clip = (s: string, n: number) => safeText(s.replace(/\s+/g, " ").trim(), n);

/** The brief a prompt gets: what each past session did, the files, its commits, what failed, what the user said. */
export function renderRecall(hits: Recalled[], projectDir?: string): string {
  if (!hits.length) return "";
  const exists = (p: string) => !projectDir || existsSync(join(projectDir, p));
  const lines = ["Snout memory: earlier sessions in this repo that bear on this request (local notes from their transcripts and commits; check before relying on them)."];
  for (const { card: c } of hits) {
    const parts = [`- ${c.started.slice(0, 10)} · ${c.agent}${c.branch ? ` · ${clip(c.branch, 60)}` : ""}: "${clip(c.task ?? c.commits[0]?.subject ?? "untitled", 160)}"`];
    const files = cardFiles(c).filter(exists).slice(0, 8);
    if (files.length) parts.push(`  files: ${files.map((f) => clip(f, 120)).join(", ")}`);
    if (c.commits.length) parts.push(`  commits: ${c.commits.slice(-3).map((k) => `${k.sha.replace(/[^0-9a-f]/gi, "").slice(0, 7)} "${clip(k.subject, 80)}"`).join("; ")}`);
    if (c.test) parts.push(`  tests: \`${clip(c.test.command, 100)}\` → ${clip(c.test.result, 80)}`);
    if (c.error) parts.push(`  unresolved at the end: ${clip(c.error.line, 140)} (from \`${clip(c.error.command, 80)}\`)`);
    if (c.rules.length) parts.push(`  the user said: ${c.rules.slice(-3).map((r) => `"${clip(r, 120)}"`).join(" ")}`);
    lines.push(parts.join("\n"));
  }
  let text = lines.join("\n");
  while (text.length > MAX_BRIEF_CHARS && lines.length > 2) { lines.pop(); text = lines.join("\n"); }
  return text.length > MAX_BRIEF_CHARS ? `${text.slice(0, MAX_BRIEF_CHARS - 1)}…` : text;
}

/** Cards a listing shows, newest first. */
export function listCards(snoutDir: string): Card[] {
  return readCards(snoutDir).sort((a, b) => b.updated.localeCompare(a.updated));
}
