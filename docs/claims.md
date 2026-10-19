# Current release claims

Every number below was measured on the clean Snout 0.3.1 bundle. `node scripts/check-claims.mjs --strict` fails if any cited file was measured on a different build. Results from older builds are in [the pre-0.3.1 archive](archive/pre-0.3.1/README.md) and do not describe 0.3.1.

## Measured on 0.3.1: Claude Code cost per solved task

Claude Code with Sonnet, billed through the API, on one Windows machine. The 14 tasks in `bench/ab.mjs` were each run 5 times with Snout off and 5 times with Snout on (`enforce`): 140 sessions. Every session had the same $1.00 budget, and which arm runs first alternates by task and round. The tasks were written alongside Snout as a release regression set, not taken from outside repositories, so this result does not estimate savings on other codebases. See [the benchmark protocol](benchmark-protocol.md#publication-standard-fixed-2026-10-13).

| Tasks | Solved, off → on | Cost per solved task, off → on | Change | 95% interval |
| --- | --- | --- | --- | --- |
| All 14 | 70/70 → 70/70 | $0.1090 → $0.0812 | −25.5% | −39.1% to −7.6% |
| 10 bulk-path tasks (`BULK` in `bench/ab.mjs`) | 50/50 → 50/50 | $0.1257 → $0.0869 | −30.9% | −44.6% to −10.2% |
| 4 control tasks with nothing to trim | 20/20 → 20/20 | $0.0672 → $0.0670 | −0.3% | −10.6% to +6.7% |

The interval for all 14 tasks lies entirely below zero, which meets the protocol's rule for a savings claim. Intervals are paired task-bootstrap intervals from `bench/report.mjs`.

One task cost more with Snout on: `deps`, +20% over its 5 pairs. Snout withheld and trimmed nothing in those sessions; the extra cost came from extra turns.

Quality: every attempt passed in both arms. That is not enough to claim no quality loss. With 14 tasks the protocol's one-sided 95% lower bound is −19.3 points, below the −5 point margin set before the run.

- Rows: `run-sonnet-1792440413748.json`. Its first round is the 28-session run `run-1792440413748.json`, copied with the plan set to 5 rounds; rounds 2 to 5 were added with `--resume` on the same build, harness and runtime.
- Report: [docs/results/claude-sonnet-0.3.1](results/claude-sonnet-0.3.1/) (attempts.csv, summary.json, chart.svg). Rebuild it without a key: `node bench/report.mjs bench/ab-results/run-sonnet-1792440413748.json --margin 5`. The bulk and control rows come from the same command with `--tasks` set to the task names; their reports are in [claude-sonnet-0.3.1-bulk](results/claude-sonnet-0.3.1-bulk/) and [claude-sonnet-0.3.1-control](results/claude-sonnet-0.3.1-control/).
- Codex has no matched off/on run on 0.3.1, so there is no Codex cost claim.

## Measured on 0.3.1: memory recall (offline, no agent sessions)

These replay real SWE-bench task histories against the exact 0.3.1 bundle. They measure whether Snout's recall surfaces a file the fix needed; they are not cost results.

- Repo map, held-out tasks: when the hook fires (79% of 484 tasks), a fix file is among the four it shows on 75% of them. Rows: `mapeval-heldout-1792439823459.json`.
- Memory-card recall: the shipped words gate fires on 58.1% of tasks and is right on 75.2% of those; the hybrid gate fires on 62.7% and is right on 78.0%. Rows: `recalleval-1792440321865.json`.
- Recall from earlier sessions: the words gate (with map agreement) fires on 33.2% of tasks and is right on 52.2%; the stricter hybrid gate fires on 25.6% and is right on 60.5%. An earlier session touched a needed file on only 42.7% of tasks, which caps this number. Rows: `sessioneval-1792440345025.json`.

All cited rows are in `bench/ab-results/`.
