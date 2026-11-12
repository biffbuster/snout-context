// The handoff check's scoring (bench/handoff-check.mjs): what counts as the receiver finding the
// giver's record, and which paths outside a workspace make a session invalid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { continuityGate, continuityTable, controlTable, decisionPatternProblems, firstEditStats, memoryUse, outsideAccess, repoShows, shellWrites } from "../bench/handoff-check.mjs";

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
  // The startup index gives eight characters of the id: a fetch by them that opens the giver's record counts.
  assert.equal(memoryUse([call(1, "snout_memory_fetch", { id: `session:${GIVER.slice(0, 8)}` }), reply(1, fetched)], GIVER, "codex", PATTERN).found, true);
  assert.equal(memoryUse([call(1, "snout_memory_fetch", { id: `session:${GIVER.slice(0, 4)}` }), reply(1, fetched)], GIVER, "codex", PATTERN).found, false, "too short to name it");
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

test("Claude Code's memory folder for the session's workspace is its own; its transcripts and other workspaces' memory are not", () => {
  // Stage 1 of the continuity check (2026-11-11) flagged the off receiver for a Glob of MEMORY.md in its own (empty) memory folder.
  const w = { ws: join(homedir(), ".snout-bench", "handoff-ws", "shipcalc-3bdb0e") };
  const slug = (ws) => join(homedir(), ".snout-bench", "claude-home", "projects", ws.replace(/[^A-Za-z0-9]/g, "-"));
  const mem = join(slug(w.ws), "memory");
  const tilde = (p) => `~${p.slice(homedir().length).replace(/\\/g, "/")}`;
  const run = join(homedir(), ".snout-bench", "handoff-runs", "handoff-live-1");
  const o = outsideAccess([
    mem,
    join(mem, "MEMORY.md"),
    `ls "${tilde(mem)}/"`,
    `cat ${mem.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)}/project_notes.md`,
    join(slug(w.ws), "a7990c82-53db-46d1-b424-bf540d6077dd.jsonl"),
    `cat ${mem}/../a7990c82-53db-46d1-b424-bf540d6077dd.jsonl`,
    `cat ${mem}/./../a7990c82.jsonl`,
    `${mem}2`,
    join(slug(join(homedir(), ".snout-bench", "handoff-ws", "shipcalc-ffffff")), "memory", "MEMORY.md"),
  ], w, run, [mem]);
  assert.equal(o.forbidden.length, 5);
  assert.deepEqual(o.review, []);
  // Without the allowance (Codex sessions, and every session before this rule) the folder is forbidden as before.
  assert.equal(outsideAccess([join(mem, "MEMORY.md")], w, run).forbidden.length, 1);
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

test("before the first useful edit: calls, result characters and tokens; a note or an agent's own file is not that edit", () => {
  const row = (o) => JSON.stringify(o);
  const lines = [
    row({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:/w/src/a.js" } }] } }),
    // One model call written as two rows: its tokens count once.
    row({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }, content: [{ type: "text", text: "reading" }] } }),
    row({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(50) }] } }),
    row({ type: "assistant", message: { id: "m2", usage: { input_tokens: 20, output_tokens: 5 }, content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "C:/w/NOTES.md" } }] } }),
    row({ type: "assistant", message: { id: "m3", usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: "tool_use", id: "t3", name: "Write", input: { file_path: "C:/w/.claude/settings.json" } }] } }),
    row({ type: "assistant", message: { id: "m4", usage: { input_tokens: 30, output_tokens: 5 }, content: [{ type: "tool_use", id: "t4", name: "Edit", input: { file_path: "C:/w/src/a.js" } }] } }),
    row({ type: "assistant", message: { id: "m5", usage: { input_tokens: 999, output_tokens: 1 }, content: [{ type: "tool_use", id: "t5", name: "Read", input: { file_path: "C:/w/src/b.js" } }] } }),
  ];
  assert.deepEqual(firstEditStats(lines), { calls: 3, chars: 50, tokens: 185, edited: true });
  assert.deepEqual(firstEditStats(lines.slice(0, 3)), { calls: 1, chars: 50, tokens: 115, edited: false }, "no edit: the whole session");
});

test("the files a shell command writes: redirections, tee, sed -i, perl -i and PowerShell's writers; not heredoc bodies or quoted text", () => {
  assert.deepEqual(shellWrites("cd C:/w && cat > src/notify.js <<'EOF'\nconst big = (n) => n > 160;\nlog(a >> b);\nEOF\nnpm test 2>&1 | tail -20"), ["src/notify.js"]);
  assert.deepEqual(shellWrites("cat <<EOF >> test/notify.test.js\ntest(\"x\", () => {});\nEOF"), ["test/notify.test.js"]);
  assert.deepEqual(shellWrites("git diff; cat src/a.js; npm test 2>/dev/null >&2"), []);
  assert.deepEqual(shellWrites(`node -e "console.log(1 > 0)" && echo 'a > b'`), []);
  assert.deepEqual(shellWrites(`echo x > "src/my file.js"; git diff | tee -a out.patch`), ["src/my file.js", "out.patch"]);
  assert.deepEqual(shellWrites("sed -i 's/a > b/c/' src/x.js src/y.js && perl -pi -e 's/a/b/' lib/z.pl && sed -n 1,5p src/x.js"), ["src/x.js", "src/y.js", "lib/z.pl"]);
  assert.deepEqual(shellWrites("Set-Content -Path src\\a.js -Value 'x'; 'y' | Out-File notes.txt; Get-Content src\\a.js"), ["src\\a.js", "notes.txt"]);
});

