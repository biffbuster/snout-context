/**
 * Snout's memory store: observations worth keeping across sessions, and who may see each one.
 *
 * An observation is one reusable piece of knowledge: a convention, a decision, a gotcha, a
 * preference, a command, a fact. Not a transcript, not a tool dump. Each is a small JSON file, so
 * a shared store merges and reviews like any other file in git.
 *
 *   private   <configDir>/memory/<project>/ (or global/): this user's, never in the repository
 *   shared    <project>/.snout/memory/obs/: travels with the repository through git
 *
 * Who may see an observation is decided per observation, at recall, before anything is ranked or
 * injected: `admit` lets one through only if every viewer of the session is in its recorded
 * audience. A missing audience, or a viewer with no identity, fails closed. So a private note
 * never turns up in a session someone else can see, and a shared one stays inside its repository.
 *
 * Identities are hashes (of the git email, of the repository), never the email or path itself.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../util/atomic.js";
import { readPrefs } from "./prefs.js";
import { indexedRecords, indexFileFor, type RecordKind } from "./sqlite.js";
import { indexForms } from "./retrieve.js";

export const KINDS = ["convention", "decision", "gotcha", "preference", "command", "fact"] as const;
export type ObsKind = (typeof KINDS)[number];
export type Scope = "private" | "shared";
export type ObsStatus = "active" | "proposed" | "superseded" | "archived";

export interface Observation {
  v: 1;
  id: string;
  kind: ObsKind;
  text: string;
  scope: Scope;
  /** The project's key, or "*" for a private observation that applies everywhere. */
  project: string;
  /** Principals cleared to see it: "user:<hash>", "repo:<hash>", or "public". */
  audience: string[];
  status: ObsStatus;
  /**
   * Where it came from. `evidence`: the record a rule saw (a test run's result line, the error a
   * missing tool gave). `hashes`: each file's content hash when the note was saved, so a note about
   * code that has changed since is held back (memory/facts.ts).
   */
  source: { via: string; session: string | null; agent: string | null; ts: string; files: string[]; evidence?: string; hashes?: Record<string, string> };
  created: string;
  updated: string;
  supersedes: string | null;
  supersededBy: string | null;
  tags: string[];
  /** A lesson (memory/review.ts): what it rests on, where it applies, what the record showed, and the person's review. */
  lesson?: LessonMeta;
}

/** What a lesson rests on: a test run that passed, a decision the user gave, or a correction the user made that the work then met. */
export type LessonBasis = "test" | "decision" | "correction";

export interface LessonMeta {
  basis: LessonBasis;
  /** Where it holds, in the proposer's words ("when exporting fuel sales for the supplier portal"). */
  applies: string;
  /** pending until the session's record shows the evidence (at its next Stop); verified once it does. */
  check: "pending" | "verified";
  /** What the record showed: the test command and its result, or the user's words. */
  checked?: string;
  /** A person changed its wording or conditions before approving it. */
  edited?: boolean;
  /** The person's verdict. Nothing but `snout memory approve` (or a person's own replacement) sets "approved". */
  review?: { verdict: "approved" | "rejected"; at: string; note?: string };
}

/** Who is looking: every principal one viewer holds. */
export interface Viewer {
  principals: string[];
}

export const MAX_TEXT = 400;
const GLOBAL = "*";

/** Where the two stores live for one project. */
export interface Stores {
  project: string;
  /** Private observations for this project. */
  privateDir: string;
  /** Private observations for every project. */
  globalDir: string;
  sharedDir: string;
  /** The local index of all three (sqlite.ts), on this machine only. Without it, the files are read directly. */
  indexFile?: string;
}

/** A stable id for the project that reveals neither its remote nor its path. */
export function projectKey(projectDir: string): string {
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: projectDir, encoding: "utf8", timeout: 3000 });
  const remote = r.status === 0 ? r.stdout.trim() : "";
  // github.com:me/x.git, https://user:pw@github.com/me/x and https://github.com/me/x are one project.
  const norm = remote
    ? remote.replace(/^[a-z+]+:\/\/([^@/]*@)?/i, "").replace(/^[^@/]*@/, "").replace(":", "/").replace(/\.git$/, "").toLowerCase()
    : projectDir;
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

