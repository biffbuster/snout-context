// Gate 3 (docs/memory-gates.md): one regression test per failure the frozen baseline found
// (bench/recall-gate/results-baseline.json). The prompt ids in each test's name are the baseline's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addObservation, applyDistilled, cite, distillCard, factKey, sameTestPlace, testPlace, fittingNotes, installedFor, listObservations, recall, recallable, repoPrincipal,
  PASSED, replaceOlder, adjacent, nameForms, namesTopic, rankedFit as fitRanked, retireElsewhere, retireInstalled, retireOneOff, runsElsewhere, sessionFacts, sharedWords, closestInMeaning, memoryBlock, rankedFit, staleClaims, statesClaim, withoutStaleClaims, shareObservation, MEANING_ALONE, confidence, evidence, identsIn, namesFile, parseQuery, pathsIn, standing, storesFor, terms, testCommand, userPrincipal, variants, wordForms,
} from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const ANA = "user:aaaaaaaaaaaaaaaa";
const viewer = { principals: [ANA, repoPrincipal("proj1")] };
const card = (o = {}) => ({ v: 1, id: "c", session: "s1", agent: "claude", started: "", updated: "", changed: [], rules: [], commits: [], ...o });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "snout-g3-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-g3-cfg-"));
  mkdirSync(join(root, ".snout"));
  return { root, cfg, s: storesFor(root, join(root, ".snout"), cfg, "proj1") };
}

