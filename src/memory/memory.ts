import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  /** How the session ended, in the agent's own last words: what it did and why. */
  outcome?: string;
  changed: string[];
  test?: { command: string; result: string };
  error?: { line: string; command: string };
  rules: string[];
  /** Tools the session found missing, and test commands too slow for the tool limit. */
  missing?: string[];
  slow?: string[];
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
    outcome: facts.outcome ?? prev?.outcome,
    missing: facts.missing.map((m) => m.name),
    slow: facts.slow,
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
  return [c.task, c.request, c.outcome, ...c.changed, ...c.commits.flatMap((k) => [k.subject, ...k.files]), c.error?.line, c.branch].filter(Boolean).join(" ");
}

export const cardFiles = (c: Card) => [...new Set([...c.changed, ...c.commits.flatMap((k) => k.files)])];

export interface Recalled { card: Card; score: number; matched: string[]; files: string[] }

export interface RecallOptions {
  /** The current session: its own card is never recalled to it. */
  session?: string;
  /** Point in time: only cards started before it (a replay must not see the future). */
  asOf?: string;
  now?: number;
  projectDir?: string;
  /** How many to return (the hook shows 3; the offline eval scores more). */
  limit?: number;
}

/** The cards a prompt may be offered: not its own session's, and before `asOf` or else not expired. */
function liveCards(cards: Card[], opts: RecallOptions): Card[] {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ? Date.parse(opts.asOf) : undefined;
  return cards.filter((c) => {
    if (c.session === opts.session) return false;
    if (asOf !== undefined) return Date.parse(c.started) < asOf;
    return now - Date.parse(c.updated) <= MAX_AGE_DAYS * 86_400_000;
  }).map((c) => (asOf === undefined ? c : { ...c, commits: c.commits.filter((k) => Date.parse(k.ts) < asOf) }));
}

/**
 * The past sessions that bear on a prompt, best first, or none. BM25 over each card's task, files
 * and commit subjects, plus a boost when the prompt names a file the session changed. A card is
 * recalled only above a floor (two or more distinct prompt terms, or a named file): recall that
 * can't tell when it is right costs tokens on every turn that follows.
 */
export function recall(cards: Card[], prompt: string, opts: RecallOptions = {}): Recalled[] {
  const live = liveCards(cards, opts);
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
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? MAX_CARDS);
}

/** What a card's embedding is computed from: what the session set out to do, how it ended, its commits and files. */
export function embedText(c: Card): string {
  return [c.task, c.outcome, ...c.commits.map((k) => k.subject), ...cardFiles(c).slice(0, 20)].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 1000);
}

/** A card's vector is reused until the text it came from changes. */
export const embedKey = (c: Card): string => createHash("sha256").update(embedText(c)).digest("hex").slice(0, 16);

/** A card makes the hybrid brief only when it sits near the top of both rankings (bench/recalleval.mjs, 87% precision). */
export const HYBRID_CUT = 0.0321;
const RRF_K = 60;

export interface Vectors { query: ArrayLike<number>; cards: Map<string, ArrayLike<number>> }

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/**
 * Words and meaning together: reciprocal-rank fusion of the BM25 ranking and the embedding ranking,
 * keeping a card only when both put it near the top (or the prompt names one of its files). On 485
 * SWE-bench tasks this named a needed file in 64% of briefs against 54% for words alone, and with the
 * cut and the map's agreement it was right 87% of the times it spoke.
 */
export function hybridRecall(cards: Card[], prompt: string, vectors: Vectors, opts: RecallOptions = {}): Recalled[] {
  const words = recall(cards, prompt, { ...opts, limit: 50 });
  const meaning = liveCards(cards, opts).filter((c) => vectors.cards.has(c.id))
    .map((c) => ({ c, s: dot(vectors.query, vectors.cards.get(c.id)!) })).sort((a, b) => b.s - a.s).slice(0, 50);
  const fused = new Map<string, Recalled>();
  words.forEach((h, i) => fused.set(h.card.id, { ...h, score: 1 / (RRF_K + i) }));
  meaning.forEach(({ c }, i) => {
    const h = fused.get(c.id) ?? { card: c, score: 0, matched: [], files: [] };
    fused.set(c.id, { ...h, score: h.score + 1 / (RRF_K + i) });
  });
  return [...fused.values()].filter((h) => h.score >= HYBRID_CUT || h.files.length > 0)
    .sort((a, b) => b.score - a.score).slice(0, opts.limit ?? MAX_CARDS);
}

