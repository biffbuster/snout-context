// The handoff check's scoring (bench/handoff-check.mjs): what counts as the receiver finding the
// giver's record, and which paths outside a workspace make a session invalid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { decisionPatternProblems, memoryUse, outsideAccess, repoShows } from "../bench/handoff-check.mjs";

const GIVER = "4c0b61dc-fa6e-4493-8836-ccd18bd64171";
const PATTERN = "time ?zone|\\btz\\b|local (?:date|day|time|calendar)|\\butc\\b";
const call = (id, name, args) => ({ dir: "in", msg: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
const reply = (id, text, extra = {}) => ({ dir: "out", msg: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...extra } } });
const line = (text) => `2 of 2 matches for "weekly report":\n- session:${GIVER}  codex  2026-10-28  ${text}\n- session:other  claude  2026-10-27  something else`;

test("found, current and cited: the giver's line carries the fact, its agent and its date", () => {
  const m = memoryUse([call(1, "snout_memory_search", { query: "weekly report week" }), reply(1, line("Daily report off by a day — it grouped by the UTC date; now the depot's time zone."))], GIVER, "codex", PATTERN);
  assert.equal(m.searches, 1);
  assert.deepEqual([m.found, m.current, m.cited], [true, true, true]);
});

test("the fact on another record is not found; the giver's record in other words is found, its wording reported apart", () => {
  const other = memoryUse([call(1, "snout_memory_search", { query: "q" }), reply(1, `- session:other  claude  2026-10-27  grouped by UTC`)], GIVER, "codex", PATTERN);
  assert.deepEqual([other.found, other.factShown], [false, false]);
  // A record states a fact in its own words ("payment keys are now stable"): shown by its id is found; the hidden tests judge its use.
  const without = memoryUse([call(1, "snout_memory_search", { query: "q" }), reply(1, line("Daily report off by a day; fixed."))], GIVER, "codex", PATTERN);
  assert.deepEqual([without.found, without.factShown, without.shown.length], [true, false, 1]);
});

test("a fetch of the giver's record counts; a fetch of another or a failed one does not", () => {
  const fetched = `session:${GIVER} · codex · 2026-10-28T15:33 → 2026-10-28T15:40 (a record of an earlier session)\nTask: Depot managers...\nOutcome: the report used the UTC date.`;
  assert.equal(memoryUse([call(1, "snout_memory_fetch", { id: `session:${GIVER}` }), reply(1, fetched)], GIVER, "codex", PATTERN).found, true);
  assert.equal(memoryUse([call(1, "snout_memory_fetch", { id: "session:other" }), reply(1, fetched)], GIVER, "codex", PATTERN).found, false);
  assert.equal(memoryUse([call(1, "snout_memory_fetch", { id: `session:${GIVER}` }), reply(1, fetched, { isError: true })], GIVER, "codex", PATTERN).found, false);
});

test("a record shown as out of date is found but not current", () => {
  const stale = `session:${GIVER} · codex · 2026-10-28T15:33 → 2026-10-28T15:40\nOutcome: grouped by the UTC date.\nOut of date: "x" (obs1, its file changed since). This record is history; don't rely on that claim.`;
  const m = memoryUse([call(1, "snout_memory_fetch", { id: `session:${GIVER}` }), reply(1, stale)], GIVER, "codex", PATTERN);
  assert.deepEqual([m.found, m.current], [true, false]);
});

test("a record under the wrong agent is not cited", () => {
  const m = memoryUse([call(1, "snout_memory_search", { query: "q" }), reply(1, line("grouped by the UTC date"))], GIVER, "claude", PATTERN);
  assert.deepEqual([m.found, m.cited], [true, false]);
});

test("reading the check's own files, the bench stores or another workspace is forbidden; other outside paths are listed for review", () => {
  const w = { ws: join(homedir(), ".snout-bench", "handoff-ws", "depotclock-aaaaaa") };
  const run = join(homedir(), ".snout-bench", "handoff-runs", "handoff-live-1");
  const o = outsideAccess([
    join(w.ws, "src", "time.js"),
    "node --test",
    "cat ../../../Desktop/snout-context/bench/handoff/depotclock/hidden/handoff-receiver.test.js",
    join(run, "codex-to-claude", "snapshot", "src", "time.js"),
    join(homedir(), ".snout-bench", "handoff-ws", "depotclock-bbbbbb", "src", "time.js"),
    "python -c \"import sys; print(sys.prefix)\" && ls C:/Python313/Lib",
    "ls ..",
  ], w, run);
  assert.equal(o.forbidden.length, 3);
  assert.deepEqual(o.review, ["python -c \"import sys; print(sys.prefix)\" && ls C:/Python313/Lib", "ls .."]);
});

test("the workspace's own path in Git Bash's spelling is its own; another workspace in that spelling is not", () => {
  // The live run of 2026-10-28 flagged a session for `cd /c/Users/.../handoff-ws/<its own name> && npm test`.
  const w = { ws: "C:\\Users\\dev\\.snout-bench\\handoff-ws\\depotclock-4efca9" };
  const o = outsideAccess([
    "cd /c/Users/dev/.snout-bench/handoff-ws/depotclock-4efca9 && npm test 2>&1 | tail -20",
    "cat /c/Users/dev/.snout-bench/handoff-ws/depotclock-8762c1/src/time.js",
  ], w, "C:\\Users\\dev\\.snout-bench\\handoff-runs\\handoff-live-1");
  assert.deepEqual(o.forbidden, ["cat /c/Users/dev/.snout-bench/handoff-ws/depotclock-8762c1/src/time.js"]);
  assert.deepEqual(o.review, []);
});

test("a decision pattern must name the decision: matching the receiver's prompt (its topic) is a problem", () => {
  const spec = JSON.parse(readFileSync(new URL("../bench/handoff/spec-record.json", import.meta.url), "utf8"));
  for (const d of spec.directions) assert.deepEqual(decisionPatternProblems(d), [], d.id);
  // The patterns frozen for the first record-only run: each names its direction's topic.
  const [fuel, payroll] = spec.directions;
  assert.match(decisionPatternProblems({ ...fuel, repoPattern: "tab[- ]separated|whole cents|three decimals|supplier'?s portal" }).join(), /receiver's prompt \("supplier's portal"\)/);
  assert.match(decisionPatternProblems({ ...payroll, repoPattern: "payroll|week it ends|week (?:the|a) shift ends" }).join(), /receiver's prompt \("payroll"\)/);
  assert.match(decisionPatternProblems({ ...payroll, repoPattern: "fortnight" }).join(), /does not match the giver's prompt/);
});

test("the giver's test that pins the old rule does not count as the decision in the project; a line stating it does, by line", () => {
  const payroll = JSON.parse(readFileSync(new URL("../bench/handoff/spec-record.json", import.meta.url), "utf8")).directions[1];
  const dir = mkdtempSync(join(tmpdir(), "snout-decision-"));
  try {
    mkdirSync(join(dir, "test"));
    // The line the first record-only run flagged (Codex, depotclock).
    writeFileSync(join(dir, "test", "reports.test.js"), 'import { test } from "node:test";\ntest("weekly hours retain UTC start-week attribution pending payroll confirmation", () => {});\n');
    assert.deepEqual(repoShows(dir, payroll.repoPattern), []);
    writeFileSync(join(dir, "NOTES.md"), "# Notes\nFrom November a shift counts in the week it ends, in local time.\n");
    assert.deepEqual(repoShows(dir, payroll.repoPattern), ["NOTES.md:2: From November a shift counts in the week it ends, in local time."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
