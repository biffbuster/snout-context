// Builds bench/handoff/spec-benchmark-035.json from spec-benchmark.json: the same handoffs, controls, arms,
// stages and grading, run again on the released Snout 0.3.5 bundle so the result can be claimed for it.
// Nothing about a task changes, the two whose wording proved ambiguous (tempalerts, loyaltypoints) included.
import { readFileSync, writeFileSync } from "node:fs";
const [src, out] = process.argv.slice(2);
const base = JSON.parse(readFileSync(src, "utf8"));
const spec = {
  ...base,
  name: `${base.name}, rerun on Snout 0.3.5`,
  written: "2026-11-16",
  status: "Frozen before any run on 0.3.5; no direction has been run on this bundle when frozen.",
  heldOut: `${base.heldOut} Run once before, on the build before 0.3.5 (2026-11-13: left-off note 39/40, trimming only 0/40, plain 0/40); this run repeats it on the release, with new givers, and is not a new held-out set. Two tasks proved ambiguous in that run (tempalerts: whether the alarm stays on; loyaltypoints: 50% of which total); they are kept as frozen so the two runs compare.`,
  developedFrom: "spec-benchmark.json, unchanged but for the bundle it runs on, its date and its spend",
  approvedTotalUsd: 7,
  approval: "Approved by the owner on 2026-11-16: staged, 168 sessions at most (24 givers, 144 receivers), all spend capped at $7 (the 2026-11-13 run of the same spec cost $4.42). A session starts only if its worst case (budget plus overshoot) still fits under the cap.",
  arms: {
    ...base.arms,
    giver: "Snout 0.3.5 with its defaults in enforce mode, so the session is recorded: trimming, memory on, the session-start line, the memory skill, search and fetch. Claude Code's own memory on. Empty store. One giver per handoff; every receiver starts from what it left.",
    leftoff: "Snout 0.3.5 with its defaults in enforce mode: trimming, the session-start line, the left-off note, the memory skill, search and fetch, on a copy of the giver's store. Claude Code's own memory on, from what the giver left.",
    trim: "Snout 0.3.5's trimming (enforce), memory off: no record, no session-start line, no left-off note, no memory tools. Claude Code's own memory on, from what the giver left.",
  },
};
writeFileSync(out, JSON.stringify(spec, null, 1) + "\n");
console.log(`${spec.directions.length} directions, Snout 0.3.5, cap $${spec.approvedTotalUsd}`);
