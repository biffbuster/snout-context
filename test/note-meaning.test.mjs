// Meaning for automatic notes (src/memory/facts.ts, NOTE_MEANING): with the optional model, a prompt
// that no note fits on its rules may get the one verified note closest in meaning, at a high
// similarity only, and never on top of a note that fits, a left-off text, or an unverified note.
// A stand-in embedder (SNOUT_EMBED_FAKE=1: hashed words) replaces the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTE_MEANING, meaning, prepareMeaning, rankedFit } from "../dist/lib.mjs";

const note = (id, text, extra = {}) => ({ id, kind: "fact", text, tags: [], status: "active", scope: "private", project: "p", created: "2026-10-27T00:00:00.000Z", updated: "2026-10-27T00:00:00.000Z", source: { via: "manual", files: [], agent: null, session: null, ts: "2026-10-27T00:00:00.000Z" }, ...extra });
const dir = mkdtempSync(join(tmpdir(), "snout-note-meaning-"));
async function prepared(prompt, notes) {
  process.env.SNOUT_EMBED_FAKE = "1";
  try { await prepareMeaning(dir, prompt, notes.map((n) => n.text), true); } finally { delete process.env.SNOUT_EMBED_FAKE; }
}
const ids = (fit) => fit.map((f) => f.note.id);

test("no note fits on its rules: the closest note in meaning, only at NOTE_MEANING or more", async () => {
  // One shared word of two is weak on words; the stand-in puts "walrus" at cos 0.71 to "walrus quota".
  const close = note("o_close", "Walrus walrus.");
  const far = note("o_far", "Penguin parade.");
  await prepared("walrus quota", [close, far]);
  assert.ok(meaning("walrus quota", close.text) >= NOTE_MEANING);
  assert.deepEqual(ids(rankedFit("walrus quota", [close, far])), ["o_close"]);
  // Three words: the same note is at 0.58, under the bar: nothing.
  await prepared("walrus quota ledger", [close, far]);
  assert.ok(meaning("walrus quota ledger", close.text) < NOTE_MEANING);
  assert.deepEqual(ids(rankedFit("walrus quota ledger", [close, far])), []);
});

test("meaning never adds to a note that fits, to a left-off text, or an unverified note", async () => {
  const fits = note("o_fits", "Walrus quota rules apply.");
  const close = note("o_close2", "Walrus walrus.");
  await prepared("walrus quota", [fits, close]);
  assert.deepEqual(ids(rankedFit("walrus quota", [fits, close])), ["o_fits"]);
  await prepared("walrus quota", [close]);
  assert.deepEqual(ids(rankedFit("walrus quota", [close], { left: true })), [], "the prompt already gets where the last session left off");
  const lesson = note("o_lesson", "Walrus walrus.", { source: { via: "lesson", files: [], agent: "claude", session: null, ts: "2026-10-27T00:00:00.000Z" } });
  assert.deepEqual(ids(rankedFit("walrus quota", [lesson])), [], "an agent's lesson is not verified");
});

test("without the model's vectors, notes go by words alone", () => {
  assert.deepEqual(ids(rankedFit("narwhal quota", [note("o_n", "Narwhal narwhal.")])), []);
});