/** A git project with a user, for the hooks, the CLI and the MCP server. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "snout-g3-proj-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-g3-cfg-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  mkdirSync(join(root, ".snout"));
  const env = (extra = {}) => { const e = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root, SNOUT_MODE: "enforce", SNOUT_MEMORY_NOTES: "1", ...extra }; delete e.CI; delete e.SNOUT_TOKEN; return e; };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: env() }).stdout;
  const prompt = (text) => {
    const out = spawnSync(process.execPath, [CLI, "prompt-submit"], { cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, session_id: `p-${Math.random()}`, prompt: text }), env: env() }).stdout.trim();
    return out ? JSON.parse(out).hookSpecificOutput?.additionalContext ?? "" : "";
  };
  const mcp = (name, args) => {
    const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n";
    const r = spawnSync(process.execPath, [CLI, "mcp", root, "--tools", "snout_memory_index,snout_memory_search,snout_memory_fetch,snout_memory_save"], { cwd: root, input, encoding: "utf8", env: env(), timeout: 20_000 });
    return JSON.parse(r.stdout.trim()).result.content[0].text;
  };
  return { root, cfg, cli, prompt, mcp };
}

test("P01-P09: a test run in another folder is never saved as this project's test command", () => {
  for (const command of ["cd ../field-test && npm run test:smoke", "cd $SCRATCH && npm test", "cd /tmp/samples && npm test", "cd ~/scratch && pytest"]) {
    assert.equal(runsElsewhere(command), true, command);
    assert.deepEqual(distillCard(card({ test: { command, result: "ℹ pass 5" } })), [], command);
  }
  for (const command of ["npm test", "cd web && npm test", "cd ../.. && go test ./..."]) assert.equal(runsElsewhere(command), false, command);
  assert.equal(distillCard(card({ test: { command: "cd ../.. && go test ./...", result: "ok  x 1.2s" } }))[0].text, "Run the tests with: go test ./...", "a shell going back up from a subfolder is still this project");
  if (process.platform === "win32") {
    const root = mkdtempSync(join(tmpdir(), "snout-g3-msys-"));
    const msys = root.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/");
    assert.equal(testCommand(`cd ${msys} && npm test`, root), "npm test", "Git Bash's /c/... path to the project is the project");
  }
  // One saved before this rule is retired at session start.
  const { s } = setup();
  const old = addObservation(s, ANA, { kind: "command", text: "Run the tests with: cd $SCRATCH && npm test", tags: ["test"], via: "distill" });
  assert.deepEqual(retireElsewhere(s).map((o) => o.id), [old.id]);
});

test("P01-P10: a tool the project installs is not 'not installed', even when a bare call to it failed", () => {
  const { root, s } = setup();
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3.2.0" } }));
  const has = installedFor(root, () => false);
  assert.equal(has("vitest"), true, "a dependency in package.json");
  assert.equal(has("just"), false);
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".bin", "tsx"), "");
  assert.equal(has("tsx"), true, "a binary in node_modules/.bin");
  const saved = applyDistilled(s, ANA, card({ missing: ["vitest", "just"] }), new Date(), has);
  assert.deepEqual(saved.added.map((o) => o.text), ["just is not installed on this machine: don't call it, or install it first."]);
  const old = addObservation(s, ANA, { kind: "gotcha", text: "tsx is not installed on this machine: don't call it, or install it first.", tags: ["missing"], via: "distill" });
  assert.deepEqual(retireInstalled(s, has).map((o) => o.id), [old.id], "one saved before is retired at session start");
});

test("every note shown quotes the record behind it: the run's result, the tool's error, or the user's own action", () => {
  const notes = distillCard(card({ test: { command: "npx vitest run", result: "Tests 31 passed (31)" }, missing: ["just"], missingEvidence: { just: "just: command not found" } }));
  assert.equal(notes[0].evidence, "npx vitest run → Tests 31 passed (31)");
  const { s } = setup();
  const [t, j] = notes.map((n) => addObservation(s, ANA, n));
  assert.match(cite(t), /^seen in a passing test run: "npx vitest run → Tests 31 passed \(31\)"; claude, \d{4}-/);
  assert.match(cite(j), /^seen as "just: command not found"; claude, /);
  const asked = addObservation(s, ANA, { kind: "convention", text: "Money is kept in cents.", via: "mcp:user-asked", agent: "mcp" });
  assert.match(cite(asked), /^you asked for it; /, "baseline: \"saved from a session\"");
  const accepted = addObservation(s, ANA, { kind: "fact", text: "Staging needs the VPN.", via: "mcp:proposed", agent: "mcp" });
  assert.match(cite(accepted), /^accepted by you; /);
  // A replacement test command keeps its own session, agent and evidence (baseline: none of them).
  const next = applyDistilled(s, ANA, card({ session: "s2", agent: "codex", test: { command: "npm run verify", result: "ℹ pass 40" } }));
  assert.match(cite(next.added[0]), /^seen in a passing test run: "npm run verify → ℹ pass 40"; codex, /);
});

test("P16, P17: a decision that says it replaces an earlier one retires that one, in every path", () => {
  const { s } = setup();
  const iso = addObservation(s, ANA, { kind: "decision", text: "Dates are stored as UTC ISO 8601 strings.", via: "manual" });
  const other = addObservation(s, ANA, { kind: "decision", text: "Route handlers never throw.", via: "manual" });
  const epoch = addObservation(s, ANA, { kind: "decision", text: "Dates are now stored as Unix epoch milliseconds, no longer ISO strings.", via: "manual" }, new Date(Date.now() + 1000));
  assert.deepEqual(replaceOlder(s, epoch).map((o) => o.id), [iso.id]);
  assert.deepEqual(recallable(s, [viewer]).map((o) => o.id).sort(), [epoch.id, other.id].sort());
  assert.equal(listObservations(s).find((o) => o.id === iso.id).supersededBy, epoch.id);
  const plain = addObservation(s, ANA, { kind: "decision", text: "Invoices are now numbered per year.", via: "manual" });
  assert.deepEqual(replaceOlder(s, plain), [], "\"now\" alone, about something else, retires nothing");
  const p = project();
  p.cli("memory", "add", "Dates are stored as UTC ISO 8601 strings.", "--kind", "decision");
  assert.match(p.cli("memory", "add", "Dates are now stored as Unix epoch milliseconds, no longer ISO strings.", "--kind", "decision"), /It replaces o_[a-f0-9]{12}, now superseded: "Dates are stored as UTC ISO 8601 strings\."/);
  assert.doesNotMatch(p.prompt("How are dates stored?"), /UTC ISO/);
});

test("P28-P30: a note about a file that has changed since it was saved is held back until it is saved again", () => {
  const p = project();
  mkdirSync(join(p.root, "src"));
  writeFileSync(join(p.root, "src", "money.js"), "export const toCents = (n) => Math.round(n * 100);\n");
  assert.match(p.mcp("snout_memory_save", { text: "Money is kept as integer cents (toCents) in src/money.js.", kind: "convention", user_asked: true, files: ["src/money.js"] }), /until one of its files changes/);
  const ask = "Add a function to sum money amounts in src/money.js.";
  assert.match(p.prompt(ask), /integer cents \(toCents\)/, "unchanged: shown");
  writeFileSync(join(p.root, "src", "money.js"), "export const add = (a, b) => new Big(a).plus(b).toString();\n");
  assert.doesNotMatch(p.prompt(ask), /integer cents/, "the file changed: held back from the prompt");
  assert.doesNotMatch(p.mcp("snout_memory_search", { query: "money cents" }), /integer cents/, "and from search");
  assert.doesNotMatch(p.mcp("snout_memory_index", {}), /integer cents/, "and from the index");
  assert.match(p.cli("memory", "list"), /held back: its files changed since it was saved/, "the user sees why");
});

test("P11, P12, P17, P39: search cites each note, finds word forms, puts a named tool's note first, and ignores one shared word", () => {
  const p = project();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  writeFileSync(join(p.root, ".snout", "memory", "s2.json"), JSON.stringify({ v: 1, id: "s2", session: "s2", agent: "codex", started: "2026-10-20T10:00:00Z", updated: "2026-10-20T11:00:00Z", task: "Run the format check, then fix the CSV export", outcome: "just isn't installed here, so I ran npm run lint", changed: ["src/csv.js"], rules: [], commits: [{ sha: "abc1234", subject: "Quote commas in CSV export", ts: "2026-10-20T10:30:00Z", files: ["src/csv.js"] }] }));
  const stores = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  const user = userPrincipal(p.root);
  addObservation(stores, user, { kind: "gotcha", text: "just is not installed on this machine: don't call it, or install it first.", tags: ["missing"], via: "distill", evidence: "just: command not found" });
  addObservation(stores, user, { kind: "decision", text: "Dates are stored as Unix epoch milliseconds.", via: "manual" });
  const justFormat = p.mcp("snout_memory_search", { query: "just format" });
  assert.match(justFormat.split("\n")[1], /^- o_[a-f0-9]{12}\s+gotcha .*just is not installed.*\(seen as "just: command not found"; /, "the note first, with its record");
  assert.match(justFormat, /session:s2 .*committed "Quote commas in CSV export"/, "a session record says what it committed");
  assert.match(p.mcp("snout_memory_search", { query: "date storage" }), /epoch milliseconds.*\(added by you; /, "stems: \"date storage\" finds \"Dates are stored\"");
  assert.match(p.mcp("snout_memory_search", { query: "pnpm install" }), /^Nothing in memory matches/, "one shared word (installed) is not a match, and a missing-tool note needs its tool named");
});

test("P33: recall does not match on a question word; sessions that changed a named file come newest first", () => {
  const c = (session, updated, task, changed = []) => card({ id: session, session, updated, started: updated, task, changed });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const cov = c("cov", "2026-10-26T10:00:00Z", "Why is the coverage report empty?", ["vitest.config.js"]);
  assert.deepEqual(recall([cov], "Why does the PDF invoice renderer crash on empty orders?", { now }), [], "\"why\" and \"empty\" are one real word");
  const old = c("old", "2026-10-26T09:00:00Z", "Add a test for parsing negative amounts in src/money.js", ["src/money.js", "test/money.test.js"]);
  const mid = c("mid", "2026-10-26T10:00:00Z", "Fix the rounding of half cents in src/money.js", ["src/money.js"]);
  const cur = c("cur", "2026-10-26T11:00:00Z", "Store money as decimal strings with big.js", ["src/money.js"]);
  assert.deepEqual(recall([old, mid, cur], "How is money represented in src/money.js now?", { now }).map((h) => h.card.session), ["cur", "mid", "old"]);
});

test("P18, P20: a note fits a prompt that shares its words in any form, and a note about commits fits a task that commits", () => {
  const { s } = setup();
  const dates = addObservation(s, ANA, { kind: "decision", text: "Dates are now stored as Unix epoch milliseconds.", via: "manual" });
  const commits = addObservation(s, ANA, { kind: "preference", text: "Always write commit messages in the conventional style, like fix: or feat:.", tags: ["rule", "repeated"], via: "distill" });
  assert.deepEqual(fittingNotes("Store the created date on new items.", [dates, commits]).map((o) => o.id), [dates.id]);
  assert.deepEqual(fittingNotes("Commit the pagination change.", [dates, commits]).map((o) => o.id), [commits.id]);
  assert.deepEqual(fittingNotes("Rename the heading in the README.", [dates, commits]), []);
});

test("rule 3: where the last session left off and the notes share one budget", () => {
  const p = project();
  writeFileSync(join(p.root, ".snout", "config.json"), JSON.stringify({ memoryBudget: 260 }));
  mkdirSync(join(p.root, "src"));
  writeFileSync(join(p.root, "src", "routes.js"), "export const listItems = () => [];\n"); // uncommitted: unfinished work
  const now = new Date().toISOString();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  writeFileSync(join(p.root, ".snout", "memory", "s14.json"), JSON.stringify({ v: 1, id: "s14", session: "s14", agent: "claude", started: now, updated: now, task: "Add pagination to the list route in src/routes.js with page and limit parameters.", outcome: "listItems takes page and limit. Still to do: a test for page=0, which should be rejected. Not committed yet.", changed: ["src/routes.js"], open: ["Add a test for page=0"], rules: [], commits: [] }));
  for (let i = 0; i < 6; i++) p.cli("memory", "add", `Continue rule ${i}: when you continue earlier work, re-read the session notes for step ${i} first.`, "--kind", "convention");
  const ctx = p.prompt("Continue where the last session left off.");
  assert.match(ctx, /where the last session in this repo left off/);
  assert.ok(Math.ceil(Buffer.byteLength(ctx) / 4) <= 260 + 5, `within the one budget, got ~${Math.ceil(Buffer.byteLength(ctx) / 4)} tokens`);
  const row = readFileSync(join(p.root, ".snout", "recall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.ok(row.dropped.length > 0, "notes that didn't fit are dropped, not added on top");
});

// ---------- Round 2: the final run's failures ----------

test("P01, P02, P05, P08, P09 (round 2): a task request said in two sessions stays a proposal; one worded as lasting is kept", () => {
  const { s } = setup();
  const seen = () => recallable(s, [viewer]).map((o) => o.text);
  for (const session of ["s1", "s2"]) applyDistilled(s, ANA, card({ session, rules: ["Run the tests and fix it.", "Never edit generated files."] }));
  assert.deepEqual(seen(), ["Never edit generated files."], "\"never\" makes it lasting; the task request stays a proposal");
  assert.equal(standing("Please run the linter and fix what it finds."), false);
  assert.equal(standing("Always write commit messages in the conventional style."), true);
  assert.equal(standing("Use tabs in this project."), true);
  // Promoted before this rule: back to a proposal at session start, unless the user accepted it.
  const old = addObservation(s, ANA, { kind: "preference", text: "Run the linter and fix what it finds.", tags: ["rule", "repeated"], via: "distill", status: "active" });
  const mine = addObservation(s, ANA, { kind: "preference", text: "Squash before merging.", tags: ["rule", "accepted"], via: "distill", status: "active" });
  assert.deepEqual(retireOneOff(s).map((o) => [o.id, o.status]), [[old.id, "proposed"]]);
  assert.ok(seen().includes("Squash before merging."), "what the user accepted stays");
  assert.match(cite(mine), /^accepted by you; /);
  assert.deepEqual(fittingNotes("Squash and merge the branch.", [mine]).map((o) => o.id), [mine.id], "an accepted instruction is verified");
});

test("P24, P27, P28, P30 (round 2): search weighs the question, not the kind of record", () => {
  const p = project();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  const at = (h) => `2026-10-2${h}T10:00:00Z`;
  const save = (id, h, task, extra = {}) => writeFileSync(join(p.root, ".snout", "memory", `${id}.json`), JSON.stringify({ v: 1, id, session: id, agent: "claude", started: at(h), updated: at(h), task, changed: [], rules: [], commits: [], ...extra }));
  save("vt", 1, "Switch the test runner to vitest", { commits: [{ sha: "a1", subject: "Move tests to vitest", ts: at(1), files: ["package.json"] }], test: { command: "npx vitest run", result: "Tests 31 passed (31)" } });
  save("pg", 2, "Add pagination to the list route in src/routes.js", { changed: ["src/routes.js"] });
  save("m1", 3, "Parse negative money amounts", { changed: ["src/money.js"] });
  save("m2", 4, "Store money as decimal strings with big.js", { changed: ["src/money.js"] });
  const stores = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  const user = userPrincipal(p.root);
  addObservation(stores, user, { kind: "command", text: "Run the tests with: npx vitest run", tags: ["test"], via: "distill", evidence: "Tests 31 passed (31)" });
  addObservation(stores, user, { kind: "decision", text: "Route handlers never throw.", via: "manual" });
  const first = (query) => p.mcp("snout_memory_search", { query }).split("\n")[1] ?? "";
  assert.match(first("move tests vitest"), /session:vt .*Move tests to vitest/, "a question about a change gets the session that made it, not today's command");
  assert.match(first("npm test"), /Run the tests with: npx vitest run/, "a question about running tests gets the test command");
  assert.match(first("pagination routes"), /session:pg/, "the record that matches both words beats a note that matches one");
  // Round 3 asserted silence here: one shared word was all there was. Round 11 counts a word that names
  // a file a record changed (src/money.js) as naming that record, so the money sessions answer, newest first.
  assert.match(first("money representation"), /session:m2 .*Store money as decimal strings/, "a word naming the file both sessions changed");
  assert.match(p.mcp("snout_memory_search", { query: "parser speed" }), /^Nothing in memory matches/, "a word no two records share is not a match");
});

// ---------- Round 3: the first unseen check's failures ----------

test("unseen Q12, Q14 (round 3): word forms match variants of the same word, never a different shorter word", () => {
  const match = (a, b) => sharedWords(terms(a), wordForms(terms(b))) > 0;
  for (const [a, b] of [["logging", "logs"], ["stored", "store"], ["storage", "stored"], ["dates", "date"], ["created", "create"], ["routes", "routing"], ["boxes", "box"], ["retries", "retry"], ["caching", "cached"]]) assert.ok(match(a, b), `${a} ~ ${b}`);
  for (const [a, b] of [["theme", "them"], ["plane", "plan"], ["notes", "nothing"], ["install", "instal"], ["passes", "pas"]]) assert.ok(!match(a, b), `${a} !~ ${b}`);
  assert.ok(!variants("theme").includes("them"));
  const { s } = setup();
  const secrets = addObservation(s, ANA, { kind: "preference", text: "Never print secrets in logs.", tags: ["rule", "repeated"], via: "distill" });
  assert.deepEqual(fittingNotes("Add logging to the print step.", [secrets]).map((o) => o.id), [secrets.id], "logging/logs and print: two words");
  const report = addObservation(s, ANA, { kind: "convention", text: "Send them the weekly report as a PDF.", via: "manual" });
  assert.deepEqual(fittingNotes("Change the theme colors for the weekly dashboard.", [report]), [], "theme is not them; weekly alone is one word");
});

test("unseen Q05, Q14 (round 3): search shows nothing when the question shares too little with any record", () => {
  const p = project();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  const save = (id, task, outcome) => writeFileSync(join(p.root, ".snout", "memory", `${id}.json`), JSON.stringify({ v: 1, id, session: id, agent: "claude", started: "2026-10-26T10:00:00Z", updated: "2026-10-26T10:00:00Z", task, outcome, changed: [], rules: [], commits: [] }));
  save("a", "Remember that export files open in Excel.", "Excel opens them correctly now.");
  save("b", "Make saves atomic.", "It writes a temp file and renames them.");
  const stores = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  addObservation(stores, userPrincipal(p.root), { kind: "decision", text: "Config lives in app.toml in the project root.", via: "manual" });
  const none = /^Nothing in memory matches/;
  assert.match(p.mcp("snout_memory_search", { query: "config file location" }), none, "\"file\" in two sessions and \"config\" in one note: one word each, out of three");
  assert.match(p.mcp("snout_memory_search", { query: "dark theme tui" }), none, "\"theme\" is not \"them\"");
  assert.match(p.mcp("snout_memory_search", { query: "export excel" }), /session:a/, "two words: found");
  assert.match(p.mcp("snout_memory_search", { query: "config location" }), /app\.toml/, "a verified note may answer a two-word question on one word");
});

test("unseen Q01-Q03, Q09 (round 3): a passing tox or unittest run is cited with its command and its count, and a failing one stays failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-g3-tox-"));
  const facts = (command, out) => {
    const file = join(dir, `${Math.random()}.jsonl`);
    writeFileSync(file, [
      { type: "user", message: { content: "Run the tests." } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: out }] } },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n");
    return sessionFacts(file, dir).test;
  };
  const tox = facts("tox -q", "..............   [100%]\n14 passed in 0.52s\n  py312: OK (3.21 seconds)\n  congratulations :) (3.30 seconds)\n");
  assert.equal(tox.result, "14 passed in 0.52s · py312: OK (3.21 seconds)");
  const [note] = distillCard(card({ test: tox }));
  assert.equal(note.evidence, "tox -q → 14 passed in 0.52s · py312: OK (3.21 seconds)");
  const unittest = facts("python -m unittest", "......\n------\nRan 6 tests in 0.004s\n\nOK\n");
  assert.equal(unittest.result, "Ran 6 tests in 0.004s · OK");
  const failed = facts("python -m unittest", "..F...\n------\nRan 6 tests in 0.004s\n\nFAILED (failures=1)\n");
  assert.equal(failed.result, "Ran 6 tests in 0.004s · FAILED (failures=1)");
  assert.deepEqual(distillCard(card({ test: failed })), [], "a failing run is still not how to run the tests");
  assert.equal(facts("npx vitest run", " Test Files  4 passed (4)\n      Tests  31 passed (31)\n").result, "Tests 31 passed (31)", "a verdict with its own count is kept as it was");
});

// ---------- Round 4: the second unseen check's failures ----------

test("unseen R01, R02, R09 (round 4): a passing run that prints \"0 failed\" passed; any nonzero failure did not", () => {
  const passing = ["test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out", "ok | 12 passed | 0 failed (45ms)", "Tests: 0 failed, 42 passed, 42 total", "14 passed in 0.52s", "ℹ pass 7"];
  const failing = ["test result: FAILED. 25 passed; 1 failed; 0 ignored", "FAILED | 11 passed | 1 failed (50ms)", "Tests: 10 failed, 32 passed, 42 total", "Tests: 1 failed, 41 passed", "2 failed, 12 passed in 0.6s", "Ran 6 tests in 0.004s · FAILED (failures=1)", "Some tests failed · 3 passed"];
  for (const v of passing) assert.equal(PASSED(v), true, v);
  for (const v of failing) assert.equal(PASSED(v), false, v);
  const [note] = distillCard(card({ test: { command: "cargo test", result: passing[0] } }));
  assert.equal(note?.text, "Run the tests with: cargo test", "a passing cargo run is how the tests run here");
});


// ---------- Round 5: one way to judge evidence, for all three paths ----------

test("round 5: one shared word never reaches an unasked prompt; a search may still offer it", () => {
  const { s } = setup();
  const header = addObservation(s, ANA, { kind: "decision", text: "Every API response now includes an X-Trace-Id header.", via: "manual" });
  const bodies = addObservation(s, ANA, { kind: "preference", text: "Never log request bodies; they can hold passwords.", tags: ["rule", "repeated"], via: "distill" });
  for (const prompt of ["Add a header image to the landing page.", "Add logging for failed logins.", "Write a haiku about ledgers."]) assert.deepEqual(fittingNotes(prompt, [header, bodies]), [], prompt);
  assert.deepEqual(fittingNotes("Which header carries the trace id?", [header, bodies]).map((o) => o.id), [header.id], "two words: strong");
  const q = parseQuery("header image", ["header", "image"]);
  assert.equal(confidence(q, evidence(q, { forms: wordForms(terms(header.text)), text: header.text, files: [] })), "weak");
});

test("unseen R04, Q03 (round 5): a tool the project's own toolchain provides is not 'not installed'", () => {
  const { root } = setup();
  writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "inkwell"\n\n[project.optional-dependencies]\ndev = ["pytest>=8", "flake8"]\n\n[tool.ruff]\nline-length = 100\n');
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "ferry"\n');
  writeFileSync(join(root, "requirements-dev.txt"), "black==24.1.0\n");
  const has = installedFor(root, () => false);
  for (const t of ["pytest", "flake8", "black", "rustfmt", "cargo-clippy"]) assert.equal(has(t), true, t);
  for (const t of ["ruff", "make", "deployctl", "inkwell2"]) assert.equal(has(t), false, `${t}: a [tool.ruff] section or another name is not a dependency`);
  const bare = setup().root;
  assert.equal(installedFor(bare, () => false)("rustfmt"), false, "no Cargo.toml: rustfmt really is missing");
});

test("unseen V08 (round 5): a path with a folder names that file only; a bare file name names any file so called", () => {
  assert.deepEqual(pathsIn("Is the cache still in cache/users.ts? See ./README.md and money.js"), ["cache/users.ts", "readme.md", "money.js"]);
  const p = pathsIn("Is the user lookup still cached in cache/users.ts?");
  assert.equal(namesFile(p, "cache/users.ts"), true);
  assert.equal(namesFile(p, "src/cache/users.ts"), true, "a longer path ending in it");
  assert.equal(namesFile(p, "routes/users.ts"), false, "the same file name in another folder");
  assert.equal(namesFile(pathsIn("fix index.ts"), "packages/web/src/index.ts"), true);
  assert.equal(namesFile(pathsIn("fix a.js"), "src/a.js"), false, "a name too short to mean anything");
  const c = (session, updated, task, changed) => card({ id: session, session, updated, started: updated, task, changed });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const cache = c("cache", "2026-10-26T10:00:00Z", "Drop the user lookup cache", ["cache/users.ts"]);
  const rate = c("rate", "2026-10-26T11:00:00Z", "Add rate limiting", ["routes/users.ts"]);
  assert.deepEqual(recall([cache, rate], "Is the user lookup still cached in cache/users.ts?", { now }).map((h) => h.card.session), ["cache"]);
});

test("unseen V09 (round 5): recall matches words in any form, and a code name is strong", () => {
  const c = (session, task, extra = {}) => card({ id: session, session, updated: "2026-10-26T10:00:00Z", started: "2026-10-26T10:00:00Z", task, ...extra });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const cache = c("cache", "Drop the user lookup cache");
  const other = c("other", "Add a progress bar");
  assert.deepEqual(recall([cache, other], "When was the cache dropped?", { now }).map((h) => h.card.session), ["cache"], "dropped ~ drop, plus cache");
  const par = c("par", "Make the tests run in parallel and use that from now on.");
  assert.deepEqual(recall([par, other], "When did the tests start running in parallel?", { now }), [], "the session's \"run\" is a stop word: one real word in common (parallel) is not enough");
  const named = c("named", "Speed up the suite", { outcome: "runTests waits on the watcher now." });
  assert.deepEqual(recall([named, other], "Why does runTests hang?", { now }).map((h) => h.card.session), ["named"], "one code name is strong evidence");
  assert.deepEqual(recall([named, other], "Why does the watcher hang?", { now }), [], "one ordinary word is not");
  assert.deepEqual(identsIn("Set up GitHub Actions for TypeScript"), [], "product names are not code names");
  assert.deepEqual(identsIn("toCents, get_item, anyhow::Context and parse()").sort(), ["anyhow::Context", "get_item", "parse", "toCents"]);
});

// ---------- Round 6: the round-5 regressions ----------

test("unseen R02 (round 6): a topic match adds to shared words; it is not evidence on its own", () => {
  const { s } = setup();
  const err = addObservation(s, ANA, { kind: "convention", text: "Errors are wrapped with anyhow::Context; no unwrap() outside tests.", via: "manual" });
  const cmd = addObservation(s, ANA, { kind: "command", text: "Run the tests with: cargo test --workspace", tags: ["test"], via: "distill" });
  assert.deepEqual(fittingNotes("How do I run the test suite here?", [err, cmd]).map((o) => o.id), [cmd.id]);
  assert.deepEqual(fittingNotes("Check these errors before the tests run.", [err, cmd]).map((o) => o.id).sort(), [cmd.id, err.id].sort(), "one shared word plus the tests topic: two");
});

test("unseen W05 (round 6): an ordinary word that shares a base with a stop word still counts", () => {
  const { s } = setup();
  const err = addObservation(s, ANA, { kind: "convention", text: "API errors use the ApiError class from packages/api/src/errors.ts.", via: "manual" });
  assert.ok(terms("How should the API report errors?").includes("errors"));
  assert.deepEqual(fittingNotes("How should the API report errors?", [err]).map((o) => o.id), [err.id]);
});

// ---------- Round 6: the optional local model (memory/semantic.ts) ----------

test("round 6: meaning promotes only the clearly closest one-word match, or a very close one with no shared word", () => {
  assert.equal(closestInMeaning([{ item: "a", meaning: 0.74 }, { item: "b", meaning: 0.6 }]), "a", "0.70 or more, and 0.10 ahead");
  assert.equal(closestInMeaning([{ item: "a", meaning: 0.74 }, { item: "b", meaning: 0.68 }]), undefined, "not clearly ahead");
  assert.equal(closestInMeaning([{ item: "a", meaning: 0.69 }]), undefined, "not close enough");
  assert.equal(closestInMeaning([{ item: "a", meaning: 0.71 }]), "a", "alone in the pool");
  assert.equal(closestInMeaning([{ item: "a" }, { item: "b" }]), undefined, "no model, no promotion");
  const q = parseQuery("sign up form for credentials", ["sign", "form", "credentials"]);
  const none = { words: 0, path: false, ident: false };
  assert.equal(confidence(q, { ...none, meaning: MEANING_ALONE }), "strong");
  assert.equal(confidence(q, { ...none, meaning: MEANING_ALONE - 0.01 }), "none");
  assert.equal(confidence(q, { ...none, words: 1, meaning: 0.95 }), "weak", "one shared word is promoted only by the pool rule");
});

test("round 6: with meaning on and no model server, a prompt falls back to words and nothing breaks", () => {
  const p = project();
  writeFileSync(join(p.root, ".snout", "config.json"), JSON.stringify({ memorySemantic: true }));
  p.cli("memory", "add", "Database access goes through db/pool.ts; never open connections in route handlers.", "--kind", "convention");
  const env = { SNOUT_EMBED_FAKE: "1", SNOUT_PORT: "1" };
  const ask = (prompt) => {
    const out = spawnSync(process.execPath, [CLI, "prompt-submit"], { cwd: p.root, encoding: "utf8", input: JSON.stringify({ cwd: p.root, session_id: `p-${Math.random()}`, prompt }), env: { ...process.env, SNOUT_CONFIG_DIR: p.cfg, CLAUDE_PROJECT_DIR: p.root, SNOUT_MODE: "enforce", SNOUT_MEMORY_NOTES: "1", CI: "", SNOUT_TOKEN: "", ...env } });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput?.additionalContext ?? "" : "";
  };
  assert.match(ask("Where should database access and connections go?"), /db\/pool\.ts/, "two words: shown, as without the model");
  assert.equal(ask("Write a haiku about ledgers."), "", "nothing in common: nothing");
});

// ---------- Round 7 ----------

test("unseen X03 (round 7): a search names a hyphenated tool as one token, and part of its name is not the tool", () => {
  const p = project();
  const stores = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  addObservation(stores, userPrincipal(p.root), { kind: "gotcha", text: "sphinx-build is not installed on this machine: don't call it, or install it first.", tags: ["missing"], via: "distill", evidence: "sphinx-build: command not found" });
  assert.match(p.mcp("snout_memory_search", { query: "sphinx-build" }), /sphinx-build is not installed/);
  assert.match(p.mcp("snout_memory_search", { query: "docs with sphinx-build" }), /sphinx-build is not installed/);
  assert.match(p.mcp("snout_memory_search", { query: "build" }), /^Nothing in memory matches/, "\"build\" alone is not the tool");
  assert.match(p.mcp("snout_memory_search", { query: "sphinx" }), /^Nothing in memory matches/, "nor is \"sphinx\"");
});

// ---------- Round 8: ranking and consistency (unseen 6) ----------

test("unseen Y20 (round 8): delivered notes come in order of evidence, not of kind or date", () => {
  const { s } = setup();
  const env = addObservation(s, ANA, { kind: "preference", text: "Never commit .env files.", tags: ["rule", "repeated"], via: "distill" }, new Date("2026-10-26T10:00:00Z"));
  const style = addObservation(s, ANA, { kind: "preference", text: "Always use conventional commit messages like fix: or feat:.", tags: ["rule", "repeated"], via: "distill" }, new Date("2026-10-26T11:00:00Z"));
  const fit = fittingNotes("Can I commit my .env file?", [style, env]);
  assert.deepEqual(fit.map((o) => o.id), [env.id, style.id], ".env and commit beats commit alone");
  const strength = new Map(rankedFit("Can I commit my .env file?", [style, env]).map((f) => [f.note, f.strength]));
  assert.deepEqual(memoryBlock(fit, 600, { rank: (o) => strength.get(o) }).items, [env.id, style.id], "and the block keeps that order");
  // Main P11 (round 8 regression): at equal strength, kind order still decides; a missing tool (gotcha) comes first.
  const just = addObservation(s, ANA, { kind: "gotcha", text: "just is not installed on this machine: don't call it, or install it first.", tags: ["missing"], via: "distill" });
  const ranked = rankedFit("Format the code with just before committing.", [style, just]);
  assert.deepEqual(ranked.map((f) => [f.note.id, f.strength]), [[style.id, 2], [just.id, 2]]);
  const by = new Map(ranked.map((f) => [f.note, f.strength]));
  assert.deepEqual(memoryBlock(ranked.map((f) => f.note), 600, { rank: (o) => by.get(o) }).items, [just.id, style.id]);
  assert.deepEqual(memoryBlock(fit, 600).items, [style.id, env.id], "without a rank: kind, then newest, as before");
});

test("unseen Y11 (round 8): recall answers a one-word question on that word, as the other paths do", () => {
  const c = (session, task) => card({ id: session, session, updated: "2026-10-26T10:00:00Z", started: "2026-10-26T10:00:00Z", task });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const moved = c("moved", "Move background work from the Redis queue to a Postgres job table");
  const other = c("other", "Add a progress bar to the dashboard");
  assert.deepEqual(recall([moved, other], "Where does background work go now?", { now }).map((h) => h.card.session), ["moved"], "\"background\" is its one real word");
  assert.deepEqual(recall([moved, other], "Where does the dashboard background colour come from?", { now }), [], "three real words, one shared each: nothing");
});

test("unseen Y23 (round 8): sessions that changed a named file are ordered by what they share with the question, then newest", () => {
  const c = (session, updated, task) => card({ id: session, session, updated, started: updated, task, changed: ["src/api/routes/orders.ts"] });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const tax = c("tax", "2026-10-26T09:00:00Z", "Apply tax per line item instead of on the order total");
  const rate = c("rate", "2026-10-26T11:00:00Z", "Add a rate limit to POST /orders");
  assert.deepEqual(recall([tax, rate], "How are order totals computed in src/api/routes/orders.ts now?", { now }).map((h) => h.card.session), ["tax", "rate"]);
  assert.deepEqual(recall([tax, rate], "What changed in src/api/routes/orders.ts?", { now }).map((h) => h.card.session), ["rate", "tax"], "nothing else in common: newest first");
});

test("unseen Y17, Y46 (round 8): search reads \"migration\" as a thing, and one stop word is no evidence for a note", () => {
  const p = project();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  writeFileSync(join(p.root, ".snout", "memory", "s.json"), JSON.stringify({ v: 1, id: "s", session: "s", agent: "claude", started: "2026-10-26T10:00:00Z", updated: "2026-10-26T10:00:00Z", task: "Move background work to a Postgres job table", changed: ["src/db/migrations/002_jobs.sql"], rules: [], commits: [] }));
  const stores = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  addObservation(stores, userPrincipal(p.root), { kind: "convention", text: "Database migrations are plain SQL files in src/db/migrations, numbered in order.", via: "manual" });
  addObservation(stores, userPrincipal(p.root), { kind: "preference", text: "Never commit .env files.", tags: ["rule", "repeated"], via: "distill" });
  assert.match(p.mcp("snout_memory_search", { query: "sql migration" }).split("\n")[1], /plain SQL files/, "the note first: no question about history here");
  assert.match(p.mcp("snout_memory_search", { query: "when was the jobs migration added" }), /session:s/, "a real history question still finds the session");
  assert.match(p.mcp("snout_memory_search", { query: "logo file" }), /^Nothing in memory matches/, "\"file\" alone is no evidence");
  assert.match(p.mcp("snout_memory_search", { query: "env file" }), /Never commit \.env files/, "\"env\" is");
});

// ---------- Round 9: out-of-date claims in session records (unseen 7 Z21, Z39) ----------

/** A project driven through the real hooks: Claude Code sessions (`snout stop`) and Codex sessions (`snout hook codex`). */
function agents(p) {
  const env = { ...process.env, SNOUT_CONFIG_DIR: p.cfg, CLAUDE_PROJECT_DIR: p.root, SNOUT_MODE: "enforce", SNOUT_MEMORY_NOTES: "1" };
  delete env.CI;
  delete env.SNOUT_TOKEN;
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: p.root, encoding: "utf8", input: JSON.stringify({ cwd: p.root, ...input }), env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : {};
  };
  const git = (...a) => spawnSync("git", a, { cwd: p.root, encoding: "utf8" });
  const write = (rel, content) => { mkdirSync(join(p.root, rel, ".."), { recursive: true }); writeFileSync(join(p.root, rel), content); };
  const claude = (session, prompt, { edits = {}, mcp = [], final, commit }) => {
    const t = join(p.root, ".snout", `${session}.jsonl`);
    run(["prompt-submit"], { session_id: session, prompt });
    for (const [tool, args] of mcp) p.mcp(tool, args);
    const rows = [{ type: "user", message: { content: prompt } }];
    Object.entries(edits).forEach(([rel, content], i) => {
      write(rel, content);
      rows.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `e${i}`, name: "Edit", input: { file_path: join(p.root, rel) } }] } });
      rows.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `e${i}`, content: "ok" }] } });
    });
    rows.push({ type: "assistant", message: { content: [{ type: "text", text: final }] } });
    writeFileSync(t, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    if (commit) { git("add", "-A"); git("-c", "user.name=T", "commit", "-qm", commit); }
    run(["stop"], { session_id: session, transcript_path: t });
  };
  const codex = (session, prompt, { edits = {}, plan, final, commit }) => {
    const t = join(p.root, ".snout", `rollout-${session}.jsonl`);
    run(["hook", "codex", "UserPromptSubmit"], { session_id: session, hook_event_name: "UserPromptSubmit", prompt });
    const rows = [{ type: "session_meta", payload: { id: session, cwd: p.root } }, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }];
    Object.entries(edits).forEach(([rel, content], i) => {
      write(rel, content);
      rows.push({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: `p${i}`, input: `*** Begin Patch\n*** Update File: ${rel}\n*** End Patch` } });
      rows.push({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: `p${i}`, output: "ok" } });
    });
    if (plan) rows.push({ type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "plan", arguments: JSON.stringify({ plan }) } });
    rows.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: final }] } });
    writeFileSync(t, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    if (commit) { git("add", "-A"); git("-c", "user.name=T", "commit", "-qm", commit); }
    run(["hook", "codex", "Stop"], { session_id: session, hook_event_name: "Stop", transcript_path: t, last_assistant_message: final });
  };
  const ask = (agent, prompt) => {
    const out = agent === "codex"
      ? run(["hook", "codex", "UserPromptSubmit"], { session_id: `q-${Math.random()}`, hook_event_name: "UserPromptSubmit", prompt })
      : run(["prompt-submit"], { session_id: `q-${Math.random()}`, prompt });
    return out.hookSpecificOutput?.additionalContext ?? "";
  };
  return { claude, codex, ask, write, git };
}

