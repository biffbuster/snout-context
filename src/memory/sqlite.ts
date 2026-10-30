/**
 * A local SQLite index of the memory records, one database per project on this machine, with an
 * FTS5 table for finding the records a question's words could match.
 *
 * The JSON files stay the record: a shared note has to stay a file to travel through git, and a
 * file a person edits or a pull brings in must count. So the index is only ever a copy, and
 * deleting it loses nothing. Each read brings it up to date first:
 *
 *   - each file is compared by modification time and size, and only the files that differ are
 *     read again; files that are gone are dropped;
 *   - a folder of many records (session records) is skipped while its own modification time is
 *     the one last seen: a stat instead of one per file. Adding, replacing or removing a file
 *     changes it; a file rewritten in place doesn't, so Snout's own writes mark the folder to be
 *     compared again (`folderChanged`), and a person's edit in place is seen once anything else
 *     in the folder changes, or at `snout memory reindex`;
 *   - a folder changed in the last two seconds is not trusted to be settled, so the next read
 *     compares its files again (a write in the same clock tick would otherwise go unseen).
 *
 * The database lives in the user's config folder, never in the repository, since it holds the
 * text of private notes. It is rebuilt from the files when it is missing, unreadable, or was
 * written by another schema version. Without node:sqlite (Node 20, or 22 before 22.13), or with
 * SNOUT_INDEX=off, callers get null and scan the files as before.
 *
 * The FTS body is each record's words in every form the scorer matches (retrieve.ts), so a
 * lookup there finds every record a scan would find on words. The scorer still decides.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Bumped whenever what a row holds changes (a parse rule, the FTS body): the index is rebuilt. */
export const SCHEMA = 4;
/** A folder changed more recently than this is compared file by file again on the next read. */
const SETTLE_MS = 2000;
const MISSING = -1;
/** Files indexed per committed transaction. */
const BATCH = 200;

/** What one kind of record looks like in the index. `parse`: the caller's own reader; null skips the file. */
export interface RecordKind<T> {
  name: "obs" | "card";
  parse: (raw: unknown) => T | null;
  /** The words the FTS body is built from (every form of each), and the text an exact search reads. */
  text: (r: T) => string;
  files: (r: T) => string[];
  updated: (r: T) => string;
  /** Has work worth picking up (cards): changed files, open to-dos or commits. */
  work?: (r: T) => boolean;
  /** Every form of every word, as the FTS body stores them. */
  forms: (text: string) => string[];
  /** Skip the folder while its modification time is unchanged (see above). Off: compare its files on every read. */
  trustFolderTime?: boolean;
}

export const indexFileFor = (configDir: string, snoutDir: string): string =>
  join(configDir, "index", `${createHash("sha256").update(resolve(snoutDir).toLowerCase()).digest("hex").slice(0, 24)}.sqlite`);

type Sqlite = typeof import("node:sqlite");
let sqlite: Sqlite | null | undefined;

/** node:sqlite, or null where this Node has none. Its "experimental" warning is not shown: a hook's stderr is the user's. */
function loadSqlite(): Sqlite | null {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/sqlite/i.test(text ?? "")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as Sqlite;
  } catch {
    sqlite = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

export const indexEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SNOUT_INDEX !== "off" && loadSqlite() !== null;

const open = new Map<string, DatabaseSync | null>();

const DDL = `
CREATE TABLE dirs (dir TEXT PRIMARY KEY, kind TEXT NOT NULL, mtime REAL);
CREATE TABLE files (path TEXT PRIMARY KEY, dir TEXT NOT NULL, name TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, ok INTEGER NOT NULL);
CREATE INDEX files_dir ON files (dir, name);
CREATE TABLE records (path TEXT PRIMARY KEY, dir TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, updated TEXT NOT NULL, text TEXT NOT NULL, plain TEXT NOT NULL, files TEXT NOT NULL, work INTEGER NOT NULL);
CREATE INDEX records_dir ON records (dir, name);
CREATE VIRTUAL TABLE words USING fts5 (path UNINDEXED, body, tokenize = "unicode61 tokenchars '_'");
`;
const DROP = "DROP TABLE IF EXISTS dirs; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS words;";

/** SQLite's codes for a file that isn't a sound database (CORRUPT, NOTADB): only then is it deleted. */
const damaged = (err: unknown): boolean => [11, 26].includes(((err as { errcode?: number } | null)?.errcode ?? -1) & 0xff);

function create(file: string): DatabaseSync {
  const { DatabaseSync } = loadSqlite()!;
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const version = () => (db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string } | undefined)?.v;
    if (version() !== String(SCHEMA)) {
      // New, or another version's tables: made again, empty, and filled from the files on the first read.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (version() !== String(SCHEMA)) {
          db.exec(DROP);
          db.exec(DDL);
          db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(String(SCHEMA));
        }
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
        throw err;
      }
    }
    return db;
  } catch (err) {
    try { db.close(); } catch { /* already unusable */ }
    throw err;
  }
}

function remove(file: string): void {
  // Windows refuses while another process has it open; then it stays, and this process reads the files.
  try { for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true }); } catch { /* left for the next rebuild */ }
}

