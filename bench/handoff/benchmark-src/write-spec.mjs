// Builds bench/handoff/spec-benchmark.json from the batch definitions.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [out, ...batches] = process.argv.slice(2);
const projects = (await Promise.all(batches.map((b) => import(pathToFileURL(b).href)))).flatMap((m) => m.projects);
const STOPS = { A: "Stop after step 1.", B: "only step 1 today, back tomorrow", C: "do step 1 and stop there", D: "Don't start step 2 yet.", E: "Leave step 2 for tomorrow." };
const grade = (p, control) => ({
  runner: "node", baseTests: [`test/${p.module}.test.js`], giverTests: ["hidden/handoff-giver.test.js"],
  ...(control
    ? { receiverTests: ["hidden/control-task.test.js", "hidden/control-scope.test.js"], receiverTaskTests: ["hidden/control-task.test.js"], receiverScopeTests: ["hidden/control-scope.test.js"], testDir: "test", refGiver: "ref-giver", refReceiver: "ref-control", refDrift: "ref-receiver" }
    : { receiverTests: ["hidden/handoff-receiver-task.test.js", "hidden/handoff-receiver-decision.test.js"], receiverTaskTests: ["hidden/handoff-receiver-task.test.js"], receiverDecisionTests: ["hidden/handoff-receiver-decision.test.js"], testDir: "test", refGiver: "ref-giver", refReceiver: "ref-receiver", refGuess: "ref-guess" }),
});
const remote = (p) => `https://git.example.com/bench/${p.name}.git`;
const directions = projects.flatMap((p) => [
  { id: `bench-${p.name}`, project: p.name, language: "javascript", remote: remote(p), condition: "natural", stopPhrasing: STOPS[p.stop], decisionKind: p.kind,
    giverPrompt: p.giverPrompt, receiverPrompt: p.receiverPrompt, expectedFact: p.expectedFact, recordPattern: p.recordPattern, repoPattern: p.repoPattern, codePattern: p.codePattern, dryRunSay: p.dryRunSay,
    grade: grade(p, false), giver: "claude", receiver: "claude" },
  ...(p.control ? [{ id: `control-${p.name}`, control: "same file, different task", giverFrom: `bench-${p.name}`, project: p.name, language: "javascript", remote: remote(p), condition: "control",
    giverPrompt: p.giverPrompt, receiverPrompt: p.control.receiverPrompt, askedTask: p.control.askedTask, leftAlone: p.control.leftAlone, recordPattern: p.recordPattern, codePattern: p.codePattern,
    grade: grade(p, true), giver: "claude", receiver: "claude" }] : []),
]);
// Stage 1: the first six handoffs written (batch 1, one per stop phrasing, and carbonlog), left-off against
// plain only. Stage 2: the other directions, every arm, then stage 1's remaining receivers from its givers.
const STAGE1 = ["bench-tipjar", "bench-libraryfines", "bench-parkingmeter", "bench-gradebook", "bench-rentsplit", "bench-carbonlog"];
const ids = directions.map((d) => d.id);
const stages = {
  1: { directions: STAGE1, receivers: ["leftoff", "off"], ceilingUsd: 2.2,
    gate: "Stage 2 starts only if every session is valid, no direction was stopped by the cap or the API, both receivers ran in every handoff whose giver passed its gate, and Snout is ahead: more handoffs where the left-off receiver succeeded and the plain one did not than the reverse. Otherwise the run stops and stage 1 is reported as the result." },
  2: { directions: [...ids.filter((id) => !STAGE1.includes(id)), ...STAGE1],
    note: "Stage 1's handoffs go on from their givers (--after the stage 1 results) with the receivers they have not run (trim, then the second repeat), so every handoff ends with the same six receivers. Stage 1's results count in the final." },
};
const spec = {
  name: "Handoff benchmark: does the next session do the deferred step and honor a decision only the earlier session was told, with Snout as shipped, trimming alone, and plain Claude Code",
  written: "2026-11-12",
  status: "Frozen before any run; no direction has been run on a model when frozen.",
  purpose: "A held-out, published measure of cross-session continuity. Each handoff: a giver session fixes a small bug (step 1) and is told to stop for the day, with step 2 and two decisions for it only in its prompt; a fresh receiver session is asked to continue. Success needs step 2 done and both decisions honored, graded by hidden tests. Controls: a receiver asked for an unrelated small change in a file the giver changed must do that and leave step 2 alone.",
  heldOut: "Every project and prompt here is new for this benchmark; none was used to develop Snout's left-off note, record or search. Written after the Better Auth pilot (2026-11-12); its stop phrasing is one of five here, not the only one. Before any freeze, the free note check (bench/benchmark-notes.mjs) found one phrasing (\"Let's just do step 1 today\") quoted in the note; the stop check was widened in general (\"let's\" as a lead-in, with a unit test). No outcome test was used to change Snout.",
  developedFrom: "spec-continuity.json and spec-leftoff.json: the same harness, grading and validity rules",
  ownMemory: "claude", skill: true, keepGiverHistory: true, benchmarkArms: true, repeats: 2,
  settings: { claudeCode: "2.1.306", claudeModel: "claude-sonnet-5-5", budgetUsd: "0.25", limitMinutes: 30, overshootUsdPerSession: 0.2 },
  approvedTotalUsd: 9,
  approval: "Approved by the owner on 2026-11-13: staged, 168 sessions at most (24 givers, 144 receivers), all spend capped at $9 (expected about $7). A session starts only if its worst case (budget plus overshoot) still fits under the cap.",
  budgetNote: "Per-session budget $0.25: more than twice the costliest session in the 2026-11-11 runs on projects of this size ($0.113), the same for every arm. It is lowered from $0.40 so the worst-case check lets the whole run fit under the approved total.",
  stages,
  arms: {
    giver: "Snout as it ships, so the session is recorded: trimming (enforce), memory on, the session-start line, the memory skill, search and fetch. Claude Code's own memory on. Empty store. One giver per handoff; every receiver starts from what it left.",
    leftoff: "Snout as it ships (0.3.4 defaults plus the stop fix): trimming, the session-start line, the left-off note, the memory skill, search and fetch, on a copy of the giver's store. Claude Code's own memory on, from what the giver left.",
    trim: "Snout's trimming as it ships (enforce), memory off: no record, no session-start line, no left-off note, no memory tools. Claude Code's own memory on, from what the giver left.",
    off: "Plain Claude Code: no Snout. Its own memory on, from what the giver left.",
  },
  stopPhrasings: STOPS,
  decisionKinds: { rules: "two rules a stakeholder gave", corrected: "a value given, then changed in the same prompt: only the corrected one is right", option: "one of two proposals chosen; the other named and turned down" },
  conditions: { natural: "the giver's prompt ends as a user would when stopping for the day", control: "a handoff's giver, then a prompt that names a file the giver changed and asks for a different small change" },
  order: "Per handoff: the giver, then its receivers (leftoff, trim, off, then the repeats), each from the giver's snapshot. Staged as in stages.",
  scoring: {
    success: "the receiver's task tests and decision tests both pass, with the project's own tests and the giver's check; reported apart as task passed and decision honored",
    control: "the asked change passes its tests and the step left for later was not started (control-scope)",
    cost: "per arm: (givers' cost, shared + that arm's receivers' cost) / that arm's successes; every session at the higher of its transcript price and Claude Code's own",
    beforeFirstEdit: "tokens and tool calls before the receiver's first edit to a project file",
    paired: "per handoff, both repeats of an arm count; a sign test on handoffs where the arms differ (leftoff vs off, leftoff vs trim)",
    ownMemory: "after each giver: whether Claude Code's own memory states the decision; reported, since off and trim may legitimately succeed through it",
    gate: "receivers run only if the giver solved step 1 and its Snout record states the decision (recordPattern)",
  },
  freeChecks: [
    "--grade-check: unchanged projects fail the giver's tests; references pass; the giver's reference fails the receiver's tests; a guess without the decision (ref-guess) passes the task tests and fails the decision tests; a control's drift reference fails its scope tests",
    "a stand-in dry run (SWE_FAKE_AGENT=1) of every direction with every arm valid",
    "the left-off note for each giver prompt, as the frozen build writes it, carries the decision and not the stop phrasing",
  ],
  validity: [
    "As spec-leftoff.json, and: the trim arm never reaches the memory tools, the session-start line or the left-off note.",
    "Each receiver starts from the giver's snapshot and Claude Code memory, never from another receiver's.",
    "A session that could pass the approved total does not start.",
  ],
  reporting: "Every handoff and every arm, including losses and invalid sessions; the claim names its scope: synthetic projects, Claude Code with Sonnet 5.5, one giver session per handoff.",
  directions,
};
writeFileSync(out, JSON.stringify(spec, null, 1) + "\n");
console.log(`${directions.length} directions from ${projects.length} projects`);