test("round 9: the EXIF example - an out-of-date claim reaches no agent by any path; history and the rest of the session stay", () => {
  const p = project();
  const a = agents(p);
  a.write("app/exif.py", "def strip(meta):\n    return {}\n");
  a.write("app/thumbs.py", "CACHE = 'thumbs/'\n");
  a.git("add", "-A");
  a.git("-c", "user.name=T", "commit", "-qm", "init");
  const OLD = /all EXIF metadata stripped/;
  a.claude("s1", "Remember that uploads have all EXIF metadata stripped in app/exif.py.", {
    mcp: [["snout_memory_save", { text: "Uploads have all EXIF metadata stripped in app/exif.py before storage.", kind: "fact", user_asked: true, files: ["app/exif.py"] }]],
    final: "Saved: uploads have all EXIF metadata stripped in app/exif.py before storage. Also, thumbnails are cached in thumbs/ for a week.",
  });
  const stores = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  const note = listObservations(stores).find((o) => OLD.test(o.text));
  assert.equal(note.source.session, "s1", "the note records the session it was saved in");
  assert.match(p.mcp("snout_memory_search", { query: "exif metadata" }), OLD, "before the change, the claim is current");
  a.codex("c2", "Keep the camera model metadata but still strip GPS in app/exif.py.", {
    edits: { "app/exif.py": "def strip(meta):\n    return {k: v for k, v in meta.items() if k == 'Model'}\n" },
    final: "app/exif.py keeps the camera model and strips GPS and everything else.", commit: "Keep camera model, strip GPS only",
  });
  for (const agent of ["claude", "codex"]) assert.doesNotMatch(a.ask(agent, "What metadata do we keep on uploads in app/exif.py?"), OLD, `${agent}: not in a prompt's notes`);
  const recalled = p.cli("recall", "What metadata do we keep on uploads?");
  assert.match(recalled, /keeps the camera model/, "recall gives the current answer");
  assert.doesNotMatch(recalled, OLD, "and not the old claim");
  for (const query of ["exif metadata", "camera model metadata", "uploads stripped"]) assert.doesNotMatch(p.mcp("snout_memory_search", { query }), OLD, `search "${query}"`);
  const history = p.cli("recall", "Where are thumbnails cached?");
  assert.match(history, /thumbnails are cached in thumbs\/ for a week/, "the same session's other, current information is still found");
  assert.match(history, /an out-of-date claim is left out here: its file changed since/);
  assert.doesNotMatch(history, OLD);
  const fetched = p.mcp("snout_memory_fetch", { id: "session:s1" });
  // Fetch shows the record as search does (the on-demand gate, 2026-10-27): the claim is left out of its outcome and named below as out of date.
  assert.match(fetched, /Outcome: .*an out-of-date claim is left out here: its file changed since/, "the out-of-date claim is not stated as current");
  for (const line of fetched.split("\n")) if (OLD.test(line)) assert.match(line, /^Out of date: /, `stated as current: ${line}`);
  assert.match(fetched, /Out of date: "Uploads have all EXIF metadata stripped in app\/exif\.py before storage\." \(o_[a-f0-9]{12}, its file changed since\)/);
});

