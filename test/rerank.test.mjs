// The answerability reranker (src/memory/rerank.ts): it only chooses among records a path may
// already show, overrides today's order only when sure, never adds a record when today's ranking
// found none, and changes nothing at all without its scores. A stand-in scorer
// (SNOUT_RERANK_FAKE=1: the share of the question's words a record has) replaces the model here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addObservation, FLOOR, localViewer, memorySearch, prepareRerank, rerankChoice, rerankedRecall, readCards, searchShortlist, shortlist, storesFor } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const ANA = "user:aaaaaaaaaaaaaaaa";

/** Scores with the stand-in: -10 + 14 × the share of the question's words a text has. */
async function scored(question, texts) {
  process.env.SNOUT_RERANK_FAKE = "1";
  try { await prepareRerank(question, texts); } finally { delete process.env.SNOUT_RERANK_FAKE; }
}
const items = (...texts) => texts.map((text) => ({ item: text, text }));

test("rerankChoice: overrides only when sure, keeps today's order otherwise, never fills an empty result", async () => {
  // Two-word questions: a record with both words scores 4 (sure), one word -3, none -10.
  const q1 = "flamingo ledger";
  await scored(q1, ["flamingo ledger rules", "flamingo pond", "unrelated text"]);
  assert.deepEqual(rerankChoice(q1, items("flamingo pond", "flamingo ledger rules"), 1), { mode: "override", item: "flamingo ledger rules" });
  assert.deepEqual(rerankChoice(q1, items("flamingo pond", "unrelated text"), 1), { mode: "keep" });
  // Nothing from today's ranking: nothing, even for a record the reranker is sure of (unseen 12 S03).
  assert.deepEqual(rerankChoice(q1, items("flamingo pond", "unrelated text"), 0), { mode: "none" });
  assert.deepEqual(rerankChoice(q1, items("flamingo ledger rules", "unrelated text"), 0), { mode: "none" });
  // A lone record is measured against the floor, not against no rival at all: sure, but not ahead.
  const q3 = "egret marsh";
  await scored(q3, ["egret marsh notes"]);
  assert.deepEqual(rerankChoice(q3, items("egret marsh notes"), 1), { mode: "override", item: "egret marsh notes" });
  assert.ok(FLOOR > -27 && 4 - FLOOR >= 4);
  // Without a score for every record, no verdict: the caller keeps today's ranking.
  assert.equal(rerankChoice("never prepared", items("flamingo pond"), 1), undefined);
  assert.equal(rerankChoice(q1, items("flamingo pond", "a text never scored"), 1), undefined);
  assert.deepEqual(rerankChoice(q1, [], 0), { mode: "none" });
});

test("shortlist: today's ranking first, then shared words, each record once, at most ten", () => {
  const ids = (xs) => xs.map((x) => x.id);
  const a = { id: "a" }, b = { id: "b" }, bCopy = { id: "b" }, c = { id: "c" };
  assert.deepEqual(ids(shortlist([a, b], [bCopy, c], (x) => x.id)), ["a", "b", "c"]);
  assert.equal(shortlist(Array.from({ length: 30 }, (_, i) => ({ id: `r${i}` })), [], (x) => x.id).length, 10);
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "snout-rerank-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-rerank-cfg-"));
  mkdirSync(join(root, ".snout", "memory"), { recursive: true });
  const snoutDir = join(root, ".snout");
  const stores = storesFor(root, snoutDir, cfg, "proj-rerank");
  const card = (session, fields) => writeFileSync(join(snoutDir, "memory", `${session}.json`), JSON.stringify({ v: 1, id: session, session, agent: "claude", started: new Date(Date.now() - 3600e3).toISOString(), updated: new Date(Date.now() - 1800e3).toISOString(), changed: [], rules: [], commits: [], ...fields }));
  return { root, cfg, snoutDir, stores, card };
}

test("search: a silent result stays silent with the reranker, and today's answer stands when it isn't sure of another", async () => {
  const p = project();
  p.card("s-otter", { task: "Add an otter census export", outcome: "The census export writes one row per otter." });
  p.card("s-kiln", { task: "Fix the kiln timer", outcome: "The kiln timer counts down in seconds." });
  addObservation(p.stores, ANA, { kind: "fact", text: "Pottery glazes are mixed on Fridays.", via: "manual" });
  const ctx = { stores: p.stores, snoutDir: p.snoutDir, projectDir: p.root, viewer: localViewer(p.root, p.stores.project, ANA), user: ANA };
  // One shared word of two, and only in the session's outcome (not its task): not shown on that alone.
  const query = "row spreadsheet";
  const before = memorySearch(ctx, query);
  assert.match(before, /^Nothing in memory matches/);
  // Nothing to rerank: the related session is not offered as the answer.
  assert.deepEqual(searchShortlist(ctx, query), []);
  await scored(query, ["Add an otter census export The census export writes one row per otter."]);
  assert.equal(memorySearch(ctx, query), before);
  // Both words: today's search finds the session, and the reranker keeps it first.
  const found = memorySearch(ctx, "census export");
  assert.match(found, /session:s-otter/);
  await scored("census export", searchShortlist(ctx, "census export"));
  assert.equal(memorySearch(ctx, "census export"), found);
});

test("recall: when recall finds nothing, the reranker adds nothing", async () => {
  const p = project();
  p.card("s-heron", { task: "Count herons at the north pond", outcome: "Heron counts are stored per pond." });
  p.card("s-gate", { task: "Repaint the gate", outcome: "The gate is green now." });
  const cards = readCards(p.snoutDir);
  const prompt = "heron surveys";
  assert.deepEqual(rerankedRecall(cards, prompt, { projectDir: p.root }), []);
  const { recallShortlist, embedText } = await import("../dist/lib.mjs");
  assert.deepEqual(recallShortlist(cards, prompt, { projectDir: p.root }), []);
  await scored(prompt, cards.map(embedText));
  assert.deepEqual(rerankedRecall(cards, prompt, { projectDir: p.root }), []);
});

test("reranker absent: search and recall answer as they always did, and say how to install it", () => {
  const p = project();
  p.card("s-otter", { task: "Add an otter census export", outcome: "The census export writes one row per otter." });
  const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { cwd: p.root, encoding: "utf8", env: { ...process.env, SNOUT_CONFIG_DIR: p.cfg, ...env }, windowsHide: true }).stdout;
  const empty = mkdtempSync(join(tmpdir(), "snout-rerank-none-"));
  for (const prompt of ["census export", "census spreadsheet"]) {
    assert.equal(run(["recall", prompt], { SNOUT_MEMORY_RERANK: "1", SNOUT_MODEL_DIR: empty }), run(["recall", prompt], { SNOUT_MEMORY_RERANK: "0" }));
  }
  assert.match(run(["memory", "reranker"], { SNOUT_MODEL_DIR: empty }), /No reranker\. .*\n.*snout memory reranker install/);
});