export function storesFor(projectDir: string, snoutDir: string, configDir: string, key = projectKey(projectDir)): Stores {
  return { project: key, privateDir: join(configDir, "memory", key), globalDir: join(configDir, "memory", "global"), sharedDir: join(snoutDir, "memory", "obs"), indexFile: indexFileFor(configDir, snoutDir) };
}

const hash = (s: string, n = 16) => createHash("sha256").update(s).digest("hex").slice(0, n);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Text as stored: one line of printable characters, capped. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

/**
 * This machine's user, as a principal: a hash of the git email, or of the OS user when git has
 * none. Null when neither is known, and then only shared and public observations are admitted.
 */
export function userPrincipal(projectDir: string): string | null {
  const r = spawnSync("git", ["config", "--get", "user.email"], { cwd: projectDir, encoding: "utf8", timeout: 3000, windowsHide: true });
  const email = r.status === 0 ? r.stdout.trim().toLowerCase() : "";
  if (email) return `user:${hash(`email:${email}`)}`;
  try {
    const name = userInfo().username;
    return name ? `user:${hash(`os:${name}`)}` : null;
  } catch {
    return null;
  }
}

export const repoPrincipal = (key: string) => `repo:${key}`;

/**
 * The person at this machine: their own principal, and the repository's, since they have the
 * repository open. A cloud agent with no user identity (CI, SNOUT_TOKEN) holds only the
 * repository, so it sees shared observations and none of anyone's private ones.
 */
export function localViewer(projectDir: string, key: string, user = userPrincipal(projectDir)): Viewer {
  return { principals: [...(user ? [user] : []), repoPrincipal(key)] };
}

/**
 * The admission rule, per observation: active, for this project (or a private one for every
 * project), and every viewer holds a principal in its audience. No viewers, or no audience,
 * admits nothing. "public" in an audience admits any viewer.
 */
export function admit(o: Observation, viewers: Viewer[], project: string): boolean {
  if (o.status !== "active") return false;
  if (o.project !== project && !(o.project === GLOBAL && o.scope === "private")) return false;
  if (!viewers.length || !Array.isArray(o.audience) || !o.audience.length) return false;
  return viewers.every((v) => o.audience.includes("public") || v.principals.some((p) => o.audience.includes(p)));
}

function parse(raw: unknown): Observation | null {
  const o = raw as Partial<Observation> | null;
  if (!o || o.v !== 1 || typeof o.id !== "string" || !/^o_[a-f0-9]{12}$/.test(o.id)) return null;
  if (!KINDS.includes(o.kind as ObsKind) || typeof o.text !== "string" || !o.text) return null;
  if (o.scope !== "private" && o.scope !== "shared") return null;
  if (!["active", "proposed", "superseded", "archived"].includes(String(o.status))) return null;
  return {
    v: 1, id: o.id, kind: o.kind as ObsKind, text: clean(o.text), scope: o.scope, project: typeof o.project === "string" ? o.project : "",
    // A file whose audience is missing or malformed keeps an empty one, which admits no one.
    audience: Array.isArray(o.audience) ? o.audience.filter((p): p is string => typeof p === "string") : [],
    status: o.status as ObsStatus,
    source: {
      via: String(o.source?.via ?? "unknown"), session: typeof o.source?.session === "string" ? o.source.session : null, agent: typeof o.source?.agent === "string" ? o.source.agent : null,
      ts: String(o.source?.ts ?? o.created ?? ""), files: Array.isArray(o.source?.files) ? o.source.files.filter((f): f is string => typeof f === "string").slice(0, 20) : [],
      ...(typeof o.source?.evidence === "string" ? { evidence: clean(o.source.evidence).slice(0, 160) } : {}),
      ...(o.source?.hashes && typeof o.source.hashes === "object" ? { hashes: Object.fromEntries(Object.entries(o.source.hashes).filter(([, v]) => typeof v === "string").slice(0, 20)) as Record<string, string> } : {}),
    },
    created: String(o.created ?? ""), updated: String(o.updated ?? o.created ?? ""),
    supersedes: typeof o.supersedes === "string" ? o.supersedes : null, supersededBy: typeof o.supersededBy === "string" ? o.supersededBy : null,
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string").slice(0, 8) : [],
    ...(parseLesson(o.lesson) ? { lesson: parseLesson(o.lesson)! } : {}),
  };
}

