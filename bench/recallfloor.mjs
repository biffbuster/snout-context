#!/usr/bin/env node
/**
 * Where recall should stop firing: for the newest bench/ab-results/recalleval-*.json, each cut on
 * the top card's score with the share of tasks it still fires on, how often the brief then names a
 * gold file (precision), and the share of all hits it keeps. Scored twice: on the raw BM25 score,
 * which grows with the length of the prompt, and on that score per distinct prompt term.
 *
 *   node bench/recallfloor.mjs [rows.json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { terms } = await import(process.env.MAP_LIB || "../dist/lib.mjs");

const dir = fileURLToPath(new URL("ab-results", import.meta.url));
const file = process.argv[2] ?? join(dir, readdirSync(dir).filter((f) => /^recalleval-\d+\.json$/.test(f)).sort().pop());
// Older files keep the word ranker at the top level of each row, newer ones under `words`.
const rows = JSON.parse(readFileSync(file, "utf8")).rows.map((r) => (r.words ? { ...r, topScore: r.words.top, briefHit: r.words.briefHit } : { ...r, words: { agree: r.agree, briefHit: r.briefHit } }));

// The issue text isn't in the rows; per-term needs it, so it is read back from the dataset dump when given.
const perTerm = rows.every((r) => typeof r.queryTerms === "number");
const scores = {
  raw: (r) => r.topScore,
  ...(perTerm ? { "per term": (r) => r.topScore / Math.max(1, r.queryTerms) } : {}),
};
const hits = rows.filter((r) => r.briefHit).length;
const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`.padStart(7);

console.log(`${rows.length} tasks, ${hits} with a gold file in the brief (${pct(hits, rows.length).trim()})  ·  ${file}\n`);
for (const [name, f] of Object.entries(scores)) {
  const vals = rows.map(f).sort((a, b) => a - b);
  console.log(`score: ${name}\n  cut at       fires   precision   hits kept`);
  for (const q of [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const cut = vals[Math.floor(q * (vals.length - 1))];
    const on = rows.filter((r) => f(r) >= cut);
    const good = on.filter((r) => r.briefHit).length;
    console.log(`  ${cut.toFixed(2).padStart(8)}  ${pct(on.length, rows.length)}   ${pct(good, on.length)}     ${pct(good, hits)}`);
  }
  console.log("");
}
// What the hook ships: words checked against the repo map, and with the memory model, words and meaning
// fused (reciprocal rank) above the cut in src/memory/memory.ts, checked against the map.
const { HYBRID_CUT } = await import(process.env.MAP_LIB || "../dist/lib.mjs");
const gates = {
  ...(rows[0]?.words.agree !== undefined ? { "words, map agrees": (r) => r.words.agree } : {}),
  ...(rows[0]?.hybrid ? { [`words + meaning >= ${HYBRID_CUT}, map agrees`]: (r) => r.hybrid.agree && r.hybrid.top >= HYBRID_CUT } : {}),
};
console.log("shipped gates          fires   precision");
for (const [name, on] of Object.entries(gates)) {
  const kind = name.startsWith("words +") ? "hybrid" : "words";
  const fired = rows.filter(on);
  console.log(`  ${name.padEnd(36)} ${pct(fired.length, rows.length)}   ${pct(fired.filter((r) => r[kind].briefHit).length, fired.length)}`);
}
console.log("");
if (!perTerm) console.log(`(no queryTerms in the rows: rerun recalleval to score per term; terms() is ${typeof terms})`);
