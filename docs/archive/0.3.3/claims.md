# Snout 0.3.3 claims (archived)

These results were measured on the clean Snout 0.3.3 bundle and do not describe later releases. Raw rows stay in `bench/ab-results/`. The current release's claims are in [../../claims.md](../../claims.md). Older: [0.3.2](../0.3.2/claims.md), [0.3.1](../0.3.1/claims.md), [before 0.3.1](../pre-0.3.1/README.md).

## Measured on 0.3.3: Claude Code cost per solved task

Claude Code 2.1.306 with Sonnet, billed through the API, on one Windows machine. The 14 tasks in `bench/ab.mjs` were each run 5 times with Snout off and 5 times with Snout on (`enforce`): 140 sessions. Every session had the same $1.00 budget. The run cost $6.31 in total.

| Tasks | Solved, off → on | Cost per solved task, off → on | Change | 95% interval |
| --- | --- | --- | --- | --- |
| All 14 | 70/70 → 70/70 | $0.0515 → $0.0386 | −25.0% | −38.2% to −9.5% |
| 10 bulk-path tasks (`BULK` in `bench/ab.mjs`) | 50/50 → 50/50 | $0.0570 → $0.0403 | −29.3% | −44.3% to −11.2% |
| 4 control tasks with little to trim | 20/20 → 20/20 | $0.0376 → $0.0343 | −8.7% | −24.1% to +3.5% |

The interval for all 14 tasks lies entirely below zero, which meets the protocol's rule for a savings claim. The control tasks' interval crosses zero, so there is no claim for them. Intervals are paired task-bootstrap intervals from `bench/report.mjs`.

Five of the 14 tasks cost more with Snout on, comparing the mean of their five pairs: `usersCompound` +6.9%, `pricing` +5.2%, `usersRead` +4.4%, `crash` +4.2% and `cart` +1.3%. Snout denied or trimmed nothing on four of them and once on `crash`; the agent took a few more turns. The savings came where Snout acted: `money` −63.4%, `orders` −53.8%, `issue45` −41.1%, `issue7` −40.7%.

Quality: every attempt passed in both arms. That is not enough to claim no quality loss. With 14 tasks the protocol's one-sided 95% lower bound is −19.3 points, below the −5 point margin set before the run.

- Rows: `run-sonnet-1794248492505.json`. Its first round was run with all 14 tasks at one repeat; rounds 2 to 5 were added with `--resume` on the same build, harness and runtime, as for 0.3.1.
- Report: [docs/results/claude-sonnet-0.3.3](../../results/claude-sonnet-0.3.3/) (attempts.csv, summary.json, chart.svg). Rebuild it without a key: `node bench/report.mjs bench/ab-results/run-sonnet-1794248492505.json --margin 5`. The bulk and control rows come from the same command with `--tasks` set to the task names; their reports are in [claude-sonnet-0.3.3-bulk](../../results/claude-sonnet-0.3.3-bulk/) and [claude-sonnet-0.3.3-control](../../results/claude-sonnet-0.3.3-control/).
- The tasks were written alongside Snout, so they are not a sample of real work. Codex has no matched off/on run on 0.3.3, so there is no Codex cost claim.

## Measured on 0.3.3: fresh install (no model, no network)

Snout is installed the way the README says, into an empty home and config folder: as the Claude Code plugin, and with `npm install -g` and `snout init codex` for Codex. Each agent's hooks then run on stand-in sessions in a new project. All 12 checks pass:

- Installing writes nothing to the home or config folder.
- Observe is the default, and in observe the agent gets no memory text.
- Enforce alone adds no note. With notes turned on, the agent gets the test command and where it came from.
- No hook fails or writes to stderr.
- The local index is in the config folder, one per project, never in the project.

Rows: `fresh-install-1794240029327.json`. This checks that the install works as documented. It is not a cost or quality result.

## Not measured on 0.3.3

The cost result above measures trimming (the gate and squeeze) in Claude Code. The earlier 0.3.1 result on the same tasks is in [the 0.3.1 archive](../0.3.1/claims.md). Codex has no matched off/on cost run on 0.3.3.

These have no measurement yet:

- Memory as it works now: a record of each session, one line at session start saying earlier sessions exist, and search and fetch tools the agent calls when it needs them. Nothing here says memory saves tokens or money, or that it improves on its own ([memory](../../memory.md)).
- `snout import`: commits, PRs, failed CI runs and past sessions in memory search.
- Since 0.3.2: Snout no longer restores facts after a compaction, and trimmed MCP results are saved as plain text at an absolute path.

Each needs its own measurement on a clean bundle before it is claimed anywhere.