/**
 * The open index at `file`, or null where there is none to be had: no node:sqlite, turned off, or
 * unusable now (another process holding it too long, a damaged file that couldn't be replaced).
 */
export function openIndex(file: string): DatabaseSync | null {
  if (!indexEnabled()) return null;
  if (open.has(file)) return open.get(file)!;
  let db: DatabaseSync | null = null;
  try {
    db = create(file);
  } catch (err) {
    // A damaged file (a torn copy, another program's file) is only a copy: replace it once.
    if (damaged(err)) {
      remove(file);
      try { db = create(file); } catch { db = null; }
    }
  }
  open.set(file, db);
  return db;
}

/** Closes the index in this process; the next read opens it again. */
export function closeIndex(file: string): void {
  const db = open.get(file);
  if (db) try { db.close(); } catch { /* closing a broken handle */ }
  open.delete(file);
}

/** Closes and deletes the index; the next read builds it again from the files. */
export function dropIndex(file: string): void {
  closeIndex(file);
  remove(file);
}

const mtimeOf = (path: string): number | null => {
  try { return statSync(path).mtimeMs; } catch { return null; }
};

/** Brings one folder's rows up to date with its files. Takes the write lock only when something differs. */
function sync<T>(db: DatabaseSync, dir: string, kind: RecordKind<T>): void {
  const seen = db.prepare("SELECT mtime FROM dirs WHERE dir = ?").get(dir) as { mtime: number | null } | undefined;
  const now = mtimeOf(dir);
  // A folder that isn't there (no shared notes yet) is recorded as -1, so reading it costs one stat.
  if (seen && seen.mtime === (now ?? MISSING) && (now === null || kind.trustFolderTime)) return;
  const known = new Map((db.prepare("SELECT name, mtime, size FROM files WHERE dir = ?").all(dir) as { name: string; mtime: number; size: number }[]).map((r) => [r.name, r]));
  let names: string[] = [];
  if (now !== null) try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { /* gone between the stat and the listing */ }
  const present = new Set(names);
  const gone = [...known.keys()].filter((n) => !present.has(n));
  const changed: { name: string; mtime: number; size: number }[] = [];
  for (const name of names) {
    let st;
    try { st = statSync(join(dir, name)); } catch { continue; }
    const k = known.get(name);
    if (!k || k.mtime !== st.mtimeMs || k.size !== st.size) changed.push({ name, mtime: st.mtimeMs, size: st.size });
  }
  // Trust the folder's time only once it has settled; until then, compare its files on each read.
  const settled = now === null || (Date.now() - now > SETTLE_MS && mtimeOf(dir) === now);
  const mark = settled ? (now ?? MISSING) : null;
  if (!gone.length && !changed.length && seen && seen.mtime === mark) return;
  const delRecord = db.prepare("DELETE FROM records WHERE path = ?");
  const delWords = db.prepare("DELETE FROM words WHERE path = ?");
  const delFile = db.prepare("DELETE FROM files WHERE path = ?");
  const putFile = db.prepare("INSERT OR REPLACE INTO files (path, dir, name, mtime, size, ok) VALUES (?, ?, ?, ?, ?, ?)");
  const putRecord = db.prepare("INSERT OR REPLACE INTO records (path, dir, name, json, updated, text, plain, files, work) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const putWords = db.prepare("INSERT INTO words (path, body) VALUES (?, ?)");
  // In batches, each committed: a hook stopped at its time limit mid-build keeps what it did, and
  // the next read goes on from there instead of starting over. The folder is marked current last.
  const batches: (() => void)[] = [() => {
    for (const name of gone) {
      const path = join(dir, name);
      delRecord.run(path); delWords.run(path); delFile.run(path);
    }
  }];
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH);
    batches.push(() => {
      for (const { name, mtime, size } of batch) {
        const path = join(dir, name);
        delRecord.run(path); delWords.run(path);
        let r: T | null = null;
        try { r = kind.parse(JSON.parse(readFileSync(path, "utf8"))); } catch { /* half-written or hand-broken: skipped, as a scan skips it */ }
        putFile.run(path, dir, name, mtime, size, r ? 1 : 0);
        if (!r) continue;
        const text = kind.text(r);
        const files = kind.files(r).map((f) => f.replace(/\\/g, "/").toLowerCase());
        putRecord.run(path, dir, name, JSON.stringify(r), kind.updated(r), text, plain(text), `\n${files.join("\n")}\n`, kind.work?.(r) ? 1 : 0);
        putWords.run(path, kind.forms(text).join(" "));
      }
    });
  }
  batches.push(() => db.prepare("INSERT OR REPLACE INTO dirs (dir, kind, mtime) VALUES (?, ?, ?)").run(dir, kind.name, mark));
  for (const run of batches) {
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* no transaction left to roll back */ }
      throw err;
    }
  }
}