/** Card vectors, local to this machine (`.snout/memory-vectors.json`, never shared): id → text key and vector. */
export interface VectorCache { model: string; cards: Record<string, { k: string; v: string }> }

const vectorFile = (snoutDir: string) => join(snoutDir, "memory-vectors.json");

export function readVectors(snoutDir: string, model: string): VectorCache {
  try {
    const c = JSON.parse(readFileSync(vectorFile(snoutDir), "utf8")) as VectorCache;
    if (c.model === model && c.cards && typeof c.cards === "object") return c;
  } catch { /* none yet, or unreadable: start over */ }
  return { model, cards: {} };
}

export function writeVectors(snoutDir: string, cache: VectorCache): void {
  mkdirSync(snoutDir, { recursive: true });
  writeAtomic(vectorFile(snoutDir), JSON.stringify(cache));
}

/** Float32 vectors as base64: a 384-wide vector is 2 KB instead of 7 KB of JSON numbers. */
export const packVector = (v: ArrayLike<number>): string => Buffer.from(Float32Array.from(v).buffer).toString("base64");
export const unpackVector = (s: string): Float32Array => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/** One line, no control characters or backticks: a card may come from a teammate's commit, so its text is untrusted. */
const clip = (s: string, n: number) => safeText(s.replace(/\s+/g, " ").trim(), n);

