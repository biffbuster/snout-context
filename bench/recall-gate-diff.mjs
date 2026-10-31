#!/usr/bin/env node
/**
 * Whether two Gate 3 runs gave the same outputs: every prompt, every path, in every set that has
 * both results files. Ids, session names, commit hashes and dates differ from run to run and are set aside.
 *
 *   node bench/recall-gate-diff.mjs <label-a> <label-b> [--sets main,unseen,...]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const i = process.argv.indexOf("--sets");
const SETS = i > 0 ? process.argv[i + 1].split(",") : ["main", "unseen", "unseen2", "unseen3", "unseen4", "unseen5", "unseen6", "unseen7", "unseen8", "unseen9", "unseen10", "unseen11", "unseen12"];
const norm = (t) => t.replace(/\b[0-9a-f]{7,40}\b/g, "SHA").replace(/o_[a-f0-9]{6,}/g, "o_ID").replace(/session:\S+/g, "session:ID").replace(/\b[a-z]\d*-[a-z0-9-]{6,}\b/g, "SESSION").replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, "DATE").replace(/\b\d+ (minutes?|hours?|days?) ago\b/g, "AGO");
let same = 0, total = 0;
const differ = [];
for (const set of SETS) {
  const dir = join(ROOT, "bench", "recall-gate", set === "main" ? "" : set);
  const fa = join(dir, `results-${a}.json`), fb = join(dir, `results-${b}.json`);
  if (!existsSync(fa) || !existsSync(fb)) continue;
  const ra = JSON.parse(readFileSync(fa, "utf8")), rb = JSON.parse(readFileSync(fb, "utf8"));
  for (const row of ra.rows) {
    const other = rb.rows.find((r) => r.id === row.id);
    for (const path of ["delivery", "recall", "search"]) {
      total++;
      if (other && norm(row.paths[path].text) === norm(other.paths[path].text)) same++;
      else differ.push(`${set}/${row.id}/${path}`);
    }
  }
}
console.log(`${a} vs ${b}: ${same} of ${total} outputs the same${differ.length ? `; differ: ${differ.join(" ")}` : ""}`);
process.exitCode = differ.length ? 1 : 0;
