// The local SQLite index (src/memory/sqlite.ts): a copy of the JSON records that answers exactly as
// the files do, catches changes made outside Snout, and is rebuilt when damaged or out of date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  addObservation, CARD_KIND, cardIndex, closeIndex, folderChanged, indexEnabled, indexStatus, listObservations, localViewer, memorySearch, OBS_KIND,
  readCards, rebuildIndex, storesFor, supersedeObservation, workCards,
} from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const ANA = "user:aaaaaaaaaaaaaaaa";
const sqliteHere = indexEnabled();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "snout-index-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-index-cfg-"));
  mkdirSync(join(root, ".snout", "memory"), { recursive: true });
  const snoutDir = join(root, ".snout");
  return { root, cfg, snoutDir, s: storesFor(root, snoutDir, cfg, "proj1") };
}

/** Runs `fn` with the index off (the files read directly) and on, and returns both answers. */
function bothWays(fn) {
  process.env.SNOUT_INDEX = "off";
  try { var off = fn(); } finally { delete process.env.SNOUT_INDEX; }
  return { off, on: fn() };
}

let n = 0;
function card(snoutDir, fields) {
  const session = fields.session ?? `s${String(++n).padStart(4, "0")}`;
  const c = { v: 1, id: session, session, agent: "claude", started: "2026-10-20T10:00:00.000Z", updated: "2026-10-20T11:00:00.000Z", changed: [], rules: [], commits: [], ...fields };
  writeFileSync(join(snoutDir, "memory", `${session}.json`), JSON.stringify(c, null, 1));
  return c;
}

const skip = sqliteHere ? false : "no node:sqlite on this Node";

test("the index holds exactly what the files hold, in the same order", { skip }, () => {
  const { snoutDir, s } = setup();
  for (let i = 0; i < 12; i++) addObservation(s, ANA, { kind: i % 2 ? "gotcha" : "convention", text: `Note ${i}: the cache lives in src/cache${i}.ts`, via: "manual", files: [`src/cache${i}.ts`] });
  addObservation(s, ANA, { kind: "fact", text: "Shared: deploys go through flyctl", scope: "shared", via: "manual" });
  for (let i = 0; i < 40; i++) card(snoutDir, { task: `Task ${i} on the billing page`, updated: `2026-10-${String(10 + (i % 15)).padStart(2, "0")}T10:00:00.000Z`, changed: i % 3 ? [`src/b${i}.ts`] : [] });
  writeFileSync(join(snoutDir, "memory", "broken.json"), "{ not json");
  writeFileSync(join(snoutDir, "memory", "preferences.json"), JSON.stringify([{ text: "a preference, not a card" }]));
  const obs = bothWays(() => listObservations(s));
  assert.equal(obs.on.length, 13);
  assert.deepEqual(obs.on, obs.off);
  const cards = bothWays(() => readCards(snoutDir));
  assert.equal(cards.on.length, 40, "the broken file and preferences.json are skipped, as a scan skips them");
  assert.deepEqual(cards.on, cards.off);
  const work = bothWays(() => workCards(snoutDir, 5));
  assert.deepEqual(work.on.map((c) => c.session), work.off.map((c) => c.session));
  assert.equal(indexStatus(s.indexFile).records, 13);
  assert.equal(indexStatus(cardIndex(snoutDir)).records, 40);
});