function parseLesson(raw: unknown): LessonMeta | null {
  const l = raw as Partial<LessonMeta> | null | undefined;
  if (!l || !["test", "decision", "correction"].includes(String(l.basis)) || typeof l.applies !== "string") return null;
  const r = l.review;
  return {
    basis: l.basis as LessonBasis, applies: clean(l.applies).slice(0, 200), check: l.check === "verified" ? "verified" : "pending",
    ...(typeof l.checked === "string" ? { checked: clean(l.checked).slice(0, 300) } : {}),
    ...(l.edited === true ? { edited: true } : {}),
    ...(r && (r.verdict === "approved" || r.verdict === "rejected") ? { review: { verdict: r.verdict, at: String(r.at ?? ""), ...(typeof r.note === "string" ? { note: clean(r.note).slice(0, 200) } : {}) } } : {}),
  };
}

/** Observations as the local index keeps them: the same reader, so the index holds exactly what a scan would. */
export const OBS_KIND: RecordKind<Observation> = {
  name: "obs", parse, text: (o) => o.text, files: (o) => o.source.files, updated: (o) => o.updated,
  forms: (text) => indexForms(text),
};

/** A folder's observations, from the local index when there is one, else from the files. */
function readDir(dir: string, index?: string): Observation[] {
  return indexedRecords(index, dir, OBS_KIND) ?? scanDir(dir);
}

function scanDir(dir: string): Observation[] {
  if (!existsSync(dir)) return [];
  const out: Observation[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const o = parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (o) out.push(o);
    } catch {
      // a half-written or hand-broken file is skipped, never guessed at
    }
  }
  return out;
}

