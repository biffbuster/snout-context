#!/usr/bin/env node
/**
 * Sets the optional local model's thresholds (src/memory/retrieve.ts, MEANING_WITH_WORD and
 * MEANING_ALONE) from Gate 3 sets that have already been scored, never from one about to be.
 *
 *   node bench/recall-gate.mjs --set <s> --label <l>          first, so ~/.snout-bench/g3-<s> holds the replayed history
 *   SNOUT_CONFIG_DIR=~/.snout-bench/model-cfg node bench/semantic-calibrate.mjs --sets main,unseen,unseen2
 *
 * For every prompt and path, each record the path could show (delivery: verified, current notes;
 * recall: sessions; search: both) that words alone do not already make strong is labeled: right if
 * it holds one of the prompt's expected answers for that path, wrong otherwise. Prompts whose
 * expectation is "any" are skipped. Counting every other record as wrong keeps the thresholds high.
 * Each threshold is set just above the closest wrong record, so no wrong record in these sets
 * crosses it; the output says how many right ones do.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  embedText, evidence, heldBack, loadEmbedder, modelReady, parseQuery, QUERY_PREFIX, readCards, recallable, sessionViewer, storesFor, terms, verified, wordForms,
} from "../dist/lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const SETS = (arg("--sets") ?? "main,unseen,unseen2,unseen3,unseen4").split(",");
const MARGIN = 0.01;
if (!modelReady()) throw new Error("no model: set SNOUT_CONFIG_DIR to the folder `snout memory model install` used");
const embed = await loadEmbedder();

// The search tool's own words: filler dropped, nothing else (src/memory/tools.ts).
const FILLER = new Set("the and for are but not you all any can how what when where which who why does did our its this that with from have into here there now was were been".split(" "));
const searchWords = (t) => [...new Set((t.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !FILLER.has(w)))];
const cardSearchText = (c) => [c.task, c.request, c.outcome, ...c.changed, ...c.commits.map((x) => x.subject), c.error?.line, c.test?.command].filter(Boolean).join(" ");

const samples = []; // { set, id, path, words, cos, right, record }
for (const set of SETS) {
  const dir = join(ROOT, "bench", "recall-gate", ...(set === "main" ? [] : [set]));
  const history = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
  const { prompts } = JSON.parse(readFileSync(join(dir, "prompts.json"), "utf8"));
  const facts = Object.fromEntries(Object.entries(history.facts).map(([k, f]) => [k, new RegExp(f.pattern)]));
  const work = join(homedir(), ".snout-bench", set === "main" ? "g3" : `g3-${set}`);
  const projectDir = join(work, history.project.name);
  const stores = storesFor(projectDir, join(projectDir, ".snout"), join(work, "cfg"));
  const notes = recallable(stores, [sessionViewer(projectDir, stores.project)]).filter((o) => verified(o) && !heldBack(o, projectDir));
  const cards = readCards(join(projectDir, ".snout"));
  const noteRecs = notes.map((o) => ({ kind: "note", show: o.text, sem: o.text, files: o.source.files }));
  const cardRecs = cards.map((c) => ({ kind: "card", show: `${c.task ?? ""} ${c.outcome ?? ""} ${c.commits.map((k) => k.subject).join(" ")}`, sem: embedText(c), files: [...c.changed, ...c.commits.flatMap((k) => k.files)], search: cardSearchText(c) }));
  const recVec = new Map();
  const all = [...noteRecs, ...cardRecs];
  (await embed(all.map((r) => r.sem))).forEach((v, i) => recVec.set(all[i].sem, v));
  for (const p of prompts) {
    for (const path of ["delivery", "recall", "search"]) {
      const expect = p[path];
      if (expect === "any") continue;
      const question = path === "search" ? p.query : p.prompt;
      const [qv] = await embed([`${QUERY_PREFIX}${question}`]);
      const words = path === "search" ? searchWords(question) : terms(question);
      const q = parseQuery(question, words);
      const recs = path === "delivery" ? noteRecs : path === "recall" ? cardRecs : all;
      for (const r of recs) {
        const forms = wordForms(path === "search" ? searchWords(r.kind === "card" ? r.search : r.show) : terms(r.kind === "card" ? r.search : r.show));
        const e = evidence(q, { forms, text: r.show, files: r.files });
        const strongByWords = e.path || e.ident || e.words >= Math.min(2, Math.max(1, q.words.length));
        if (strongByWords) continue;
        const v = recVec.get(r.sem);
        let cos = 0;
        for (let i = 0; i < v.length; i++) cos += v[i] * qv[i];
        const right = Array.isArray(expect) && expect.some((k) => facts[k].test(r.kind === "card" ? r.search : r.show));
        samples.push({ set, id: p.id, path, words: e.words, cos: +cos.toFixed(4), right, record: r.show.slice(0, 70) });
      }
    }
  }
}

const pick = (group) => {
  const wrong = group.filter((s) => !s.right).map((s) => s.cos);
  const right = group.filter((s) => s.right).map((s) => s.cos);
  const t = +(Math.max(0, ...wrong) + MARGIN).toFixed(3);
  return { threshold: t, wrong: wrong.length, right: right.length, rightAbove: right.filter((c) => c >= t).length, closestWrong: group.filter((s) => !s.right).sort((a, b) => b.cos - a.cos).slice(0, 5), rightCos: group.filter((s) => s.right).sort((a, b) => b.cos - a.cos) };
};
const withWord = pick(samples.filter((s) => s.words > 0));
const alone = pick(samples.filter((s) => s.words === 0));
console.log(JSON.stringify({ sets: SETS, samples: samples.length, MEANING_WITH_WORD: withWord, MEANING_ALONE: alone }, null, 1));
if (arg("--dump")) (await import("node:fs")).writeFileSync(arg("--dump"), JSON.stringify(samples));
