// The memory study's accounting and validity rules (bench/study-checks.mjs). Each case below is one
// the 2026-10-24 harness check got wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkCommands, modeProblems, armProblems, scoreStep, costMismatch, spentUsd, hookCoverage, codexHookCoverage, pilotVerdict, armOrder, memoryUse, wrongRecalls, labelTasks, groupFits, memoryPath, memoryDiagnosis, recordName } from "../bench/study-checks.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

test("running an installed tool through npx is not network use; fetching a package is", () => {
  const local = [
    "npx vitest run packages/vite/src/node/__tests__/utils.spec.ts 2>&1 | tail -15",
    "cd /c/ws/vite-22944 && npx vitest run --project unit packages/vite/src",
    "cd packages/vite && npx prettier --write src/module-runner/utils.ts >/dev/null; npx vitest run --pro",
    "npx tsc --noEmit -p packages/vite",
    "go test ./tpl/resources/ 2>&1 | tail -5",
    // hugo-15086 `trim`: the URL is part of the message the edit writes.
    `sed -i 's#^\\treturn x#\\thugo.Deprecate("resources.PostProcess", "Use templates.Defer instead. See https://gohugo.io/functions/templates/defer/", "v0.164.0")#' tpl/resources/resources.go`,
  ];
  assert.deepEqual(networkCommands(local), []);
  const fetching = ["npx -y create-vite app", "npx --yes serve", "npx -p typescript tsc", "npx prettier@3.3.3 --check .", "npx @scope/tool@1 x",
    "pnpm dlx degit x", "yarn dlx foo", "bunx cowsay", "curl https://example.com", "npm install left-pad", "go get golang.org/x/tools", "git fetch origin",
    `node -e "fetch('https://registry.npmjs.org/vite').then(r=>r.text())"`, `python -c "import urllib.request; urllib.request.urlopen('https://x.org')"`];
  assert.deepEqual(networkCommands(fetching), fetching);
});

test("rows Snout measures but never judges do not count as a mode", () => {
  const rows = [
    { mode: "enforce", rule: "unclassified", decision: "allow" },
    { mode: "observe", rule: "tool-output", decision: "allow" },
    { mode: "observe", rule: "reversal", decision: "allow" },
  ];
  assert.deepEqual(modeProblems(rows), []);
  assert.deepEqual(modeProblems([...rows, { mode: "observe", rule: "lockfile", decision: "allow" }]), ["observe"]);
});

