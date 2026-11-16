#!/usr/bin/env node
/**
 * Free check for spec-benchmark.json: the left-off note each giver's prompt would give its receiver,
 * as the current build writes it (dist/lib.mjs, npm run build first). It must name the decision
 * (recordPattern) and leave out where the giver was told to stop (stopPhrasing), within 1,550 characters.
 * No session runs: the giver's record is made from its prompt, as Snout captures a first request.
 *
 *   node bench/benchmark-notes.mjs [--show]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = join(import.meta.dirname, "..");
const { leftOff } = await import(pathToFileURL(join(REPO, "dist/lib.mjs")).href);
const spec = JSON.parse(readFileSync(join(REPO, "bench/handoff/spec-benchmark.json"), "utf8"));
const show = process.argv.includes("--show");
const updated = "2026-11-12T18:00:00.000Z";
// The sentence of the giver's prompt that tells it where to stop. "I'll be back tomorrow for step 2" is not one:
// it tells a receiver step 2 is next, and receivers given it did step 2 (spec-leftoff.json, 2026-11-11).
const stopSentence = (prompt) => prompt.split(/(?<=[.!?])\s+/).filter((s) => /\bstop\b|step 2 (for tomorrow|yet)|\b(only|just) do step 1\b/i.test(s));
let bad = 0;
for (const d of spec.directions.filter((x) => !x.control)) {
  const changed = [`src/${d.grade.baseTests[0].replace(/^test\/|\.test\.js$/g, "")}.js`];
  const card = { v: 1, id: d.id, session: d.id, agent: "claude", started: updated, updated, changed, rules: [], commits: [], task: d.giverPrompt, request: d.giverPrompt.slice(0, 399) + "…" };
  const note = leftOff([card], { now: Date.parse(updated) + 3_600_000, dirty: new Set(changed), prompt: d.receiverPrompt });
  const problems = [];
  if (!note) problems.push("no note");
  if (note && !new RegExp(d.recordPattern, "i").test(note)) problems.push("the decision is missing");
  for (const s of stopSentence(d.giverPrompt)) if (note.includes(s)) problems.push(`the stop is quoted: "${s}"`);
  if (note.length > 1550) problems.push(`${note.length} characters`);
  bad += problems.length ? 1 : 0;
  console.log(`  ${problems.length ? "FAIL" : "ok  "} ${d.id} (${d.stopPhrasing}): ${problems.length ? problems.join("; ") : `decision kept, stop left out, ${note.length} characters`}`);
  if (show) console.log(note.replace(/^/gm, "       "));
}
if (bad) process.exit(1);