test("search answers the same with the index as by reading every record", { skip }, () => {
  const { root, snoutDir, s } = setup();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "money.js"), "export const toCents = (x) => Math.round(x * 100);\n");
  const old = addObservation(s, ANA, { kind: "convention", text: "Uploads keep their EXIF metadata until the nightly job strips it", via: "manual" });
  supersedeObservation(s, ANA, old.id, "Uploads have all EXIF metadata stripped in app/exif.py before storage");
  addObservation(s, ANA, { kind: "gotcha", text: "toCents rounds half away from zero; use it for every price", via: "manual", files: ["src/money.js"] });
  card(snoutDir, { task: "Fix logging in the worker", outcome: "Logs now rotate daily. The logger writes to var/log." });
  card(snoutDir, { task: "Price rounding bug", outcome: "Switched to toCents in src/money.js for all prices.", changed: ["src/money.js"] });
  card(snoutDir, { task: "Image uploads", outcome: "Uploads keep their EXIF metadata until the nightly job strips it. Done for now." });
  card(snoutDir, { task: "Coverage", outcome: "Moved coverage to c8 and set the threshold to 90.", test: { command: "npx c8 npm test", result: "41 passed" } });
  card(snoutDir, { task: "Login with 1password and get_item", outcome: "The vault helper get_item caches tokens." });
  card(snoutDir, { task: "Unrelated chore", outcome: "Bumped the README badges." });
  const ctx = { stores: s, snoutDir, projectDir: root, viewer: localViewer(root, s.project, ANA), user: ANA };
  const queries = ["logging", "where do logs go", "toCents", "src/money.js rounding", "money.js", "c8 coverage", "when was coverage changed", "exif metadata uploads",
    "what was replaced since", "out-of-date claim", "password", "get_item", "vault", "deploy staging", "README badges", "rotate"];
  for (const q of queries) {
    const r = bothWays(() => memorySearch(ctx, q, 10));
    assert.equal(r.on, r.off, `"${q}"`);
  }
  // The record that stated the replaced claim matches "replaced since" only through its marker: the
  // index finds it by the claim, not by the query's words, which its file never had.
  assert.match(memorySearch(ctx, "what was replaced since", 10), /session:s\d+ .*Image uploads/);
});

test("records added, changed or removed outside Snout are seen on the next read", { skip }, () => {
  const { snoutDir, s } = setup();
  const a = card(snoutDir, { task: "first" });
  assert.deepEqual(readCards(snoutDir).map((c) => c.task), ["first"]);
  card(snoutDir, { task: "pulled from a teammate" });
  assert.equal(readCards(snoutDir).length, 2, "a new file (a git pull) is seen");
  unlinkSync(join(snoutDir, "memory", `${a.session}.json`));
  assert.deepEqual(readCards(snoutDir).map((c) => c.task), ["pulled from a teammate"], "a removed file is dropped");
  const o = addObservation(s, ANA, { kind: "fact", text: "The API port is 8080", via: "manual" });
  assert.equal(listObservations(s)[0].text, "The API port is 8080");
  // A person edits the note in place: same folder time, so only the file's own time and size tell.
  const file = join(s.privateDir, `${o.id}.json`);
  writeFileSync(file, JSON.stringify({ ...o, text: "The API port is 9090, changed by hand" }, null, 1));
  assert.equal(listObservations(s)[0].text, "The API port is 9090, changed by hand", "notes are compared file by file on every read");
});

test("a session record rewritten in place is seen once Snout writes there, or at reindex", { skip }, () => {
  const { snoutDir } = setup();
  const dir = join(snoutDir, "memory");
  const c = card(snoutDir, { task: "before" });
  const past = new Date(Date.now() - 60_000);
  utimesSync(dir, past, past);
  assert.equal(readCards(snoutDir)[0].task, "before");
  // Settled: the folder's time is trusted. An in-place rewrite keeps it, as some editors do.
  writeFileSync(join(dir, `${c.session}.json`), JSON.stringify({ ...c, task: "after, edited in place" }, null, 1));
  utimesSync(dir, past, past);
  const missed = readCards(snoutDir)[0].task;
  folderChanged(cardIndex(snoutDir), dir);
  assert.equal(readCards(snoutDir)[0].task, "after, edited in place", `seen after a Snout write marks the folder (before it, the index said "${missed}")`);
  writeFileSync(join(dir, `${c.session}.json`), JSON.stringify({ ...c, task: "edited again" }, null, 1));
  utimesSync(dir, past, past);
  rebuildIndex(cardIndex(snoutDir), [[dir, CARD_KIND]]);
  assert.equal(readCards(snoutDir)[0].task, "edited again", "and reindex rebuilds from the files");
});