/** Every observation in both stores, whatever its status. Use `recallable` for what a session may see. */
export function listObservations(s: Stores): Observation[] {
  return [...readDir(s.privateDir, s.indexFile), ...readDir(s.globalDir, s.indexFile), ...readDir(s.sharedDir, s.indexFile)].sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

/** What these viewers may see in this project: the admission rule over both stores. */
export function recallable(s: Stores, viewers: Viewer[]): Observation[] {
  return listObservations(s).filter((o) => admit(o, viewers, s.project));
}

const dirOf = (s: Stores, o: Pick<Observation, "scope" | "project">) => (o.scope === "shared" ? s.sharedDir : o.project === GLOBAL ? s.globalDir : s.privateDir);

export function write(s: Stores, o: Observation): void {
  const dir = dirOf(s, o);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${o.id}.json`), `${JSON.stringify(o, null, 1)}\n`);
}

export interface NewObservation {
  kind: ObsKind;
  text: string;
  /** Private unless sharing is asked for: sharing is a choice, never a default. */
  scope?: Scope;
  /** Private only: true applies it in every project. */
  global?: boolean;
  status?: "active" | "proposed";
  via: string;
  session?: string | null;
  agent?: string | null;
  files?: string[];
  tags?: string[];
  evidence?: string;
  hashes?: Record<string, string>;
  lesson?: LessonMeta;
}

/**
 * Saves an observation and returns it. The same text, kind and scope in the same project is one
 * observation: saving it again returns the existing one unchanged.
 */
export function addObservation(s: Stores, user: string | null, n: NewObservation, now = new Date()): Observation {
  const text = clean(n.text);
  if (!text) throw new Error("an observation needs text");
  if (!KINDS.includes(n.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const scope: Scope = n.scope ?? "private";
  const project = scope === "private" && n.global ? GLOBAL : s.project;
  // A private observation is for its user only; with no known user it would admit no one.
  if (scope === "private" && !user) throw new Error("no user identity here (set git user.email): a private observation would be visible to no one");
  const id = `o_${hash(`${scope}\0${project}\0${n.kind}\0${norm(text)}`, 12)}`;
  const existing = readDir(dirOf(s, { scope, project }), s.indexFile).find((o) => o.id === id);
  if (existing) return existing;
  const ts = now.toISOString();
  const o: Observation = {
    v: 1, id, kind: n.kind, text, scope, project,
    audience: scope === "private" ? [user!] : [repoPrincipal(s.project)],
    status: n.status ?? "active",
    source: { via: n.via, session: n.session ?? null, agent: n.agent ?? null, ts, files: (n.files ?? []).slice(0, 20), ...(n.evidence ? { evidence: clean(n.evidence).slice(0, 160) } : {}), ...(n.hashes ? { hashes: n.hashes } : {}) },
    created: ts, updated: ts, supersedes: null, supersededBy: null, tags: (n.tags ?? []).slice(0, 8),
    ...(n.lesson ? { lesson: n.lesson } : {}),
  };
  write(s, o);
  return o;
}

export function find(s: Stores, id: string): Observation | null {
  return listObservations(s).find((o) => o.id === id || (id.length >= 6 && o.id.startsWith(id))) ?? null;
}

/** Retires an observation without deleting it: it stays on disk as a record, and is never admitted. */
export function archiveObservation(s: Stores, id: string, now = new Date()): Observation | null {
  const o = find(s, id);
  if (!o) return null;
  const next = { ...o, status: "archived" as const, updated: now.toISOString() };
  write(s, next);
  return next;
}

/**
 * Replaces an observation with a corrected one; the old one is kept, marked superseded, and links to it.
 * `source`: where the replacement came from (its session, agent and evidence), when not the user.
 */
export function supersedeObservation(s: Stores, user: string | null, id: string, text: string, via = "manual", now = new Date(), source: Pick<NewObservation, "session" | "agent" | "evidence"> = {}): Observation | null {
  const old = find(s, id);
  if (!old) return null;
  const next = addObservation(s, user, { kind: old.kind, text, scope: old.scope, global: old.project === GLOBAL, via, tags: old.tags, ...source }, now);
  if (next.id === old.id) return old;
  // The text may be an older note's, replaced since (a test command that went A, B, then A again):
  // that note is the current one again, not a second "replaced" in a loop with the one it replaces.
  write(s, { ...next, status: "active", supersededBy: null, supersedes: old.id, updated: now.toISOString() });
  write(s, { ...old, status: "superseded", supersededBy: next.id, updated: now.toISOString() });
  return { ...next, supersedes: old.id };
}

/** Makes a replaced observation current again, when nothing current has taken its place. */
export function reactivateObservation(s: Stores, id: string, now = new Date()): Observation | null {
  const o = find(s, id);
  if (!o || o.status !== "superseded") return null;
  const next = { ...o, status: "active" as const, supersededBy: null, updated: now.toISOString() };
  write(s, next);
  return next;
}

/** Marks an observation superseded by another that is already saved, and links the two. */
export function markSuperseded(s: Stores, id: string, by: string, now = new Date()): Observation | null {
  const old = find(s, id);
  const next = find(s, by);
  if (!old || !next || old.id === next.id) return null;
  write(s, { ...next, supersedes: old.id, updated: now.toISOString() });
  const retired = { ...old, status: "superseded" as const, supersededBy: next.id, updated: now.toISOString() };
  write(s, retired);
  return retired;
}

/** Deletes an observation's file outright (`snout memory forget`), for something that should not have been saved. */
export function deleteObservation(s: Stores, id: string): Observation | null {
  const o = find(s, id);
  if (!o) return null;
  rmSync(join(dirOf(s, o), `${o.id}.json`), { force: true });
  return o;
}

/**
 * Moves the preferences Jev saved (.snout/memory/preferences.json) into the private store. They
 * are what one person said about how they work, so they become private, not shared. Idempotent:
 * running it again adds nothing. The old file is left in place.
 */
export function migratePrefs(snoutDir: string, s: Stores, user: string | null, now = new Date()): Observation[] {
  if (!user) return [];
  const before = new Set(listObservations(s).map((o) => o.id));
  const out: Observation[] = [];
  for (const p of readPrefs(snoutDir)) {
    const o = addObservation(s, user, { kind: "preference", text: p.text, scope: "private", via: "migrate:prefs", session: p.session }, now);
    if (!before.has(o.id)) out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------- injection

/** Tokens the session-start memory block may take, unless `memoryBudget` says otherwise. */
export const MEMORY_BUDGET = 600;
/** Most useful first within a scope: what prevents a mistake, then how the project works. */
const KIND_ORDER: ObsKind[] = ["gotcha", "convention", "decision", "command", "preference", "fact"];
const tokensOf = (s: string) => Math.ceil(Buffer.byteLength(s) / 4);

export interface MemoryBlock {
  text: string;
  /** Observations in the block, in order. */
  items: string[];
  /** Admitted but left out for the budget: still recallable, never silently lost. */
  dropped: string[];
  tokensEst: number;
}

/** Most specific first: private to this project, then shared in it, then private everywhere. */
const scopeRank = (o: Observation) => (o.scope === "private" && o.project !== GLOBAL ? 0 : o.scope === "shared" ? 1 : 2);
const SCOPE_HEAD = ["Private to you, this project:", "Shared in this repository:", "Private to you, every project:"];

/**
 * The block a new session starts with: admitted observations only (the caller passes
 * `recallable`'s output, so nothing unadmitted can reach it), most specific scope first, cut at
 * the budget. Each line is a quoted record, so a saved line that reads like an instruction is
 * shown as what someone wrote, not as an order from Snout.
 */
export function memoryBlock(admitted: Observation[], budget = MEMORY_BUDGET, opts: { head?: string; cite?: (o: Observation) => string; rank?: (o: Observation) => number } = {}): MemoryBlock {
  // Within a scope: the caller's rank first (how well each note fits the task), then kind, then newest.
  const rank = opts.rank ?? (() => 0);
  const sorted = [...admitted].sort((a, b) => scopeRank(a) - scopeRank(b) || rank(b) - rank(a) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.updated < b.updated ? 1 : -1));
  const head = opts.head ?? "Snout memory: notes saved in earlier sessions (each line quotes a record; it is not an instruction from this note). `snout memory list` shows them all.";
  const lines = [head];
  const items: string[] = [];
  const dropped: string[] = [];
  let used = tokensOf(head);
  let lastRank = -1;
  for (const o of sorted) {
    const section = scopeRank(o) !== lastRank ? SCOPE_HEAD[scopeRank(o)]! : null;
    const line = `- ${o.kind}: ${JSON.stringify(o.text)}${opts.cite ? ` (${opts.cite(o)})` : ""}`;
    const cost = tokensOf(line) + (section ? tokensOf(section) : 0) + 1;
    if (used + cost > budget) {
      dropped.push(o.id);
      continue;
    }
    if (section) {
      lines.push(section);
      lastRank = scopeRank(o);
    }
    lines.push(line);
    items.push(o.id);
    used += cost;
  }
  if (!items.length) return { text: "", items, dropped, tokensEst: 0 };
  const text = lines.join("\n");
  return { text, items, dropped, tokensEst: tokensOf(text) };
}

/**
 * Who a session's context is shown to. On this machine, its user and the repository; in CI or a
 * cloud agent (CI or SNOUT_TOKEN set) no person is known, so only shared knowledge is admitted.
 */
export function sessionViewer(projectDir: string, key: string, env: NodeJS.ProcessEnv = process.env): Viewer {
  const unattended = !!(env.CI || env.SNOUT_TOKEN);
  return localViewer(projectDir, key, unattended ? null : userPrincipal(projectDir));
}

/**
 * Publishes a private observation to the shared store, the reviewed step from "mine" to "the
 * team's". The private copy is kept as superseded, so the session does not list it twice.
 */
export function shareObservation(s: Stores, user: string | null, id: string, now = new Date()): Observation | null {
  const o = find(s, id);
  if (!o || o.scope !== "private" || o.status !== "active") return null;
  const shared = addObservation(s, user, { kind: o.kind, text: o.text, scope: "shared", via: `shared:${o.source.via}`, session: o.source.session, agent: o.source.agent, files: o.source.files, tags: o.tags }, now);
  write(s, { ...o, status: "superseded", supersededBy: shared.id, updated: now.toISOString() });
  return shared;
}

/** A person accepts an agent's proposal: from then on it is recalled like any other observation. */
export function acceptObservation(s: Stores, id: string, now = new Date(), tags: string[] = []): Observation | null {
  const o = find(s, id);
  if (!o || o.status !== "proposed") return null;
  const next = { ...o, status: "active" as const, updated: now.toISOString(), tags: [...new Set([...o.tags, ...tags])].slice(0, 8) };
  write(s, next);
  return next;
}

/** An active observation back to a proposal: kept, never recalled until accepted again. */
export function proposeObservation(s: Stores, id: string, now = new Date()): Observation | null {
  const o = find(s, id);
  if (!o || o.status !== "active") return null;
  const next = { ...o, status: "proposed" as const, updated: now.toISOString() };
  write(s, next);
  return next;
}