/** After Snout writes a record in this folder: the next read compares its files, even if the folder's time didn't change. */
export function folderChanged(file: string | undefined, dir: string): void {
  if (!file || !indexEnabled()) return;
  const db = openIndex(file);
  if (!db) return;
  try { db.prepare("UPDATE dirs SET mtime = NULL WHERE dir = ?").run(dir); } catch (err) { if (damaged(err)) dropIndex(file); else closeIndex(file); }
}

/** Lowercase letters and digits, every other run a single space: what a claim is looked for in. */
export const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Runs `read` on an up-to-date index, or returns null when there is none (the caller scans the
 * files). A failure mid-read drops the index, which the next read rebuilds.
 */
function withIndex<R>(file: string | undefined, dirs: [string, RecordKind<any>][], read: (db: DatabaseSync) => R): R | null {
  if (!file) return null;
  const db = openIndex(file);
  if (!db) return null;
  try {
    for (const [dir, kind] of dirs) sync(db, dir, kind);
    return read(db);
  } catch (err) {
    // Damaged: rebuilt on the next read. Busy past the timeout, or anything else: this read scans the files.
    if (damaged(err)) dropIndex(file); else closeIndex(file);
    return null;
  }
}

/** Every record in a folder, in file-name order (as a listing gives them), or null without an index. */
export function indexedRecords<T>(file: string | undefined, dir: string, kind: RecordKind<T>): T[] | null {
  return withIndex(file, [[dir, kind]], (db) => (db.prepare("SELECT json FROM records WHERE dir = ? ORDER BY name").all(dir) as { json: string }[]).map((r) => JSON.parse(r.json) as T));
}

/** The newest records in a folder that have work worth picking up, newest first. */
export function latestWork<T>(file: string | undefined, dir: string, kind: RecordKind<T>, limit: number): T[] | null {
  return withIndex(file, [[dir, kind]], (db) => (db.prepare("SELECT json FROM records WHERE dir = ? AND work = 1 ORDER BY updated DESC, name LIMIT ?").all(dir, limit) as { json: string }[]).map((r) => JSON.parse(r.json) as T));
}

/** What a lookup asks for. A record is a candidate if it matches any one of these. */
export interface Lookup {
  /** Word forms: the record has one of them. */
  forms: string[];
  /** Exact text the record's text contains (code names). */
  contains: string[];
  /** Lowercased paths one of the record's files contains. */
  paths: string[];
  /** Plain text (see `plain`) the record's plain text contains. */
  plainContains: string[];
}

/** FTS5 query for any of these forms, each quoted (forms are letters, digits and underscores only). */
const anyOf = (forms: string[]) => [...new Set(forms)].filter((f) => /^[a-z0-9_]+$/.test(f)).map((f) => `"${f}"`).join(" OR ");

/**
 * The records in a folder that could match a lookup, in file-name order: a superset of what a scan
 * would find on words, code names, paths and claims, never fewer. Null without an index.
 */
export function candidates<T>(file: string | undefined, dir: string, kind: RecordKind<T>, q: Lookup): T[] | null {
  return withIndex(file, [[dir, kind]], (db) => {
    const paths = new Set<string>();
    const query = anyOf(q.forms);
    if (query) for (const r of db.prepare("SELECT path FROM words WHERE words MATCH ?").all(query) as { path: string }[]) paths.add(r.path);
    const scan = (column: "text" | "files" | "plain", needles: string[]) => {
      const stmt = db.prepare(`SELECT path FROM records WHERE dir = ? AND instr(${column}, ?) > 0`);
      for (const n of new Set(needles)) if (n) for (const r of stmt.all(dir, n) as { path: string }[]) paths.add(r.path);
    };
    scan("text", q.contains);
    scan("files", q.paths);
    scan("plain", q.plainContains);
    if (!paths.size) return [];
    const rows = db.prepare("SELECT path, json FROM records WHERE dir = ? ORDER BY name").all(dir) as { path: string; json: string }[];
    return rows.filter((r) => paths.has(r.path)).map((r) => JSON.parse(r.json) as T);
  });
}

/** What `snout doctor` and `snout memory reindex` report. */
export interface IndexStatus { file: string; available: boolean; records: number; bytes: number }

export function indexStatus(file: string): IndexStatus {
  const db = openIndex(file);
  if (!db) return { file, available: false, records: 0, bytes: 0 };
  let records = 0;
  try { records = (db.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n; } catch { /* reported as empty */ }
  let bytes = 0;
  for (const f of [file, `${file}-wal`]) try { bytes += statSync(f).size; } catch { /* not there */ }
  return { file, available: true, records, bytes };
}

/**
 * Rebuilds the index from the files in these folders now, and reports it. Rows are cleared, not the
 * file deleted, so it works while another process (the MCP server) has the index open.
 */
export function rebuildIndex(file: string, dirs: [string, RecordKind<any>][]): IndexStatus {
  const db = openIndex(file);
  if (db) {
    try {
      db.exec("BEGIN IMMEDIATE; DELETE FROM dirs; DELETE FROM files; DELETE FROM records; DELETE FROM words; COMMIT;");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
      dropIndex(file);
    }
  }
  withIndex(file, dirs, () => null);
  return indexStatus(file);
}
