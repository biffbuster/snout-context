# Current release claims

Every number below was measured on the clean Snout 0.3.2 bundle. `node scripts/check-claims.mjs --strict` fails if any cited file was measured on a different build. Results from older builds are archived and do not describe 0.3.2: [0.3.1](archive/0.3.1/claims.md) and [before 0.3.1](archive/pre-0.3.1/README.md).

## Measured on 0.3.2: memory recall (offline, no agent sessions)

These replay real SWE-bench task histories against the exact 0.3.2 bundle. They measure whether Snout's recall surfaces a file the fix needed; they are not cost results.

- Repo map, held-out tasks: when the hook fires (79% of 484 tasks), a fix file is among the four it shows on 75% of them. Rows: `mapeval-heldout-1792703130665.json`.
- Memory-card recall: the shipped words gate fires on 58.1% of tasks and is right on 75.2% of those; the hybrid gate fires on 62.7% and is right on 78.0%. Rows: `recalleval-1792703719684.json`.
- Recall from earlier sessions: the words gate (with map agreement) fires on 33.2% of tasks and is right on 52.2%; the stricter hybrid gate fires on 25.6% and is right on 60.5%. An earlier session touched a needed file on only 42.7% of tasks, which caps this number. Rows: `sessioneval-1792703181497.json`.

All cited rows are in `bench/ab-results/`.

## Not measured on 0.3.2: agent cost

The last paired agent result is from 0.3.1: 140 Claude Code sessions on Sonnet over 14 tasks written alongside Snout, −25.5% cost per solved task (95% interval −39.1% to −7.6%), every attempt passing in both arms. It has not been rerun on 0.3.2. Setup, limits, raw rows and reports are in [the 0.3.1 archive](archive/0.3.1/claims.md). Codex has no matched off/on cost run.

These 0.3.2 changes have no measurement yet:

- The context Snout added after a compaction is gone, so Snout no longer restores facts after a compaction.
- Memory as it works now: a record of each session, one line at session start saying earlier sessions exist, and search and fetch tools the agent calls when it needs them. Private and shared notes written by fixed rules, with an agent's own notes kept as proposals. A frozen pilot will measure it ([memory](memory.md)). Until then, nothing here says memory saves tokens or money, or that it improves on its own.
- Trimmed MCP results are saved as plain text at an absolute path.

Each needs its own measurement on a clean 0.3.2 bundle before it is claimed anywhere.
