// Builds bench/handoff/spec-benchmark-codex.json from spec-benchmark.json: the same handoffs, controls, arms
// and stages, with Codex as the receiver. The givers are not run again: each direction starts from the
// Claude Code giver of the 2026-11-13 live run, so the two results differ only in the receiving agent.
import { readFileSync, writeFileSync } from "node:fs";
const [src, out] = process.argv.slice(2);
const base = JSON.parse(readFileSync(src, "utf8"));
const spec = {
  ...base,
  name: "Handoff benchmark, Codex receivers: does a Codex session do the deferred step and honor a decision only an earlier Claude Code session was told, with Snout as shipped, trimming alone, and plain Codex",
  written: "2026-11-13",
  status: "Frozen before any run; no Codex receiver has been run on a model when frozen.",
  purpose: `${base.purpose} Here the receiver is Codex and the giver is Claude Code: the case Claude Code's own memory cannot cover.`,
  developedFrom: "spec-benchmark.json, unchanged but for the receiving agent, its settings and its spend",
  giversFrom: ["bench/handoff/results-2026-11-13-benchmark.json", "bench/handoff/results-2026-11-13-benchmark-2.json"],
  settings: { ...base.settings, codex: "0.163.0", codexModel: "gpt-6.1-sol", codexEffort: "low" },
  approvedTotalUsd: 0,
  approval: "Stage 1 approved by the owner on 2026-11-13: 12 Codex sessions (6 handoffs, leftoff and off), API spend $0 (the givers are reused, no Claude Code session runs); Codex sessions are billed to the ChatGPT plan. Stage 2 (132 sessions) needs its own approval after the gate.",
  budgetNote: "Codex takes no per-session budget; every session has the same time limit. Its cost is reported at list price as the plan's equivalent.",
  stages: {
    1: { ...base.stages[1], ceilingUsd: 0 },
    2: base.stages[2],
  },
  arms: {
    giver: "Reused: the Claude Code giver of the 2026-11-13 live run, with its Snout store, snapshot and git history.",
    leftoff: "Snout as it ships for Codex (`snout init codex` hooks): trimming, the session-start line, the left-off note, search and fetch, on a copy of the giver's store.",
    trim: "Snout's trimming as it ships for Codex, memory off: no record, no session-start line, no left-off note, no memory tools.",
    off: "Plain Codex: no Snout memory. Codex's own memories are not copied and must not change during a session.",
  },
  scoring: { ...base.scoring, cost: "per arm: that arm's receivers' list-price cost / its successes; the givers were paid in the Claude Code run", ownMemory: "not applicable: Claude Code's memory does not reach Codex" },
  reporting: "Every handoff and every arm, including losses and invalid sessions; the claim names its scope: synthetic projects, Claude Code giver with Sonnet 5.5, Codex receiver, one giver session per handoff.",
  directions: base.directions.map((d) => ({ ...d, receiver: "codex" })),
};
delete spec.ownMemory;
writeFileSync(out, JSON.stringify(spec, null, 1) + "\n");
console.log(`${spec.directions.length} directions, Codex receivers, givers from ${spec.giversFrom.length} result files`);