test("a search's separator lines in enforce mode do not make the session look like observe mode", () => {
  // The vite-22796 `memory` session was marked invalid this way: a content-mode Grep with
  // context separators left unattributed lines, which Snout records as tool output.
  const root = mkdtempSync(join(tmpdir(), "snout-study-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  const out = ["src/a.ts:1:export const a = 1;", "--", "src/a.ts:2:export const b = 2;"].join("\n");
  const r = spawnSync(process.execPath, [CLI, "post-tool"], {
    input: JSON.stringify({ session_id: "study", cwd: root, hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "g1",
      tool_input: { pattern: "export", output_mode: "content", "-C": 1 }, tool_response: out }),
    encoding: "utf8",
    env: { ...process.env, SNOUT_MODE: "enforce", SNOUT_DIR: "", CI: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.some((x) => x.rule === "tool-output" && x.mode === "observe"), "the unjudged row is still written");
  assert.ok(rows.some((x) => x.rule !== "tool-output" && x.mode === "enforce"), "the file's share is judged in enforce");
  assert.deepEqual(modeProblems(rows), []);
});

test("a session that hit a limit is attempted, not solved, even when its patch passes", () => {
  const passed = { resolved: true, f2pFailed: [], p2pFailed: [] };
  assert.deepEqual(scoreStep({ timedOut: true }, passed), { ...passed, resolved: false, gradedResolved: true, limitHit: "time" });
  assert.equal(scoreStep({ cut: true }, passed).limitHit, "budget");
  assert.equal(scoreStep({ cut: true }, passed).resolved, false);
  assert.deepEqual(scoreStep({}, passed), passed);
});

test("Claude Code's own cost is checked against the transcript's", () => {
  assert.equal(costMismatch(0.1, 0.101), null);
  assert.deepEqual(costMismatch(0.1, 0.12), { transcriptUsd: 0.1, cliUsd: 0.12 });
  assert.equal(costMismatch(0.1, undefined), null);
});

test("hook coverage counts each tool call once, against the hook's heartbeats", () => {
  // hugo-15086 `trim`: each call appears in two transcript entries; Edit has no PostToolUse hook here.
  const uses = [{ id: "a", name: "Grep" }, { id: "b", name: "Grep" }, { id: "a", name: "Grep" }, { id: "c", name: "Bash" }, { id: "d", name: "Bash" }, { id: "e", name: "Edit" }];
  const beats = [{ event: "session-start" }, { event: "prompt-submit" }, ...Array(4).fill({ event: "post-tool" }), { event: "pre-tool" }, { event: "pre-tool" }, { event: "squeeze" }];
  assert.deepEqual(hookCoverage(uses, beats), { expected: 4, seen: 4, missing: 0, started: true, prompted: true });
  assert.equal(hookCoverage(uses, beats.slice(0, 4)).missing, 2);
  assert.equal(hookCoverage(uses, []).started, false);
});

test("Codex hook coverage matches each shell command to a pre-tool heartbeat", () => {
  // vite-22944 `trim`, 2026-10-24: 10 commands, 10 pre-tool and 13 post-tool heartbeats (edits fire post-tool too).
  const commands = Array.from({ length: 10 }, (_, i) => `cmd ${i}`);
  const beats = [{ event: "session-start" }, { event: "prompt-submit" }, ...Array(10).fill({ event: "pre-tool" }), ...Array(13).fill({ event: "post-tool" })];
  assert.equal(codexHookCoverage(commands, beats).missing, 0);
  assert.equal(codexHookCoverage(commands, beats.filter((b, i) => i !== 5)).missing, 1);
});

test("transcript pricing matches what Claude Code reported for two live Sonnet 5.5 sessions", async () => {
  // Gate 1, 2026-10-24: vite-22944 in `trim` and `memory`. With cache reads at $0.20/M instead of
  // the listed $0.10/M, the harness put these at $0.0730 and $0.0648.
  const { callCost } = await import("../bench/swelong.mjs");
  const trim = { input_tokens: 12, cache_read_input_tokens: 125985, cache_creation_input_tokens: 11705, output_tokens: 1855 };
  const memory = { input_tokens: 14, cache_read_input_tokens: 156169, cache_creation_input_tokens: 4821, output_tokens: 2146 };
  assert.equal(costMismatch(callCost("claude-sonnet-5-5", trim), 0.060435), null);
  assert.equal(costMismatch(callCost("claude-sonnet-5-5", memory), 0.0491574), null);
});

test("a session the run started and lost is still counted in spend", () => {
  const rows = [{ steps: [{ costUsd: 0.25 }, { costUsd: 0.05 }] }, { steps: [{ costUsd: 0.2 }] }];
  assert.equal(spentUsd(rows), 0.5);
  assert.equal(spentUsd(rows, [{ costUsd: 0.135 }]), 0.635);
});

test("the memory arm turns automatic notes on by name; no other arm has them (memoryNotes, off by default)", () => {
  assert.deepEqual(armProblems("memory", { mode: "enforce", memory: true, memoryNotes: true, memoryHint: false }), []);
  assert.match(armProblems("memory", { mode: "enforce", memory: true })[0], /trimming only/, "memory: true alone is a trimming-only run under the memory label");
  assert.match(armProblems("memory", { mode: "enforce", memory: false, memoryNotes: true })[0], /trimming only/);
  assert.deepEqual(armProblems("trim", { mode: "enforce", memory: false, memoryNotes: false }), []);
  assert.match(armProblems("trim", { mode: "enforce", memoryNotes: true })[0], /trim arm has automatic notes on/);
  assert.deepEqual(armProblems("plain", { mode: "observe", memory: false, memoryNotes: false }), []);
});

test("the search arm keeps memory with automatic notes off", () => {
  assert.deepEqual(armProblems("search", { mode: "enforce", memory: true, memoryNotes: false }), []);
  assert.match(armProblems("search", { mode: "enforce", memory: true, memoryNotes: true })[0], /search arm has automatic notes on/);
  assert.match(armProblems("search", { mode: "enforce", memory: false, memoryNotes: false })[0], /nothing to search/);
});

test("only the search arm gets the session-start hint (memoryHint, on by default)", () => {
  assert.deepEqual(armProblems("search", { mode: "enforce", memory: true, memoryNotes: false, memoryHint: true }), []);
  assert.match(armProblems("search", { mode: "enforce", memory: true, memoryNotes: false, memoryHint: false })[0], /hint off/);
  assert.match(armProblems("memory", { mode: "enforce", memory: true, memoryNotes: true })[0], /memory arm has the session-start hint on/, "left at its default, the hint is on");
  // With memory off there are no records and no hint.
  assert.deepEqual(armProblems("trim", { mode: "enforce", memory: false, memoryNotes: false }), []);
});

test("the pilot's verdict: solved at least as many at a lower cost per solved task; no verdict on an invalid, short or unhinted run", () => {
  const step = (task, resolved, costUsd, hint) => ({ task, resolved, costUsd, ...(hint ? { hint } : {}) });
  const chain = (arm, costs, solved, hints = false) => ({ arm, rep: 0, steps: costs.map((c, i) => step(`t${i}`, solved[i], c, hints && i > 0)) });
  const rows = [
    chain("plain", [0.1, 0.1, 0.1], [true, true, false]),
    chain("trim", [0.09, 0.09, 0.09], [true, true, false]),
    chain("search", [0.09, 0.08, 0.08], [true, true, true], true),
  ];
  const v = pilotVerdict(rows);
  assert.equal(v.valid, true);
  assert.deepEqual([v.trimming.pass, v.memory.pass, v.workflow.pass], [true, true, true]);
  assert.equal(v.memory.arm.solved, 3);
  // Cheaper per solved task but one fewer solved: not a pass.
  const lost = pilotVerdict([rows[0], rows[1], chain("search", [0.01, 0.01, 0.01], [true, false, false], true)]);
  assert.deepEqual([lost.memory.pass, lost.workflow.pass], [false, false]);
  assert.match(pilotVerdict([rows[0], rows[1], chain("search", [0.09, 0.08, 0.08], [true, true, true])]).why, /hint did not reach t1, t2/);
  assert.match(pilotVerdict([rows[0], { ...rows[1], invalid: "x" }, rows[2]]).why, /^invalid/);
  assert.match(pilotVerdict([rows[0], { ...rows[1], steps: rows[1].steps.slice(0, 2) }, rows[2]]).why, /incomplete: plain 3, trim 2, search 3/);
});

test("arms run interleaved by task, each first as often as the tasks allow", () => {
  const arms = ["plain", "trim", "search"];
  assert.deepEqual([0, 1, 2, 3].map((i) => armOrder(arms, 0, i).join(",")), ["plain,trim,search", "trim,search,plain", "search,plain,trim", "plain,trim,search"]);
  assert.deepEqual(armOrder(arms, 1, 0), ["trim", "search", "plain"]);
});

test("memory use: searches, empty searches, records opened, and records acted on (a file they name used afterwards)", () => {
  const rows = [
    { kind: "hint", tokensEst: 80 },
    { kind: "search", asked: "test command", shown: ["session:a", "o_0123456789ab"], tokensEst: 50 },
    { kind: "search", asked: "nothing", shown: [], tokensEst: 10 },
    { kind: "fetch", asked: "session:a", shown: ["session:a"], tokensEst: 200 },
    { kind: "fetch", asked: "session:b", shown: ["session:b"], tokensEst: 150 },
    { kind: "fetch", asked: "session:zz", shown: [], missed: true, tokensEst: 5 },
  ];
  const files = { "session:a": ["tpl/resources/resources.go"], "session:b": ["docs/x.md"] };
  const u = memoryUse(rows, ["C:\\ws\\hugo-1\\tpl\\resources\\resources.go", "go test ./tpl/..."], (id) => files[id] ?? []);
  assert.deepEqual(u, { searches: 2, empty: 1, shown: ["session:a", "o_0123456789ab"], opened: ["session:a", "session:b"], missed: 1, tokens: 415, actedOn: ["session:a"] });
  assert.equal(memoryUse([{ kind: "hint" }], [], () => []), null, "no memory call");
});

test("a wrong recall: a search session acted on a record and failed a task trim solved in the same repeat", () => {
  const step = (task, resolved, memory) => ({ task, resolved, costUsd: 0.1, ...(memory ? { memory } : {}) });
  const rows = [
    { arm: "trim", rep: 0, steps: [step("t1", true), step("t2", true), step("t3", false)] },
    { arm: "search", rep: 0, steps: [step("t1", false, { actedOn: ["session:a"] }), step("t2", false, { actedOn: [] }), step("t3", false, { actedOn: ["session:b"] })] },
  ];
  assert.deepEqual(wrongRecalls(rows), [{ task: "t1", rep: 0, records: ["session:a"] }]);
});

test("pilot labels: a candidate shares a folder, its parent or a non-root sibling with an earlier task; the first task is a control", () => {
  const l = labelTasks([
    { id: "a", files: ["tpl/css/x.go", "commands/gen.go"] },
    { id: "b", files: ["hugolib/page.go"] }, // root-level siblings are not related
    { id: "c", files: ["tpl/resources/r.go"] }, // sibling of tpl/css
    { id: "d", files: ["tpl/resources/sub/y.go", "pnpm-lock.yaml"] }, // child of c's folder; a root file adds nothing
    { id: "e", files: ["modules/npm/p.go"] },
  ]);
  assert.deepEqual(l, { a: { label: "control", from: [] }, b: { label: "control", from: [] }, c: { label: "candidate", from: ["a"] }, d: { label: "candidate", from: ["c"] }, e: { label: "control", from: [] } });
});

test("the frozen pilot's labels are what the rule gives on the reference fixes, oldest first", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pilot = JSON.parse(readFileSync(join(root, "bench/memory-pilot.json"), "utf8"));
  const want = {};
  for (const [tf, ids] of Object.entries(pilot.tasks)) {
    const spec = JSON.parse(readFileSync(join(root, tf), "utf8"));
    const tasks = spec.tasks.filter((t) => ids.includes(t.id)).sort((a, b) => a.merged.localeCompare(b.merged));
    Object.assign(want, labelTasks(tasks.map((t) => ({ id: t.id, files: [...readFileSync(join(root, t.patch), "utf8").matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]) }))));
  }
  assert.deepEqual(pilot.labels, want);
});

test("a task group starts only if every arm fits the cap at the costliest session so far", () => {
  assert.equal(groupFits(0, 0, 3, 3), true, "the first group");
  assert.equal(groupFits(2.1, 0.3, 3, 3), true);
  assert.equal(groupFits(2.2, 0.3, 3, 3), false);
  assert.equal(groupFits(50, 5, 3, undefined), true, "no cap");
});

test("the memory path: hint, search, labeled record shown, opened, acted on, result; and what to work on next", () => {
  const records = { "session:s1": "t1", "session:s2": "t2" };
  const recordTask = (id) => records[id];
  const cand = { label: "candidate", from: ["t1"] };
  const step = (memory, extra = {}) => ({ task: "t3", hint: true, resolved: true, costUsd: 0.1, memory, ...extra });
  const full = memoryPath(step({ searches: 1, shown: ["session:s1", "session:s2"], opened: ["session:s1"], actedOn: ["session:s1"], tokens: 900 }), cand, recordTask);
  assert.equal(full.reached, "acted on a labeled record");
  assert.deepEqual([full.shown, full.opened, full.actedOn, full.memoryTokens], [["t1"], ["t1"], ["t1"], 900]);
  assert.equal(memoryPath(step(undefined, { hint: undefined }), cand, recordTask).reached, "no hint");
  assert.equal(memoryPath(step(undefined), cand, recordTask).reached, "hint, no search");
  assert.equal(memoryPath(step({ searches: 1, shown: ["session:s2"], opened: ["session:s2"] }), cand, recordTask).reached, "searched, no labeled record shown");
  assert.equal(memoryPath(step({ searches: 1, shown: ["session:s1"], opened: [] }), cand, recordTask).reached, "labeled record shown, not opened");
  assert.equal(memoryPath(step({ searches: 1, shown: ["session:s1"], opened: ["session:s1"], actedOn: [] }), cand, recordTask).reached, "labeled record opened, not acted on");

  const cost = (arm, base) => ({ arm: { perSolved: arm }, base: { perSolved: base } });
  const hintOnly = memoryPath(step(undefined), cand, recordTask);
  assert.match(memoryDiagnosis([hintOnly], cost(1, 1)), /^discovery/);
  assert.match(memoryDiagnosis([memoryPath(step({ searches: 1, shown: [], opened: [] }), cand, recordTask)], cost(1, 1)), /^capture or tasks/);
  assert.match(memoryDiagnosis([full], cost(0.12, 0.1)), /^overhead/);
  assert.match(memoryDiagnosis([full], cost(0.09, 0.1)), /^memory used/);
});

test("the pilot's verdict traces a search session's records to the tasks that left them", () => {
  const s = (task, extra) => ({ task, resolved: true, costUsd: 0.1, ...extra });
  const rows = [
    { arm: "plain", rep: 0, steps: [s("t1"), s("t2")] },
    { arm: "trim", rep: 0, steps: [s("t1"), s("t2")] },
    { arm: "search", rep: 0, steps: [s("t1", { records: [recordName("session:abc-1")] }), s("t2", { hint: true, memory: { searches: 1, shown: ["session:abc-1"], opened: ["session:abc-1"], actedOn: ["session:abc-1"] } })] },
  ];
  const v = pilotVerdict(rows, undefined, { t1: { label: "control", from: [] }, t2: { label: "candidate", from: ["t1"] } });
  assert.equal(v.path[1].reached, "acted on a labeled record");
  assert.deepEqual(v.byLabel.candidate.search, { sessions: 1, solved: 1, costUsd: 0.1 });
  assert.match(v.diagnosis, /^overhead/, "the same cost per solved task as trim is not lower");
});
