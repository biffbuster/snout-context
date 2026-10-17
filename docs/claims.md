# Every published number, and how to rebuild it

Each number Snout publishes is listed here with the results file it comes from, the command that
rebuilds it, and whether it meets the publication standard in
[benchmark-protocol.md](benchmark-protocol.md#publication-standard-fixed-2026-10-13). The rebuild needs
no API key and makes no paid call:

```bash
node bench/report.mjs <results file> --margin <pts> [--tasks A,B] [--metric effTokens] --out docs/results/<name>
```

It writes `attempts.csv` (every attempt), `summary.json` (the paired comparison, its 95% intervals
and both verdicts) and `chart.svg` (solved attempts against mean cost per attempt, both axes from
zero). Intervals come from a seeded bootstrap over tasks, so a rebuild prints the same numbers.

**Saving** means the 95% interval for the change in cost per solved attempt lies below zero.
**No quality loss** means the interval for the change in solved attempts lies above −margin.

## Results in the README

| Claim | Rebuilt result (95% CI) | Saving | Data |
| --- | --- | --- | --- |
| Long multi-step sessions, Haiku, 11 tasks × 3 runs | cost per solved **−19.4%** (−36.4% to +3.9%), 33/33 → 33/33 | not proven | [long-sessions-haiku](results/long-sessions-haiku) · `long-1791229121880.json` |
| Whole stack, Haiku, 12 tasks × 2 runs | **−25.7%** (−37.7% to −12.0%), 24/24 → 24/24 | yes | [whole-stack-haiku](results/whole-stack-haiku) · `run-1790779257454.json` |
| — its 8 bulk-path tasks | **−32.7%** (−45.2% to −18.0%), 16/16 → 16/16 | yes | [whole-stack-haiku-bulk](results/whole-stack-haiku-bulk) |
| Read gate alone, Haiku, 5 bulk-path tasks × 5 runs | **−24.3%** (−45.2% to +3.1%), 25/25 → 25/25 | not proven | [read-gate-haiku-bulk](results/read-gate-haiku-bulk) · `run-1790613461290.json` |
| Read gate alone, Sonnet, 5 bulk-path tasks × 2 runs | **−23.3%** (−47.0% to +6.7%), 10/10 → 10/10 | not proven | [read-gate-sonnet-bulk](results/read-gate-sonnet-bulk) · `run-1790709277914.json` |
| Read gate alone, Codex, 5 bulk-path tasks, effective tokens | **−22.6%** (−34.1% to −13.8%), 15/15 → 15/15; 20 attempts excluded (usage limit) | yes (tokens, not dollars) | [read-gate-codex-bulk](results/read-gate-codex-bulk) · `run-1790632506002.json` |

Commands, from the repository root (`B` is the bulk-path tasks of the read-gate runs):

```bash
B=orders,money,crash,overview,deps
node bench/report.mjs bench/ab-results/long-1791229121880.json --margin 5 --out docs/results/long-sessions-haiku
node bench/report.mjs bench/ab-results/run-1790779257454.json --margin 5 --out docs/results/whole-stack-haiku
node bench/report.mjs bench/ab-results/run-1790779257454.json --margin 5 --tasks orders,money,crash,overview,deps,suite,issue7,issue45 --out docs/results/whole-stack-haiku-bulk
node bench/report.mjs bench/ab-results/run-1790613461290.json --margin 5 --tasks $B --out docs/results/read-gate-haiku-bulk
node bench/report.mjs bench/ab-results/run-1790709277914.json --margin 5 --tasks $B --out docs/results/read-gate-sonnet-bulk
node bench/report.mjs bench/ab-results/run-1790632506002.json --margin 5 --tasks $B --metric effTokens --out docs/results/read-gate-codex-bulk
```

What these rows can and can't show:

- **Every point estimate matches the one in [benchmark.md](benchmark.md).** The intervals differ a
  little where benchmark.md also resampled runs within each task (long sessions: −37.1% to +6.0%
  there); the verdicts are the same.
- **The margin is applied after the fact.** These runs predate the standard and fixed no margin;
  5 points is the one the later confirmation runs fixed in advance.
- **"No quality loss" is weak evidence here.** Every attempt passed in both arms, so the interval
  for the solved difference is zero-width. With 5–12 tasks that can't rule out a loss a larger
  sample would show.
- **The test projects were built to contain the bulk Snout trims.** The bulk-path rows show what
  Snout saves when that bulk is on the agent's path, not on an average repository.

## Memory recall, offline

| Claim | Result | Data |
| --- | --- | --- |
| Recall brief names a file the fix needed, words checked against the repo map | **75.2%** of the 58.1% of tasks where it speaks | `recalleval-1792170581701.json` |
| — with the optional memory model (words and meaning, cut and map agreement) | **86.8%** of the 35.9% of tasks where it speaks | same file |

485 SWE-bench Verified tasks; each task's memory is the repository's last 3000 commits before the
issue was opened, one card per commit. Free and local: no agent runs, no API call. Rebuild with
`node bench/recallfloor.mjs bench/ab-results/recalleval-1792170581701.json` (from the rows) or
`node bench/recalleval.mjs --embed` (from scratch; needs the dataset, git clones and the model).

| Same, memory = real agent sessions on earlier issues, words and map | **52.2%** of the 33.2% of tasks where it speaks | `sessioneval-1792173191076.json` |
| — with the memory model | **60.5%** of the 25.6% of tasks where it speaks | same file |

The session rows use the public trajectories of one agent (mini-SWE-agent, Claude Sonnet 4.5,
`bash-only/20260217_mini-v2.0.0_claude-4-5-sonnet-high`) as cards: for each task, the sessions on
earlier issues of the same repository, never its own. A median of 33 sessions per task, against 3000
commits, and only 42.7% of tasks had an earlier session that touched a file the fix needed (the
ceiling). Rebuild with `node bench/sessioneval.mjs --embed` (downloads the trajectories, ~240 MB, free).

What it can't show: a brief that names the right file is not proof the agent then spends less or
finishes sooner, and on these sessions recall fused with the repo map found the needed files no
more often than the map alone (62.3% against 62.9% within five files). Neither saving is measured yet.

## Results not yet rebuildable from this repository

| Claim | Where stated | Status |
| --- | --- | --- |
| PointFive benchmark: cost per success **−11.9%** (−16.2% to −7.8%), 463 paired blocks, success 450/463 both arms | [benchmark-protocol.md](benchmark-protocol.md) | Pre-registered, margin 5 points, both rules met. The per-run results are in the PointFive runner's output on the old Mac, not here. **Export them to `docs/results/pointfive-confirmation/` before this number is published.** |
| Memory after compaction: 97% of facts kept vs 66% | product notes; [benchmark-protocol.md](benchmark-protocol.md) | Measured offline by `bench/retention.mjs`, but in two steps on different sets: 66% → 82% (207 compactions), then 82% → 97% (210). Its inputs are private Claude Code transcripts on the old Mac. **Before publishing:** one run comparing Claude Code's summary alone with the current build on the same compactions, and its per-fact table (no transcript text) in `docs/results/`. |
| Codex forced-read pilots (−35.0%, −25.3%, −31.9%) | internal notes, not in the repository | Synthetic, forced-read fixtures; their results files are ignored by git. Internal evidence, not public claims. |