test("a shell write of a project file is the first edit; a note, /dev/null or a file outside the workspace is not", () => {
  const row = (id, command) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: 10, output_tokens: 0 }, content: [{ type: "tool_use", id: `t-${id}`, name: "Bash", input: { command } }] } });
  const lines = [
    row("m1", "cat src/a.js"),
    row("m2", "cat > NOTES.md <<'EOF'\nnext: step 2\nEOF"),
    row("m3", "npm test > /dev/null; cat > C:/tmp/scratch.js <<'EOF'\nx\nEOF"),
    row("m4", "cat > C:/w/src/a.js <<'EOF'\nexport const a = 1;\nEOF"),
    row("m5", "npm test"),
  ];
  assert.deepEqual(firstEditStats(lines, "C:\\w"), { calls: 3, chars: 0, tokens: 40, edited: true });
  assert.deepEqual(firstEditStats(lines.slice(0, 3), "C:\\w"), { calls: 3, chars: 0, tokens: 30, edited: false });
  assert.equal(firstEditStats([row("m1", "cat > /c/w/src/a.js <<'EOF'\nx\nEOF")], "C:\\w").edited, true, "the Git Bash spelling of the workspace");
});

test("a continuity stage goes on only if every earlier direction ran both receivers and nothing was invalid", () => {
  const ok = { id: "a", giver: { role: "giver" }, receivers: { on: { role: "receiver-on" }, off: { role: "receiver-off" } } };
  assert.deepEqual(continuityGate([ok]), []);
  assert.deepEqual(continuityGate([{ id: "b", stopped: "no record to hand off: fact" }]), ["b: no record to hand off: fact"]);
  assert.deepEqual(continuityGate([{ ...ok, receivers: { on: ok.receivers.on } }]), ["a: the receivers did not both run"]);
  assert.match(continuityGate([{ ...ok, giver: { role: "giver", invalid: ["network command"] } }])[0], /a giver was invalid \(network command\)/);
});

test("cost per successful handoff counts the shared givers and the arm's receivers; a success needs the next step and the decision", () => {
  const recv = (taskPassed, decisionHonored, costUsd) => ({ solved: taskPassed && decisionHonored, taskPassed, decisionHonored, costUsd, beforeFirstEdit: { calls: 4, chars: 900, tokens: 30000, edited: true } });
  const dirs = [
    { id: "a", giver: { costUsd: 0.1 }, receivers: { on: recv(true, true, 0.05), off: recv(true, false, 0.08) } },
    { id: "b", giver: { costUsd: 0.1 }, receivers: { on: recv(true, true, 0.07), off: recv(false, false, 0.06) } },
  ];
  const t = continuityTable(dirs);
  assert.match(t, /on +2\/2 +2 +2 .*\$0\.120 +\$0\.160/, "givers $0.20 + receivers $0.12, over 2 successes");
  assert.match(t, /off +0\/2 +1 +0 .*n\/a \(no success\)/);
  assert.match(t, /whole Snout setup/);
  assert.doesNotMatch(t, /leftoff/, "no row for an arm that did not run");
  // spec-leftoff.json: a third receiver, between on and off, priced against the same givers.
  const withLeft = continuityTable(dirs.map((d) => ({ ...d, receivers: { ...d.receivers, leftoff: recv(true, true, 0.04) } })));
  assert.match(withLeft, /\n {2}on .*\n {2}leftoff +2\/2 +2 +2 .*\$0\.080 +\$0\.140\n {2}off /, "givers $0.20 + receivers $0.08, over 2 successes");
});

test("the controls table counts the asked task, the step left for later, and the note per arm; controls stay out of the continuity table", () => {
  const recv = (askedDone, inScope, shown, total, extra = {}) => ({ solved: askedDone, askedDone, inScope, leftOff: { shown }, tokens: { total }, costUsd: 0.03, ...extra });
  const dirs = [
    { id: "c1", control: "same file, different task", giver: { costUsd: 0.1 }, receivers: { on: recv(true, true, false, 40000), leftoff: recv(true, false, true, 50000), off: recv(true, true, false, 30000) } },
    { id: "c2", control: "same file, different task", giver: { costUsd: 0.1 }, receivers: { on: recv(true, true, false, 42000), leftoff: recv(true, true, true, 46000, { invalid: ["network command"] }), off: recv(false, true, false, 31000) } },
  ];
  const t = controlTable(dirs);
  assert.match(t, /2 controls/);
  assert.match(t, /\n {2}on +2\/2 +2\/2 +0\/2 +40000 +\$0\.060/);
  assert.match(t, /\n {2}leftoff +1\/2 +0\/2 +1\/2 +46000 /, "an invalid session counts for nothing; one receiver started the step left for later");
  assert.match(t, /\n {2}off +1\/2 +2\/2 +0\/2 +30000 /);
  assert.equal(continuityTable(dirs), "");
  assert.equal(controlTable([{ id: "a", receivers: { on: { taskPassed: true } } }]), "");
});
