#!/usr/bin/env node
/**
 * Gate 3 for on-demand memory (docs/memory-gates.md, "On-demand gate"): memory is what the agent asks
 * for, so the gate scores the set a search shows, not only its first line. It reads a run of
 * bench/recall-gate.mjs (its search outputs, `results-<label>.json`) and the project that run
 * replayed, and checks per set:
 *
 *   found    the right record among the first five a search shows, on at least 90% of the searches
 *            that have an answer
 *   silent   nothing shown on at least 90% of the searches that have none
 *   current  no stale, unsupported, uncited or other-folder fact in any search output
 *   fetch    every record a search showed opens with snout_memory_fetch, says where it came from,
 *            and states an out-of-date claim only as out of date
 *   budget   search outputs at most 250 tokens at the median and 600 at most (the default memory budget)
 *
 * Cited (part of "current"), checked here for every line search showed (added 2026-10-28, before
 * unseen 16 was written; until then the gate took Gate 3's per-runner text pattern, which needs a
 * pass count that `go test` never prints):
 *   - a session line names its session, agent and date;
 *   - a test-command note is traced to its record: the stored note says this command, its source
 *     names a session and agent, the line quotes the stored evidence ("<command> → <result line>")
 *     with that agent and date, the note's command is the run's command (selectors and a `cd`
 *     back to the root aside), and in the set's own history that session ran that command, printed
 *     that result line, and passed by bench/test-verdict.mjs, which reads each runner's success and
 *     failure lines over the whole output. Exit status is not recorded by the hooks, so the whole
 *     output stands for it;
 *   - a missing-tool note quotes the "command not found" it saw;
 *   - any other note says the person added, asked for or accepted it.
 *
 * An equivalent sourced answer counts as found (added 2026-10-28, before unseen 15 was written): a
 * set may list, for a search, other facts that answer the same question (`searchAlso` in
 * prompts.json). The set's author writes them with the set, before any run, and each must
 *   - answer the question as asked: the same what, when or why, not only a related fact (the test
 *     command answers "how do I run the tests", not "when did the tests start needing env access");
 *   - be a current fact of the set: the scorer refuses a stale or wrong-scope one;
 *   - be shown on a cited line, as every line must (current, above).
 * A set without `searchAlso` scores as before.
 *
 * The criteria and this file were frozen on 2026-10-27, before the fixes they test, and again on
 * 2026-10-28 with the equivalent-answer rule, before unseen 15 was written
 * (`bench/recall-gate/ondemand-freeze.json`); a run refuses to start if this file changed since.
 *
 *   node bench/ondemand-gate.mjs --freeze
 *   node bench/ondemand-gate.mjs --label <run label> [--sets unseen14,...] [--work-prefix g3]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runVerdict, squeeze } from "./test-verdict.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "bench/ondemand-gate.mjs";
const FROZEN = [SELF, "bench/test-verdict.mjs"];
const FREEZE = join(ROOT, "bench", "recall-gate", "ondemand-freeze.json");
const sha = (rel) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
const flag = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
if (process.argv.includes("--freeze")) {
  // Earlier freezes stay on record, so what each run was scored with is never lost.
  const prev = existsSync(FREEZE) ? JSON.parse(readFileSync(FREEZE, "utf8")) : null;
  const previous = prev ? [...(prev.previous ?? []), { frozenAt: prev.frozenAt, files: prev.files }] : [];
  writeFileSync(FREEZE, JSON.stringify({ frozenAt: new Date().toISOString(), files: Object.fromEntries(FROZEN.map((f) => [f, sha(f)])), previous }, null, 2) + "\n");
  console.log(`Frozen: ${FROZEN.join(", ")}`);
  process.exit(0);
}
const freeze = JSON.parse(readFileSync(FREEZE, "utf8"));
for (const f of FROZEN) if (freeze.files[f] !== sha(f)) { console.error(`${f} changed since its freeze on ${freeze.frozenAt}.`); process.exit(2); }

const LABEL = flag("--label");
if (!LABEL) { console.error("--label is required"); process.exit(2); }
const SETS = (flag("--sets", "main,unseen,unseen2,unseen3,unseen4,unseen5,unseen6,unseen7,unseen8,unseen9,unseen10,unseen11,unseen12,unseen13,unseen14")).split(",");
const PREFIX = flag("--work-prefix", "g3");
const CLI = join(ROOT, "dist", "snout.mjs");
const BAR = 0.9, MEDIAN_TOKENS = 250, MAX_TOKENS = 600, FIRST = 5;
const tokens = (t) => Math.ceil(Buffer.byteLength(t) / 4);
const lib = await import(pathToFileURL(join(ROOT, "dist", "lib.mjs")).href);
const TEST_LINE = /^- (o_[a-f0-9]{12})\s+command\s+\S+\s+Run the tests with: (.+?)\s+\(seen in a passing test run: ("(?:[^"\\]|\\.)*"); (claude|codex), (\d{4}-\d{2}-\d{2})\)\s*$/s;
const words = (cmd) => cmd.split(/\s+/).filter(Boolean);

/** Why a shown line is not cited, or null when it is (see "Cited" above). */
function uncitedWhy(line, notes, history) {
  if (/^- session:/.test(line)) return /^- session:\S+\s+(?:claude|codex)\s+\d{4}-\d{2}-\d{2}/.test(line) ? null : "session line without agent and date";
  if (!/^- o_[a-f0-9]{12}/.test(line)) return null;
  if (/Run the tests with/.test(line)) {
    const m = TEST_LINE.exec(line);
    if (!m) return "test command without its run";
    const [, id, shownCmd, quoteJson, agent, date] = m;
    const o = notes.get(id);
    if (!o || o.kind !== "command" || !o.tags.includes("test") || o.text !== `Run the tests with: ${shownCmd}`) return "no stored test-command note says this";
    const ev = o.source.evidence ?? "";
    const quote = JSON.parse(quoteJson);
    if (!(ev === quote || (quote.endsWith("…") && ev.startsWith(quote.slice(0, -1))))) return "quote is not the stored evidence";
    if (o.source.agent !== agent || (o.source.ts || o.created).slice(0, 10) !== date) return "agent or date is not the note's source";
    const at = ev.indexOf(" → ");
    if (at < 0) return "stored evidence has no result";
    const runCmd = ev.slice(0, at), result = ev.slice(at + 3);
    // A placeholder Snout writes for a narrowed selection (`go test <packages>`) stands for the run's own.
    if (!words(shownCmd).every((w) => /^<\w+>$/.test(w) || words(runCmd).includes(w))) return "the note's command is not the run's";
    const stepId = (o.source.session ?? "").split("-")[0].toUpperCase();
    const step = history.steps.find((st) => st.id === stepId);
    if (!step) return `source session ${o.source.session} is not in the set's history`;
    // A result kept from two lines reads "<line> · <line>": each must be in what the run printed.
    const ran = (step.calls ?? []).filter((c) => c.bash === runCmd && result.split(" · ").every((part) => squeeze(c.out ?? "").includes(squeeze(part))));
    if (!ran.length) return "the source session never printed that result for that command";
    const verdict = runVerdict(runCmd, ran.at(-1).out);
    return verdict === "pass" ? null : `the run ${verdict === "fail" ? "failed" : "shows no pass"}`;
  }
  if (/is not installed/.test(line)) return /command not found|is not recognized/.test(line) ? null : "missing tool without what it printed";
  return /added by you|accepted by you|asked by you|you asked|you said it in/.test(line) ? null : "no source";
}