/** The brief a prompt gets: what each past session did, the files, its commits, what failed, what the user said. */
export function renderRecall(hits: Recalled[], projectDir?: string): string {
  if (!hits.length) return "";
  const exists = (p: string) => !projectDir || existsSync(join(projectDir, p));
  const lines = ["Snout memory: earlier sessions in this repo that bear on this request (local notes from their transcripts and commits; check before relying on them)."];
  for (const { card: c } of hits) {
    const parts = [`- ${c.started.slice(0, 10)} · ${c.agent}${c.branch ? ` · ${clip(c.branch, 60)}` : ""}: "${clip(c.task ?? c.commits[0]?.subject ?? "untitled", 160)}"`];
    if (c.outcome) parts.push(`  how it ended: ${clip(c.outcome, 400)}`);
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

// ---------- Repo brief ----------

/** A fact counts as learned once this many separate sessions show it. */
const RECUR = 2;
const MAX_BRIEF_FILES = 8;
/** Recent cards only: the brief describes how the repo works now. */
const BRIEF_CARDS = 200;
const MAX_REPO_BRIEF_CHARS = 1600;

export interface BriefOptions {
  now?: number;
  asOf?: string;
  projectDir?: string;
  /** The instruction files the agent already loads (CLAUDE.md, AGENTS.md): what they say is not repeated. */
  instructions?: string;
}

/** Each value with the number of distinct sessions that showed it, most first, then most recent. */
function recurring(cards: Card[], values: (c: Card) => string[], key = (v: string) => v.toLowerCase()): { value: string; sessions: number }[] {
  const seen = new Map<string, { value: string; sessions: number; last: string }>();
  for (const c of cards) {
    for (const v of new Set(values(c))) {
      const k = key(v);
      const e = seen.get(k);
      if (e) { e.sessions += 1; if (c.updated > e.last) { e.last = c.updated; e.value = v; } }
      else seen.set(k, { value: v, sessions: 1, last: c.updated });
    }
  }
  return [...seen.values()].filter((e) => e.sessions >= RECUR).sort((a, b) => b.sessions - a.sessions || b.last.localeCompare(a.last));
}

/**
 * What separate sessions in this repo keep finding, given once at session start so the agent doesn't
 * rediscover it: the test command that works, tools that aren't installed, commands too slow for the
 * tool limit, the files most work touches, and instructions the user has given more than once.
 * Only facts two or more sessions showed, and none the instruction files already state.
 */
export function repoBrief(cards: Card[], opts: BriefOptions = {}): string {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ? Date.parse(opts.asOf) : undefined;
  const live = cards
    .filter((c) => (asOf !== undefined ? Date.parse(c.started) < asOf : now - Date.parse(c.updated) <= MAX_AGE_DAYS * 86_400_000))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, BRIEF_CARDS);
  if (live.length < RECUR) return "";
  const known = (opts.instructions ?? "").toLowerCase();
  const fresh = (s: string) => !known.includes(s.toLowerCase());
  const exists = (p: string) => !opts.projectDir || existsSync(join(opts.projectDir, p));
  const lines: string[] = [];
  const test = recurring(live, (c) => (c.test ? [c.test.command] : []), (v) => v).find((t) => fresh(t.value));
  if (test) lines.push(`- Tests run here with: \`${clip(test.value, 160)}\` (${test.sessions} sessions)`);
  const missing = recurring(live, (c) => c.missing ?? []).filter((m) => fresh(m.value)).slice(0, 4);
  if (missing.length) lines.push(`- Not installed here: ${missing.map((m) => clip(m.value, 40)).join(", ")}`);
  const slow = recurring(live, (c) => c.slow ?? [], (v) => v).filter((s) => fresh(s.value)).slice(0, 2);
  for (const s of slow) lines.push(`- Runs past the 2-minute tool limit (prefer narrower runs): \`${clip(s.value, 140)}\``);
  const files = recurring(live, (c) => cardFiles(c), (v) => v).filter((f) => exists(f.value)).slice(0, MAX_BRIEF_FILES);
  if (files.length) lines.push(`- Files most work here touches: ${files.map((f) => `${clip(f.value, 100)} (${f.sessions})`).join(", ")}`);
  const rules = recurring(live, (c) => c.rules).filter((r) => fresh(r.value)).slice(0, 5);
  for (const r of rules) lines.push(`- The user has said in ${r.sessions} sessions: "${clip(r.value, 200)}"`);
  if (!lines.length) return "";
  let text = [`Snout memory: what ${live.length} earlier sessions in this repo keep finding (local notes from their transcripts; check before relying on them).`, ...lines].join("\n");
  while (text.length > MAX_REPO_BRIEF_CHARS && lines.length > 1) { lines.pop(); text = [text.split("\n")[0]!, ...lines].join("\n"); }
  return text;
}

// ---------- Sharing ----------

export type ShareResult =
  | { ok: true; changedGitignore: boolean; dir: string }
  | { ok: false; reason: string };

/**
 * Lets git track `.snout/memory/` while the rest of `.snout/` stays ignored: the usual `.snout/`
 * line becomes `.snout/*` plus `!.snout/memory/` (git can't re-include a file inside an ignored
 * directory). Never stages or commits anything: what gets shared is the user's call.
 */
export function shareMemory(projectDir: string, snoutDir: string): ShareResult {
  const rel = relative(projectDir, dirOf(snoutDir)).split(sep).join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, reason: "Snout's records are kept outside this project (SNOUT_DIR), so git can't share them from here." };
  if (git(projectDir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { ok: false, reason: "This project isn't a git repository." };
  const probe = `${rel}/card.json`;
  const ignored = () => spawnSync("git", ["check-ignore", "-q", "--no-index", probe], { cwd: projectDir, timeout: 2000, windowsHide: true }).status === 0;
  if (!ignored()) return { ok: true, changedGitignore: false, dir: rel };
  const file = join(projectDir, ".gitignore");
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { /* none */ }
  const top = rel.split("/")[0]!;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^/?${top.replace(/\./g, "\.")}/?\s*$`).test(l));
  if (i < 0) {
    const why = git(projectDir, ["check-ignore", "-v", "--no-index", probe]);
    return { ok: false, reason: `${rel} is ignored by a rule Snout won't edit${why ? ` (${why.split("\t")[0]})` : ""}. Add \`!${rel}/\` after it to share memory.` };
  }
  lines.splice(i, 1, `${top}/*`, `!${rel}/`);
  writeAtomic(file, lines.join(nl));
  return ignored() ? { ok: false, reason: `Updated .gitignore, but another rule still ignores ${rel}.` } : { ok: true, changedGitignore: true, dir: rel };
}
