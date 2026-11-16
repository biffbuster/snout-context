#!/usr/bin/env node
/**
 * A live run's results file, copied for docs/claims.md: bench/ab-results/<runId>.json, with this machine's
 * home folder written as ~, the user name as dev, and session and thread ids replaced by a short hash of
 * each (the same id gets the same hash in every file, so the receivers of one giver still match up).
 * Fails if anything of either is left.
 *
 *   node bench/publish-results.mjs bench/handoff/results-2026-11-16-benchmark.json [more files]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const user = basename(homedir());
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const u = esc(user);
// Separators as a results file holds them: / or \ escaped once or twice in JSON (\\ or \\\\).
const SEP = String.raw`(?:/|\\{1,4})`;
const RULES = [
  [new RegExp(String.raw`[A-Za-z]:${SEP}Users${SEP}${u}(?![\w-])`, "gi"), "~"],
  [new RegExp(String.raw`/[a-z]/Users/${u}(?![\w-])`, "gi"), "~"],
  [new RegExp(String.raw`[A-Za-z]--Users-${u}(?![\w])`, "gi"), "~"],
  [new RegExp(String.raw`Users-${u}(?![\w])`, "gi"), "~"],
  [new RegExp(String.raw`(?<![\w])${u}(?![\w])`, "gi"), "dev"],
];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const pseudonym = (id) => `id-${createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 12)}`;

for (const file of process.argv.slice(2)) {
  let text = readFileSync(file, "utf8");
  const { runId, fake } = JSON.parse(text);
  if (fake) throw new Error(`${file} is a dry run: only live results back a claim`);
  if (!/^[a-z]+(?:-[a-z]+)*-\d{13}$/.test(runId ?? "")) throw new Error(`${file}: no run id to name the copy by`);
  for (const [re, to] of RULES) text = text.replace(re, to);
  text = text.replace(UUID, pseudonym);
  const left = [...new Set([...(text.match(RULES.at(-1)[0]) ?? []), ...(text.match(UUID) ?? [])])];
  if (left.length) throw new Error(`${file}: still holds ${left.slice(0, 3).join(", ")}`);
  JSON.parse(text);
  const out = join(REPO, "bench", "ab-results", `${runId}.json`);
  writeFileSync(out, text);
  console.log(`${file} → bench/ab-results/${runId}.json`);
}
