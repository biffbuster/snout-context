#!/usr/bin/env node
/**
 * One diagnostic pass over Gate 3's misses: for each prompt a path got wrong, where it failed.
 *
 *   not captured     no record a path could show holds the right fact: a capture problem
 *   filtered         a record holds it, but it isn't one this path may show (proposed, held back,
 *                    replaced, out of date): the hard filters at work, right or wrong
 *   not a candidate  it may be shown, but it isn't in the top 20 by shared words, nor by the
 *                    optional local model's meaning: a retrieval problem
 *   not chosen       it is a top-20 candidate, but the path showed something else first, or nothing:
 *                    a selection problem, which an answerability judge would address
 *   false injection  a prompt with no answer got something
 *
 * Reads each set's last replayed project and config (`~/.snout-bench/g3[-set]`, left by
 * bench/recall-gate.mjs) and the results of one labeled run. Nothing is changed; no model is
 * downloaded. With the local model already at `--model-dir` (default ~/.snout-bench/model-cfg/model),
 * meaning ranks are added; without it, only words.
 *
 *   node bench/memory-diagnose.mjs [--label rc] [--out file.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const flag = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const LABEL = flag("--label", "rc");
const MODEL_DIR = flag("--model-dir", join(homedir(), ".snout-bench", "model-cfg", "model"));
const TOP = 20;
const SETS = ["", "unseen", "unseen2", "unseen3", "unseen4", "unseen5", "unseen6", "unseen7", "unseen8", "unseen9", "unseen10", "unseen11"];

const work = (set) => join(homedir(), ".snout-bench", set ? `g3-${set}` : "g3");
const lib = await import("../dist/lib.mjs");
const { listObservations, recallable, sessionViewer, storesFor, verified, heldBack, staleClaims, withoutStaleClaims, readCards, terms, wordForms, variants, cardIndex } = lib;

let embed = null;
if (existsSync(join(MODEL_DIR, "models"))) {
  try { embed = await lib.loadEmbedder(MODEL_DIR); } catch { embed = null; }
}

const cardText = (c) => [c.task, c.request, c.outcome, ...c.changed, ...c.commits.map((k) => k.subject), c.error?.line, c.test?.command, ...(c.missing ?? [])].filter(Boolean).join(" ");
const shared = (qWords, text) => { const forms = wordForms(terms(text)); return qWords.filter((w) => variants(w).some((v) => forms.has(v))).length; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const rows = [];
for (const set of SETS) {
  const dir = join(ROOT, "bench", "recall-gate", set);
  const history = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
  const result = JSON.parse(readFileSync(join(dir, `results-${LABEL}.json`), "utf8"));
  const re = Object.fromEntries(Object.entries(history.facts).map(([k, f]) => [k, new RegExp(f.pattern)]));
  const project = join(work(set), history.project.name);
  const snoutDir = join(project, ".snout");
  process.env.SNOUT_CONFIG_DIR = join(work(set), "cfg");
  const stores = storesFor(project, snoutDir, join(work(set), "cfg"));
  const viewer = sessionViewer(project, stores.project, {});
  const allNotes = listObservations(stores);
  const showable = recallable(stores, [viewer]).filter((o) => verified(o) && !heldBack(o, project));
  const claims = staleClaims(stores, project);
  const rawCards = readCards(snoutDir, cardIndex(snoutDir));
  const cards = rawCards.map((c) => withoutStaleClaims(c, claims));
  const pools = {
    delivery: showable.map((o) => ({ id: o.id, text: o.text })),
    recall: cards.map((c) => ({ id: `session:${c.session}`, text: cardText(c) })),
    search: [...showable.map((o) => ({ id: o.id, text: o.text })), ...cards.map((c) => ({ id: `session:${c.session}`, text: cardText(c) }))],
  };
  const everywhere = [...allNotes.map((o) => ({ id: o.id, text: o.text, status: o.status })), ...rawCards.map((c) => ({ id: `session:${c.session}`, text: cardText(c), status: "card" }))];
  const vectors = new Map();
  if (embed) {
    const texts = [...new Set(pools.search.map((r) => r.text))];
    const vs = await embed(texts);
    texts.forEach((t, i) => vectors.set(t, vs[i]));
  }
  for (const row of result.rows) {
    for (const path of ["delivery", "recall", "search"]) {
      const x = row.paths[path];
      if (x.answered !== false) continue;
      const question = path === "search" ? row.query : row.prompt;
      const base = { set: set || "main", id: row.id, path, question, expect: x.expect };
      if (x.expect === "silent") {
        const first = (x.text.split("\n").find((l) => /^- /.test(l)) ?? "").slice(0, 140);
        rows.push({ ...base, cause: "false injection", shown: first });
        continue;
      }
      const isRight = (text) => x.expect.some((k) => re[k].test(text));
      const pool = pools[path];
      const right = pool.filter((r) => isRight(r.text));
      if (!right.length) {
        const held = everywhere.filter((r) => isRight(r.text));
        rows.push({ ...base, cause: held.length ? "filtered" : "not captured", held: held.map((r) => `${r.id} (${r.status})`) });
        continue;
      }
      const q = [...new Set(terms(question))];
      const byWords = pool.map((r) => ({ r, n: shared(q, r.text) })).filter((s) => s.n > 0).sort((a, b) => b.n - a.n);
      const wordRank = byWords.findIndex((s) => isRight(s.r.text)) + 1 || null;
      let meaningRank = null;
      if (embed) {
        const [qv] = await embed([`${lib.QUERY_PREFIX}${question}`]);
        const byMeaning = pool.map((r) => ({ r, s: dot(qv, vectors.get(r.text) ?? qv) })).sort((a, b) => b.s - a.s);
        meaningRank = byMeaning.findIndex((s) => isRight(s.r.text)) + 1 || null;
      }
      const candidate = (wordRank && wordRank <= TOP) || (meaningRank && meaningRank <= TOP);
      rows.push({ ...base, cause: candidate ? "not chosen" : "not a candidate", wordRank, meaningRank, sharedWords: byWords.find((s) => isRight(s.r.text))?.n ?? 0, shown: x.shown ? "something else first" : "nothing" });
    }
  }
}
const out = flag("--out");
if (out) writeFileSync(out, JSON.stringify({ label: LABEL, model: !!embed, rows }, null, 1));
const count = (f) => rows.filter(f).length;
console.log(`${rows.length} misses (results-${LABEL}.json), local model ${embed ? "on" : "absent"}`);
for (const cause of ["not captured", "filtered", "not a candidate", "not chosen", "false injection"]) {
  const by = ["delivery", "recall", "search"].map((p) => `${p} ${count((r) => r.cause === cause && r.path === p)}`).join(", ");
  console.log(`  ${cause.padEnd(16)} ${String(count((r) => r.cause === cause)).padStart(3)}   (${by})`);
}
for (const r of rows) console.log(`${r.set.padEnd(8)} ${r.id} ${r.path.padEnd(8)} ${r.cause.padEnd(15)} ${r.wordRank !== undefined ? `words #${r.wordRank ?? "-"} (${r.sharedWords} shared) meaning #${r.meaningRank ?? "-"}` : r.held ? `held: ${r.held.join(", ").slice(0, 80)}` : r.shown ?? ""}  ${JSON.stringify(r.question).slice(0, 60)}`);