test("round 9: the last unfinished task still carries across agents, and a project's stale claims stay in that project", () => {
  const p = project();
  const a = agents(p);
  a.write("app/blur.py", "");
  a.git("add", "-A");
  a.git("-c", "user.name=T", "commit", "-qm", "init");
  a.codex("c1", "Add face blurring to uploads in app/blur.py.", {
    edits: { "app/blur.py": "def blur(img):\n    return img\n" },
    plan: [{ step: "Blur boxes", status: "completed" }, { step: "Add tests for images with no faces", status: "pending" }],
    final: "app/blur.py blurs face boxes; tests for images with no faces are still to do.",
  });
  const left = a.ask("claude", "Continue where the last session left off.");
  assert.match(left, /where the last session in this repo left off \(codex/, "a Claude session picks up a Codex session's work");
  assert.match(left, /Add tests for images with no faces/);
  // Another project's out-of-date note doesn't touch this project's records.
  const other = setup();
  addObservation(other.s, ANA, { kind: "fact", text: "Face blurring runs on the GPU in app/blur.py for all uploads.", via: "manual" });
  const mine = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  assert.deepEqual(staleClaims(mine, p.root), []);
});

test("round 9: only a claim a saved note made is left out, sentence by sentence; a file edit alone changes nothing", () => {
  const c = card({ session: "b2", outcome: "src/pricing.ts exports roundPrice. It rounds prices to whole euros." });
  const replaced = { id: "o_1", text: "Prices are rounded to whole euros.", session: null, why: "replaced since" };
  assert.equal(statesClaim("It rounds prices to whole euros.", replaced.text), true);
  assert.equal(statesClaim("src/pricing.ts exports roundPrice.", replaced.text), false);
  assert.equal(withoutStaleClaims(c, [replaced]).outcome, "src/pricing.ts exports roundPrice. [an out-of-date claim is left out here: replaced since]");
  assert.equal(withoutStaleClaims(c, []), c, "no out-of-date note, nothing left out, however often src/pricing.ts changed");
  assert.equal(statesClaim("Remember how we strip metadata from uploads.", "Uploads have all EXIF metadata stripped in app/exif.py before storage."), false, "a request about the subject isn't the claim");
  // Provenance: the session the note was saved in needs most of the claim's words; any other, four fifths.
  const exif = { id: "o_2", text: "Uploads have all EXIF metadata stripped in app/exif.py before storage.", session: "s1", why: "its file changed since" };
  const asked = "Remember that uploads have all EXIF metadata stripped in app/exif.py.";
  assert.match(withoutStaleClaims(card({ session: "s1", task: asked }), [exif]).task, /^\[an out-of-date claim/, "5 of 7 words, in the session that saved it");
  assert.equal(withoutStaleClaims(card({ session: "s9", task: asked }), [exif]).task, asked, "the same 5 of 7 in another session: not enough");
  // A replaced decision counts; a private note that was shared does not (its claim stands, shared).
  const { root, s } = setup();
  const old = addObservation(s, ANA, { kind: "decision", text: "Prices are rounded to whole euros.", via: "manual" });
  const now = addObservation(s, ANA, { kind: "decision", text: "Prices are now rounded to the cent instead of whole euros.", via: "manual" }, new Date(Date.now() + 1000));
  replaceOlder(s, now);
  const kept = addObservation(s, ANA, { kind: "convention", text: "Webhook payloads are signed with HMAC-SHA256.", via: "manual" });
  shareObservation(s, ANA, kept.id);
  assert.deepEqual(staleClaims(s, root).map((k) => [k.id, k.why]), [[old.id, "replaced since"]]);
});

// ---------- Round 10: unseen 8's remaining failures ----------

test("unseen A01, A02, A20 (round 10): a test command that goes A, B, A, B keeps exactly one current note, the latest", () => {
  const { s } = setup();
  const run = (session, command, n) => applyDistilled(s, ANA, card({ session, test: { command, result: `ℹ pass ${n}` } }));
  const current = () => listObservations(s).filter((o) => o.tags.includes("test") && o.status === "active").map((o) => o.text);
  run("s1", "node --test", 31);
  run("s2", "npx c8 node --test", 31);
  assert.deepEqual(current(), ["Run the tests with: npx c8 node --test"]);
  run("s3", "node --test", 32);
  assert.deepEqual(current(), ["Run the tests with: node --test"], "A again: A is current, not two replaced notes");
  run("s4", "npx c8 node --test", 34);
  assert.deepEqual(current(), ["Run the tests with: npx c8 node --test"], "and B again");
  assert.equal(listObservations(s).filter((o) => o.tags.includes("test")).length, 2, "two notes, one current, the other replaced by it");
  // A store a loop left with no current test command recovers on the next passing run.
  const broken = setup().s;
  const a = addObservation(broken, ANA, { kind: "command", text: "Run the tests with: node --test", tags: ["test"], via: "distill", status: "active" });
  const b = addObservation(broken, ANA, { kind: "command", text: "Run the tests with: npx c8 node --test", tags: ["test"], via: "distill" });
  for (const [o, by] of [[a, b], [b, a]]) writeFileSync(join(broken.privateDir, `${o.id}.json`), JSON.stringify({ ...o, status: "superseded", supersededBy: by.id }));
  applyDistilled(broken, ANA, card({ session: "s5", test: { command: "npx c8 node --test", result: "ℹ pass 35" } }));
  assert.deepEqual(listObservations(broken).filter((o) => o.status === "active").map((o) => o.text), ["Run the tests with: npx c8 node --test"]);
});

test("unseen R02, R13 (round 10): a search line shows the sentence of a session's outcome that answers the query", () => {
  const p = project();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  const save = (id, task, outcome) => writeFileSync(join(p.root, ".snout", "memory", `${id}.json`), JSON.stringify({ v: 1, id, session: id, agent: "claude", started: "2026-10-26T10:00:00Z", updated: "2026-10-26T10:00:00Z", task, outcome, changed: [], rules: [], commits: [] }));
  save("b3", "Deploy the staging app with flyctl.", "flyctl isn't installed on this machine, so staging wasn't deployed.");
  save("b4", "[an out-of-date claim is left out here: its file changed since]", "Saved a note. Also, the mail templates live in templates/email/ and are written in MJML.");
  assert.match(p.mcp("snout_memory_search", { query: "deploy staging" }), /session:b3 .*Deploy the staging app with flyctl\. — flyctl isn't installed on this machine/);
  assert.match(p.mcp("snout_memory_search", { query: "email templates" }), /session:b4 .*the mail templates live in templates\/email\//, "a request left out as out of date gives way to the answer");
  assert.doesNotMatch(p.mcp("snout_memory_search", { query: "email templates" }), /session:b4 .*\[an out-of-date claim/);
});

test("unseen R11 (round 10): a short name of a letter and a digit (c8, k6, s3) is a word, matched as written", () => {
  assert.deepEqual(terms("When did c8 coverage join the k6 and S3 work?").filter((t) => /\d/.test(t)), ["c8", "k6", "s3"]);
  assert.deepEqual(terms("Add a UI to the v2 page").filter((t) => t.length === 2), ["v2"], "two letters are still not a word; a letter and a digit is");
  const c = (session, task) => card({ id: session, session, updated: "2026-10-26T10:00:00Z", started: "2026-10-26T10:00:00Z", task });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const cov = c("cov", "Switch the test run to node --test with c8 coverage from now on.");
  const other = c("other", "Add coverage badges to the README");
  assert.deepEqual(recall([cov, other], "When did c8 coverage become part of the test run?", { now }).map((h) => h.card.session), ["cov"]);
  assert.deepEqual(recall([c("c80", "Bump c80 coverage"), other], "When did c8 coverage become part of the test run?", { now }), [], "c8 is not c80");
});

test("unseen A21 (round 10): a note that fits comes before where the last session left off, unless the prompt asks to continue", () => {
  const p = project();
  const a = agents(p);
  a.write("src/bookings.ts", "");
  a.git("add", "-A");
  a.git("-c", "user.name=T", "commit", "-qm", "init");
  p.cli("memory", "add", "Never log card numbers or CVCs.", "--kind", "preference");
  a.codex("c1", "Add group bookings in src/bookings.ts.", { edits: { "src/bookings.ts": "export const book = (n = 1) => n;\n" }, plan: [{ step: "Add tests for oversized groups", status: "pending" }], final: "Group bookings are half done." });
  const check = a.ask("claude", "Never log the card number; check that src/bookings.ts follows that.");
  assert.ok(check.indexOf("Never log card numbers") >= 0 && check.indexOf("Never log card numbers") < check.indexOf("where the last session in this repo left off"), "the note first, the unfinished work after it");
  const resume = a.ask("claude", "Continue where the last session left off.");
  assert.match(resume, /^Snout memory: where the last session in this repo left off/, "asked to continue: the unfinished work first");
});

test("unseen9 Q04, unseen8 R02 (round 10): a search line keeps a session's current sentence after an out-of-date one is left out", () => {
  const p = project();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  const claim = { id: "o_3", text: "Listing photos are resized to 1200 pixels on upload in app/media.py.", session: "h5", why: "its file changed since" };
  const raw = card({ id: "h5", session: "h5", updated: "2026-10-26T10:00:00Z", started: "2026-10-26T10:00:00Z",
    task: "Remember that listing photos are resized on upload in app/media.py.",
    outcome: "Saved: listing photos are resized to 1200 pixels on upload in app/media.py. Also, the CDN cache for photos is purged nightly by the purge_cdn job." });
  const shown = withoutStaleClaims(raw, [claim]);
  assert.match(shown.outcome, /^\[an out-of-date claim is left out here: its file changed since\] Also, the CDN cache/, "the real marker, then the current sentence");
  writeFileSync(join(p.root, ".snout", "memory", "h5.json"), JSON.stringify(shown));
  assert.match(p.mcp("snout_memory_search", { query: "cdn cache" }), /session:h5\s+\S+\s+\S+\s+Also, the CDN cache for photos is purged nightly by the purge_cdn job\./);
});

test("round 11: in a question of one or two words, a word that names a record's own folder, file or missing program is strong evidence; never in a longer prompt, never in delivery", () => {
  const names = nameForms(["src/waitlist/waitlist.ts", "src/index.ts", "tests/test_orders.py"], "Plain SQL files in migrations/, applied with dbmate.", ["ngrok"]);
  for (const w of ["waitlist", "orders", "migrations", "migration", "ngrok"]) assert.equal(names.has(w), true, w);
  for (const w of ["src", "index", "tests", "test", "ts", "py"]) assert.equal(names.has(w), false, `${w}: says where code lives, not what it's about`);
  assert.equal(namesTopic(["waitlist", "left"], names), true);
  assert.equal(namesTopic(["source", "tests"], names), false);
  assert.equal(namesTopic(["users"], nameForms(["routes/users.ts"]), ["cache/users.ts"]), false, "a word inside the question's own path defers to the path rule");

  const now = Date.parse("2026-10-27T12:00:00Z");
  const c = (session, updated, o) => card({ id: session, session, updated, started: updated, ...o });
  const wait = c("wait", "2026-10-27T09:00:00Z", { task: "Add a hold queue for full classes", changed: ["src/waitlist/queue.ts"] });
  const tool = c("tool", "2026-10-27T10:00:00Z", { task: "Expose the webhook to the payment provider", outcome: "It isn't installed here, so nothing was exposed.", missing: ["ngrok"] });
  const orders = c("orders", "2026-10-27T11:00:00Z", { task: "Add a cancel endpoint", changed: ["src/routes/orders.ts"] });
  const ids = (prompt) => recall([wait, tool, orders], prompt, { now }).map((h) => h.card.session);
  assert.deepEqual(ids("Where was the waitlist work left?"), ["wait"], "two words, one names the folder the session worked in");
  assert.deepEqual(ids("Why didn't ngrok start?"), ["tool"], "\"didn\" is what's left of didn't, not a word; ngrok names the program the session found missing");
  assert.deepEqual(ids("Why did the build start failing?"), [], "words that name nothing a session is about stay too weak");
  assert.deepEqual(ids("Order the sidebar links alphabetically."), [], "in a longer prompt, \"order\" is plain English, not orders.ts");

  // Delivery is unasked: a note's folder name alone never brings it.
  const note = (text) => ({ v: 1, id: `o_${text.length.toString(16).padStart(12, "0")}`, kind: "convention", text, scope: "private", project: "p", audience: ["user:a"], status: "active", source: { via: "manual", session: null, agent: null, ts: "2026-10-27T00:00:00Z", files: [] }, created: "2026-10-27T00:00:00Z", updated: "2026-10-27T00:00:00Z", supersedes: null, supersededBy: null, tags: [] });
  assert.deepEqual(fitRanked("Add a money-back guarantee banner.", [note("Money is stored as integer cents in src/lib/money.ts.")]), []);
  assert.deepEqual(fitRanked("Write a migration for the new column.", [note("Schema changes are plain SQL files in migrations/, applied with dbmate.")]), [], "one shared word, and delivery never counts a folder name");
});

test("round 11: at equal evidence, the record that has the question's words side by side ranks first", () => {
  assert.equal(adjacent(["lane", "booking"], "Add lane booking in src/booking/booking.ts"), true);
  assert.equal(adjacent(["lane", "booking"], "lists lane closures by day, and booking skips closed lanes"), false);
  assert.equal(adjacent(["running", "tests"], "after this, run tests in band"), true, "in any form");
  const now = Date.parse("2026-10-27T12:00:00Z");
  const c = (session, updated, task) => card({ id: session, session, updated, started: updated, task });
  const phrase = c("phrase", "2026-10-26T09:00:00Z", "Add seat booking to the cinema app");
  const apart = c("apart", "2026-10-27T09:00:00Z", "Block a seat when a booking is pending");
  assert.deepEqual(recall([phrase, apart], "Which session added seat booking?", { now }).map((h) => h.card.session)[0], "phrase", "the older session wins on the phrase, not the newer on date");
});


// ---------- On-demand round (2026-10-28): unseen 14's misses, and unseen 11 Q01 ----------

test("unseen14 D05, D06 (on-demand): a plural of a word ending in e meets the word", () => {
  const match = (a, b) => sharedWords(terms(a), wordForms(terms(b))) > 0;
  for (const [a, b] of [["sizes", "size"], ["cases", "case"], ["caches", "cache"], ["prizes", "prize"], ["boxes", "box"], ["matches", "match"]]) assert.ok(match(a, b), `${a} ~ ${b}`);
  assert.ok(variants("uses").includes("use") && !variants("uses").includes("us"), "uses: use, never a two-letter stem");
  for (const [a, b] of [["sizes", "sit"], ["passes", "pas"], ["cases", "cash"]]) assert.ok(!match(a, b), `${a} !~ ${b}`);
  const p = project();
  const stores = storesFor(p.root, join(p.root, ".snout"), p.cfg);
  addObservation(stores, userPrincipal(p.root), { kind: "convention", text: "Plot sizes are stored in square metres, as integers.", via: "manual" });
  assert.match(p.mcp("snout_memory_search", { query: "plot size units" }), /square metres/, "plot and size: two words");
});

test("unseen14 D19 (on-demand): a strongly matching note held back since its file changed gives its place to the session that changed the file", () => {
  const p = project();
  mkdirSync(join(p.root, "src", "billing"), { recursive: true });
  writeFileSync(join(p.root, "src", "billing", "rent.ts"), "export const SEASON_RENT_EUR = 40;\n");
  p.mcp("snout_memory_save", { text: "Plot rent is 40 euros per season, set in src/billing/rent.ts.", kind: "fact", user_asked: true, files: ["src/billing/rent.ts"] });
  writeFileSync(join(p.root, "src", "billing", "rent.ts"), "export const SEASON_RENT_EUR = 45;\n");
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  const later = (n) => new Date(Date.now() + n * 60_000).toISOString();
  const save = (id, updated, task, changed, subject) => writeFileSync(join(p.root, ".snout", "memory", `${id}.json`), JSON.stringify({ v: 1, id, session: id, agent: "codex", started: updated, updated, task, outcome: "Done.", changed, rules: [], commits: [{ sha: "abcdef1", subject, files: changed }] }));
  save("before", "2026-01-01T10:00:00Z", "Create src/billing/rent.ts with the season rent.", ["src/billing/rent.ts"], "Season rent");
  // Four sessions that share both words, and two notes that share one and outrank a session at that score:
  // on its own words ("rent", one of two), the session that replaced the note would come seventh.
  addObservation(storesFor(p.root, join(p.root, ".snout"), p.cfg), userPrincipal(p.root), { kind: "convention", text: "Each plot has a numbered stake at its north corner.", via: "manual" });
  addObservation(storesFor(p.root, join(p.root, ".snout"), p.cfg), userPrincipal(p.root), { kind: "convention", text: "Deposits are refunded within 14 days of the plot inspection.", via: "manual" });
  for (let i = 0; i < 4; i++) save(`plot${i}`, later(1 + i), `Fix plot ${i} being rented twice, in src/plots/rent.ts.`, ["src/plots/rent.ts"], `Plot rent fix ${i}`);
  save("rent45", later(7), "Charge 45 euros per season instead of 40, in src/billing/rent.ts.", ["src/billing/rent.ts"], "Season rent 45 euros");
  save("unrelated", later(8), "Rename the billing module's exports in src/billing/rent.ts.", ["src/billing/rent.ts"], "Rename exports");
  const out = p.mcp("snout_memory_search", { query: "plot rent" });
  const lines = out.split("\n").slice(1, 6).join("\n");
  assert.match(lines, /session:rent45 /, "the session that changed the note's file after it, among the first five");
  assert.doesNotMatch(out, /40 euros per season,/, "the out-of-date note itself is never shown");
  assert.doesNotMatch(lines, /session:before /, "a session that changed the file before the note is not what replaced it");
  assert.doesNotMatch(out, /session:unrelated /, "a later session that changed the file but shares no word with the question is not shown");
  assert.match(p.mcp("snout_memory_search", { query: "invoice email" }), /^Nothing in memory matches/, "no strong match on the note: no successor either");
});

test("unseen11 Q01 (on-demand): at the same score, a session whose own task names the word ranks before sessions that matched only in their test command", () => {
  const p = project();
  mkdirSync(join(p.root, ".snout", "memory"), { recursive: true });
  const save = (id, updated, task) => writeFileSync(join(p.root, ".snout", "memory", `${id}.json`), JSON.stringify({ v: 1, id, session: id, agent: "codex", started: updated, updated, task, outcome: "Done.", changed: [], rules: [], commits: [], test: { command: "cargo test --all-features", result: "test result: ok. 21 passed" } }));
  save("allfeat", "2026-10-20T10:00:00Z", "Run the tests with cargo test --all-features from now on; the mqtt feature was never tested.");
  for (let i = 0; i < 6; i++) save(`later${i}`, `2026-10-2${1 + i}T10:00:00Z`, `Add reading type ${i} in src/ingest.rs.`);
  const sessions = p.mcp("snout_memory_search", { query: "all features" }).split("\n").filter((l) => l.startsWith("- session:"));
  assert.match(sessions[0], /session:allfeat /, "the oldest, but the only one about it");
});

test("mixed-language project (on-demand, before unseen 16): each folder and toolchain keeps its own current test command", () => {
  assert.deepEqual(testPlace("cd api && pytest -q"), { folder: "api", toolchain: "python" });
  assert.deepEqual(testPlace("pnpm vitest run"), { folder: ".", toolchain: "js" });
  assert.ok(sameTestPlace("npm test", "npx vitest run"), "one folder, one toolchain: still replaces (tests moved to vitest)");
  assert.ok(sameTestPlace("python -m pytest -q", "tox -q"), "pytest to tox replaces");
  assert.ok(sameTestPlace("make test", "npm test"), "an unknown runner matches any toolchain in its folder");
  assert.ok(!sameTestPlace("cd api && pytest -q", "cd web && pnpm vitest run"), "two folders: two answers");
  assert.ok(!sameTestPlace("go test ./...", "pnpm test"), "two toolchains in one folder: two answers");
  const { s } = setup();
  const run = (session, command, result) => applyDistilled(s, ANA, card({ session, test: { command, result } }));
  const current = () => listObservations(s).filter((o) => o.tags.includes("test") && o.status === "active").map((o) => o.text).sort();
  run("s1", "cd api && pytest -q", "14 passed in 0.52s");
  run("s2", "cd web && pnpm vitest run", "Tests  31 passed (31)");
  run("s3", "cd worker && go test ./...", "ok  \tharbor/worker\t0.20s");
  assert.deepEqual(current(), ["Run the tests with: cd api && pytest -q", "Run the tests with: cd web && pnpm vitest run", "Run the tests with: cd worker && go test ./..."]);
  run("s4", "cd api && pytest -q -n auto", "15 passed in 0.40s");
  assert.deepEqual(current(), ["Run the tests with: cd api && pytest -q -n auto", "Run the tests with: cd web && pnpm vitest run", "Run the tests with: cd worker && go test ./..."], "a newer API command replaces only the API's");
  const keys = listObservations(s).filter((o) => o.status === "active").map(factKey);
  assert.equal(new Set(keys).size, 3, "each folder's command is its own fact for once-per-session");
});
