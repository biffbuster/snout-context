#!/usr/bin/env node
/**
 * What the local SQLite index (src/memory/sqlite.ts) costs and saves in a project with many records.
 * Builds a scratch project with N session records and M notes, then times, with the index off
 * (every file read) and on:
 *
 *   search     snout_memory_search's function, in process, over a set of queries
 *   prompt     the prompt hook, as Claude Code runs it: a new session's first prompt (which also
 *              looks for where the last session left off) and a later prompt
 *   build      the first read after the index is deleted: every file read once
 *
 * Search results are compared both ways; any difference fails the run. Nothing calls a model or the
 * network, and nothing touches the user's own config: the run has its own.
 *
 *   node bench/memory-index-scale.mjs [--cards 2000] [--notes 120] [--runs 15]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const flag = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const CARDS = flag("--cards", 2000);
const NOTES = flag("--notes", 120);
const RUNS = flag("--runs", 15);
const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

const work = mkdtempSync(join(tmpdir(), "snout-index-scale-"));
const project = join(work, "project");
const cfg = join(work, "cfg");
mkdirSync(join(project, ".snout", "memory"), { recursive: true });
process.env.SNOUT_CONFIG_DIR = cfg;
const git = (...a) => spawnSync("git", a, { cwd: project, windowsHide: true });
git("init", "-q");
git("config", "user.email", "bench@example.com");
git("config", "user.name", "Bench");

const lib = await import("../dist/lib.mjs");
const { addObservation, closeIndex, dropIndex, listObservations, localViewer, memorySearch, readCards, storesFor, userPrincipal } = lib;

// A fixed pseudo-random stream, so every run builds the same project.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const WORDS = "billing invoice worker queue cache logging parser router session token upload image resize thumbnail export import report chart search index migration schema deploy staging build bundle lint format coverage timeout retry webhook stripe email template locale theme sidebar modal table pagination filter sort csv pdf auth login signup password reset profile avatar settings admin audit permission role team invite".split(" ");
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const file = () => `src/${pick(WORDS)}/${pick(WORDS)}.ts`;

for (let i = 0; i < CARDS; i++) {
  const session = `bench-${String(i).padStart(5, "0")}`;
  const day = new Date(Date.now() - (CARDS - i) * 3_600_000).toISOString();
  const changed = rand() < 0.6 ? [file(), file()] : [];
  writeFileSync(join(project, ".snout", "memory", `${session}.json`), JSON.stringify({
    v: 1, id: session, session, agent: rand() < 0.5 ? "claude" : "codex", started: day, updated: day, task: `Fix the ${sentence(6)}`,
    outcome: `${sentence(14)}. ${sentence(10)}.`, changed, rules: [], commits: rand() < 0.3 ? [{ sha: "abc1234def", subject: `Fix ${sentence(4)}`, ts: day, files: changed }] : [],
    ...(rand() < 0.2 ? { test: { command: "npm test", result: "12 passed" } } : {}),
  }, null, 1));
}
const stores = storesFor(project, join(project, ".snout"), cfg);
const user = userPrincipal(project);
for (let i = 0; i < NOTES; i++) addObservation(stores, user, { kind: pick(["convention", "gotcha", "fact"]), text: `Note ${i}: the ${sentence(8)}`, scope: i % 6 ? "private" : "shared", via: "manual" });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return { ms: Number(process.hrtime.bigint() - t) / 1e6, r }; };
const QUERIES = ["billing invoice", "where is the cache", "logging worker queue", "src/upload/image.ts", "deploy staging timeout", "coverage", "stripe webhook retry", "csv export report", "password reset email", "when was the schema migration changed"];
const ctx = { stores, snoutDir: join(project, ".snout"), projectDir: project, viewer: localViewer(project, stores.project, user), user };

const hook = (session, prompt, env) => {
  const input = JSON.stringify({ session_id: session, cwd: project, hook_event_name: "UserPromptSubmit", transcript_path: join(work, "t.jsonl"), prompt });
  return time(() => spawnSync(process.execPath, [CLI, "prompt-submit"], { cwd: project, input, encoding: "utf8", env: { ...process.env, SNOUT_MODE: "enforce", ...env }, windowsHide: true }));
};

const results = {};
const answers = {};
for (const mode of ["off", "on"]) {
  const env = mode === "off" ? { SNOUT_INDEX: "off" } : {};
  if (mode === "off") process.env.SNOUT_INDEX = "off"; else delete process.env.SNOUT_INDEX;
  const r = {};
  if (mode === "on") {
    dropIndex(stores.indexFile);
    r.buildMs = time(() => { readCards(ctx.snoutDir); listObservations(stores); }).ms;
    closeIndex(stores.indexFile);
  }
  answers[mode] = QUERIES.map((q) => memorySearch(ctx, q, 5));
  r.searchMs = median(QUERIES.flatMap((q) => Array.from({ length: 3 }, () => time(() => memorySearch(ctx, q, 5)).ms)));
  r.readCardsMs = median(Array.from({ length: 5 }, () => time(() => readCards(ctx.snoutDir)).ms));
  r.firstPromptMs = median(Array.from({ length: RUNS }, (_, i) => hook(`first-${mode}-${i}`, "continue where we left off on the billing worker", env).ms));
  const s = `later-${mode}`;
  hook(s, "look at the billing page", env);
  r.laterPromptMs = median(Array.from({ length: RUNS }, () => hook(s, "fix the invoice export in src/billing/invoice.ts", env).ms));
  results[mode] = r;
}
const same = answers.on.every((a, i) => a === answers.off[i]);
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
console.log(JSON.stringify({ cards: CARDS, notes: NOTES, runs: RUNS, node: process.version, searchSameBothWays: same, off: round(results.off), on: round(results.on) }, null, 1));
// Windows won't delete a database this process still has open.
closeIndex(stores.indexFile);
try { rmSync(work, { recursive: true, force: true }); } catch { console.error(`left ${work} behind`); }
if (!same) process.exit(1);
