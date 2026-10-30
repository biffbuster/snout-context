#!/usr/bin/env node
/**
 * Where each on-demand search miss failed (bench/ondemand-gate.mjs's "found"): for every search with
 * an answer whose first five lines hold no right record, one of
 *
 *   not captured     no record anywhere holds the right fact
 *   filtered         a record holds it, but search may not show it (a proposal, held back because
 *                    its file changed, replaced, or the claim is out of date)
 *   not a candidate  search may show it, but doesn't count it as a match: what it shares with the
 *                    query is listed
 *   below fifth      search matches it, and ranks it sixth or lower
 *
 * Reads each set's last replayed project (`~/.snout-bench/g3[-set]`, left by bench/recall-gate.mjs)
 * and the results of one labeled run. Read only; run it after the replay, not alongside it.
 *
 *   node bench/ondemand-diagnose.mjs --label <run label> [--sets unseen13,unseen14] [--out file.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const flag = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const LABEL = flag("--label");
if (!LABEL) { console.error("--label is required"); process.exit(2); }
const SETS = flag("--sets", "main,unseen,unseen2,unseen3,unseen4,unseen5,unseen6,unseen7,unseen8,unseen9,unseen10,unseen11,unseen12,unseen13,unseen14").split(",");
const FIRST = 5;
const lib = await import("../dist/lib.mjs");
const { listObservations, sessionViewer, storesFor, memorySearch, memoryFetch, readCards, terms, wordForms, variants } = lib;

const units = (text) => { const out = []; for (const l of text.split("\n")) { if (l.startsWith("- ")) out.push(l); else if (/^\s+\S/.test(l) && out.length) out[out.length - 1] += `\n${l}`; } return out; };
const idOf = (line) => /^- (o_[a-f0-9]{12}|session:\S+)/.exec(line)?.[1];

const rows = [];
for (const set of SETS) {
  const dir = join(ROOT, "bench", "recall-gate", set === "main" ? "" : set);
  const file = join(dir, `results-${LABEL}.json`);
  if (!existsSync(file)) continue;
  const result = JSON.parse(readFileSync(file, "utf8"));
  const history = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
  const re = Object.fromEntries(Object.entries(history.facts).map(([k, f]) => [k, new RegExp(f.pattern)]));
  const work = join(homedir(), ".snout-bench", set === "main" ? "g3" : `g3-${set}`);
  const project = join(work, history.project.name);
  const snoutDir = join(project, ".snout");
  process.env.SNOUT_CONFIG_DIR = join(work, "cfg");
  process.env.SNOUT_HOME = join(work, "home");
  const stores = storesFor(project, snoutDir, join(work, "cfg"));
  const ctx = { stores, snoutDir, projectDir: project, viewer: sessionViewer(project, stores.project), user: null, agent: "mcp", session: null };
  // Every record, in full as fetch opens it (notes of any status by their text).
  const records = [
    ...listObservations(stores).map((o) => ({ id: o.id, status: o.status, raw: o.text })),
    ...readCards(snoutDir).map((c) => ({ id: `session:${c.session}`, status: "session", raw: [c.task, c.request, c.outcome, ...c.changed, ...c.commits.map((k) => k.subject), c.test?.command].filter(Boolean).join(" ") })),
  ];
  const open = (id) => { try { return memoryFetch(ctx, id); } catch { return null; } };
  for (const row of result.rows) {
    const x = row.paths.search;
    if (!Array.isArray(x.expect)) continue;
    const isRight = (t) => x.expect.some((k) => re[k].test(t));
    const shown = x.shown ? units(x.text) : [];
    if (shown.slice(0, FIRST).some(isRight)) continue;
    const base = { set, id: row.id, query: row.query, prompt: row.prompt, expect: x.expect, first: shown[0]?.slice(0, 160) ?? null };
    const holders = records.filter((r) => isRight(r.raw));
    if (!holders.length) { rows.push({ ...base, cause: "not captured" }); continue; }
    // Showable holders: fetch opens them, and the fact survives as fetch shows it (outside "Out of date:" lines).
    const showable = holders.filter((r) => { const t = open(r.id); return t && (r.status === "session" || r.status === "active") && t.split("\n").some((l) => !l.startsWith("Out of date:") && isRight(l)); });
    if (!showable.length) { rows.push({ ...base, cause: "filtered", holders: holders.map((r) => `${r.id} (${r.status})`) }); continue; }
    const wide = memorySearch(ctx, row.query, 20);
    const total = Number(/^(\d+) of (\d+) match/.exec(wide)?.[2] ?? 0);
    const lines = units(wide);
    const rank = lines.findIndex((l) => showable.some((r) => r.id === idOf(l))) + 1;
    const q = [...new Set(terms(row.query))];
    const sharedWith = (r) => { const forms = wordForms(terms(r.raw)); return q.filter((w) => variants(w).some((v) => forms.has(v))); };
    const detail = showable.map((r) => ({ id: r.id, shares: sharedWith(r) }));
    if (rank) rows.push({ ...base, cause: "below fifth", rank, total, detail });
    else if (total > 20) rows.push({ ...base, cause: "below fifth", rank: ">20", total, detail });
    else rows.push({ ...base, cause: "not a candidate", total, detail });
  }
}
const out = flag("--out");
if (out) writeFileSync(out, JSON.stringify({ label: LABEL, rows }, null, 1) + "\n");
for (const cause of ["not captured", "filtered", "not a candidate", "below fifth"]) console.log(`${cause.padEnd(16)} ${rows.filter((r) => r.cause === cause).length}`);
for (const r of rows) console.log(`${r.set.padEnd(9)} ${r.id.padEnd(4)} ${r.cause.padEnd(15)} ${r.rank ? `#${r.rank} of ${r.total}` : ""} ${JSON.stringify(r.query)} ${r.detail ? r.detail.map((d) => `${d.id.slice(0, 22)} shares [${d.shares.join(" ")}]`).join("; ") : (r.holders ?? []).join(", ")}`);
