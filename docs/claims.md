# Current release claims

Snout 0.3.1 has not yet completed a paired, held-out agent benchmark on this Windows machine. We therefore make no current cost, token-savings, or no-quality-loss score claim here.

Historical results and their raw rows are preserved in [the pre-0.3.1 archive](archive/pre-0.3.1/README.md). They measured older builds and do not establish the performance of 0.3.1.

The next candidate score is cost per solved task for Claude Code with Snout off versus on, using the same shipped build, task set, model, and machine. Report each arm's solved count and a task-bootstrap 95% interval. Codex must receive its own matched off/on run; effective tokens on a plan are a token proxy, not a billed-dollar cost. See [the benchmark protocol](benchmark-protocol.md#publication-standard-fixed-2026-10-13).

## Measured on 0.3.1: memory recall (offline, no agent sessions)

These replay real SWE-bench task histories against the exact 0.3.1 bundle. They measure whether Snout's recall surfaces a file the fix needed; they are not cost results.

- Repo map, held-out tasks: when the hook fires (79% of 484 tasks), a fix file is among the four it shows on 75% of them. Rows: `mapeval-heldout-1792439823459.json`.
- Memory-card recall: the shipped words gate fires on 58.1% of tasks and is right on 75.2% of those; the hybrid gate fires on 62.7% and is right on 78.0%. Rows: `recalleval-1792440321865.json`.
- Recall from earlier sessions: the words gate (with map agreement) fires on 33.2% of tasks and is right on 52.2%; the stricter hybrid gate fires on 25.6% and is right on 60.5%. An earlier session touched a needed file on only 42.7% of tasks, which caps this number. Rows: `sessioneval-1792440345025.json`.

The strict publication check passes only while every file cited here was measured on the clean bundle being published. Cost per solved task for 0.3.1 is not claimed until the paired agent run above is complete.