const units = (text) => { const out = []; for (const l of text.split("\n")) { if (l.startsWith("- ")) out.push(l); else if (/^\s+\S/.test(l) && out.length) out[out.length - 1] += `\n${l}`; } return out; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

let allPass = true;
const report = [];
for (const set of SETS) {
  const dir = join(ROOT, "bench", "recall-gate", set === "main" ? "" : set);
  const file = join(dir, `results-${LABEL}.json`);
  if (!existsSync(file)) continue;
  const results = JSON.parse(readFileSync(file, "utf8"));
  const history = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
  const facts = Object.fromEntries(Object.entries(history.facts).map(([k, f]) => [k, { ...f, re: new RegExp(f.pattern) }]));
  const stale = Object.values(facts).filter((f) => f.class === "stale");
  const promptsFile = join(dir, "prompts.json");
  const also = new Map(existsSync(promptsFile) ? JSON.parse(readFileSync(promptsFile, "utf8")).prompts.filter((p) => p.searchAlso).map((p) => [p.id, p.searchAlso]) : []);
  for (const [id, keys] of also) for (const k of keys) if (facts[k]?.class !== "current") { console.error(`${set} ${id}: searchAlso ${k} is not a current fact of the set`); process.exit(2); }
  const work = join(homedir(), ".snout-bench", set === "main" ? PREFIX : `${PREFIX}-${set}`);
  const project = join(work, history.project.name);
  process.env.SNOUT_CONFIG_DIR = join(work, "cfg");
  process.env.SNOUT_HOME = join(work, "home");
  const notes = new Map(existsSync(project) ? lib.listObservations(lib.storesFor(project, join(project, ".snout"), join(work, "cfg"))).map((o) => [o.id, o]) : []);
  let found = 0, answerable = 0, silent = 0, unanswerable = 0;
  const missed = [], spoke = [], bad = [], sizes = [], ids = new Set();
  for (const row of results.rows) {
    const x = row.paths.search;
    const u = x.shown ? units(x.text) : [];
    if (x.shown) sizes.push(tokens(x.text));
    for (const b of x.bad) bad.push(`${row.id}: ${b.class} ${b.fact}`);
    for (const l of u) { const why = uncitedWhy(l, notes, history); if (why) bad.push(`${row.id}: uncited (${why}) ${l.split("\n")[0].slice(0, 80)}`); }
    for (const l of u) { const m = /^- (o_[a-f0-9]{12}|session:\S+)/.exec(l); if (m) ids.add(m[1]); }
    if (Array.isArray(x.expect)) {
      answerable++;
      const answers = [...x.expect, ...(also.get(row.id) ?? [])];
      if (u.slice(0, FIRST).some((l) => answers.some((k) => facts[k].re.test(l)))) found++;
      else missed.push(row.id);
    } else if (x.expect === "silent") {
      unanswerable++;
      if (!x.shown) silent++; else spoke.push(row.id);
    }
  }
  // Every record shown opens, with its source, and an out-of-date claim only as out of date.
  const fetchProblems = [];
  if (!existsSync(project)) fetchProblems.push(`the replayed project ${project} is missing`);
  else if (ids.size) {
    const input = [...ids].map((id, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "snout_memory_fetch", arguments: { id } } })).join("\n") + "\n";
    const env = { ...process.env, SNOUT_CONFIG_DIR: join(work, "cfg"), SNOUT_HOME: join(work, "home") };
    for (const k of ["SNOUT_DIR", "SNOUT_TOKEN", "CI"]) delete env[k];
    const r = spawnSync(process.execPath, [CLI, "mcp", project, "--tools", "snout_memory_fetch"], { cwd: project, input, encoding: "utf8", env, timeout: 60_000 });
    const replies = new Map(r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    [...ids].forEach((id, i) => {
      const m = replies.get(i + 1);
      const text = m?.result?.content?.[0]?.text ?? "";
      if (!m || m.result?.isError) return fetchProblems.push(`${id}: does not open (${text.slice(0, 80)})`);
      const sourced = id.startsWith("session:") ? /^session:\S+ · (?:claude|codex) · \d{4}-\d{2}-\d{2}/.test(text) : /saved \d{4}-\d{2}-\d{2} by .+\(/.test(text);
      if (!sourced) fetchProblems.push(`${id}: no source`);
      for (const line of text.split("\n")) if (stale.some((f) => f.re.test(line)) && !/^Out of date: /.test(line)) fetchProblems.push(`${id}: states an out-of-date claim as current`);
    });
  }
  const crit = [
    [`found: right record among the first ${FIRST} >= 90%`, !answerable || found / answerable >= BAR, `${found}/${answerable}${missed.length ? ` (missed ${missed.join(" ")})` : ""}`],
    ["silent: nothing shown with no answer >= 90%", !unanswerable || silent / unanswerable >= BAR, `${silent}/${unanswerable}${spoke.length ? ` (spoke on ${spoke.join(" ")})` : ""}`],
    ["current: no stale, unsupported, uncited or other-folder fact", !bad.length, bad.length ? bad.slice(0, 4).join("; ") : "none"],
    ["fetch: every record shown opens, with its source", !fetchProblems.length, fetchProblems.length ? fetchProblems.slice(0, 4).join("; ") : `${ids.size} records`],
    [`budget: median <= ${MEDIAN_TOKENS} tokens, max <= ${MAX_TOKENS}`, median(sizes) <= MEDIAN_TOKENS && Math.max(0, ...sizes) <= MAX_TOKENS, `median ${median(sizes)}, max ${Math.max(0, ...sizes)}`],
  ];
  const pass = crit.every((c) => c[1]);
  allPass &&= pass;
  report.push({ set, pass, found, answerable, missed, silent, unanswerable, spoke, bad, fetchProblems, records: ids.size, tokensMedian: median(sizes), tokensMax: Math.max(0, ...sizes), criteria: crit.map(([name, ok, detail]) => ({ name, ok, detail })) });
  console.log(`${set.padEnd(9)} ${pass ? "PASS" : "FAIL"}  ${crit.map(([n, ok, d]) => `${ok ? "" : "FAIL "}${n.split(":")[0]} ${d}`).join(" | ")}`);
}
const out = flag("--out");
if (out) writeFileSync(out, JSON.stringify({ label: LABEL, freeze, ranAt: new Date().toISOString(), pass: allPass, sets: report }, null, 1) + "\n");
process.exitCode = allPass ? 0 : 1;