test("a damaged index, or one from another schema version, is rebuilt from the files", { skip }, () => {
  const { snoutDir, s } = setup();
  card(snoutDir, { task: "kept in the files" });
  addObservation(s, ANA, { kind: "fact", text: "Builds use esbuild", via: "manual" });
  assert.equal(readCards(snoutDir).length, 1);
  const file = cardIndex(snoutDir);
  closeIndex(file);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  writeFileSync(file, "this is not a database ".repeat(200));
  assert.deepEqual(readCards(snoutDir).map((c) => c.task), ["kept in the files"], "a damaged file is replaced, and nothing is lost");
  closeIndex(file);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("UPDATE meta SET v = '0' WHERE k = 'schema'; INSERT INTO records (path, dir, name, json, updated, text, plain, files, work) VALUES ('x', 'nowhere', 'x.json', '{}', '', '', '', '', 0);");
  db.close();
  assert.equal(readCards(snoutDir).length, 1);
  assert.equal(indexStatus(file).records, 1, "rows written by another version are dropped and rebuilt");
  assert.equal(listObservations(s).length, 1);
});

test("an index another process holds too long is read around, not deleted", { skip }, () => {
  const { snoutDir } = setup();
  card(snoutDir, { task: "indexed" });
  assert.equal(readCards(snoutDir).length, 1);
  card(snoutDir, { task: "new, needs the write lock to index" });
  const file = cardIndex(snoutDir);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const other = new DatabaseSync(file);
  other.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(readCards(snoutDir).length, 2, "after the busy timeout, this read takes the files");
    assert.ok(existsSync(file), "and the index is kept");
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
  assert.equal(readCards(snoutDir).length, 2);
  assert.equal(indexStatus(file).records, 2, "the next read brings the index up to date");
});

test("with SNOUT_INDEX=off memory reads the files and writes no index", () => {
  const { cfg, snoutDir, s } = setup();
  process.env.SNOUT_INDEX = "off";
  try {
    card(snoutDir, { task: "plain files" });
    addObservation(s, ANA, { kind: "fact", text: "Read straight from the files", via: "manual" });
    assert.equal(readCards(snoutDir, s.indexFile).length, 1);
    assert.equal(listObservations(s).length, 1);
    assert.ok(!existsSync(join(cfg, "index")), "no index folder");
  } finally {
    delete process.env.SNOUT_INDEX;
  }
});

test("the index lives in the user's config folder, never inside the project", { skip }, () => {
  const { root, cfg, snoutDir, s } = setup();
  addObservation(s, ANA, { kind: "fact", text: "A private note", via: "manual" });
  card(snoutDir, { task: "a session" });
  readCards(snoutDir, s.indexFile);
  assert.ok(s.indexFile.startsWith(cfg));
  assert.ok(readdirSync(join(cfg, "index")).some((f) => f.endsWith(".sqlite")));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [e.name]));
  assert.ok(!walk(root).some((f) => /\.sqlite/.test(f)), "no database file in the project");
});

test("snout memory reindex rebuilds from the files and says so", { skip }, () => {
  const { root, cfg, snoutDir } = setup();
  card(snoutDir, { task: "one" });
  card(snoutDir, { task: "two" });
  const r = spawnSync(process.execPath, [CLI, "memory", "reindex"], { cwd: root, encoding: "utf8", env: { ...process.env, SNOUT_CONFIG_DIR: cfg, SNOUT_DIR: snoutDir }, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Rebuilt the local index from the files: 2 records/);
  assert.equal(r.stderr, "", "no experimental-feature warning reaches the terminal");
  assert.deepEqual([OBS_KIND.name, CARD_KIND.name], ["obs", "card"]);
});
