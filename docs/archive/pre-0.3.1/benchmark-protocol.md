# Benchmark protocol (pre-registered)

> Historical protocol and pilot log. The measurements below were made on older builds and are
> archived evidence, not current 0.3.1 scores. See [current benchmark status](benchmark.md) and
> [the pre-0.3.1 archive](archive/pre-0.3.1/README.md). Rerun the specified tasks on the exact
> shipped build before making a current performance claim.

Written 2026-10-06, before any task was selected or run. Every choice below is fixed in advance so
the result can't be tuned after the fact. Changes after a run are listed under "Amendments" with
the date and reason. A run that breaks this protocol is reported as such, not quietly rerun.

## Pilot: Snout on public coding tasks (`bench/swe.mjs`)

**Purpose.** Measure how much Snout's cost effect varies on real repositories we did not write,
so the full run can be sized to give a 95% interval that excludes zero. The pilot is not used for
any public savings claim.

**Tasks.** [SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)
(500 human-validated GitHub issues). Eligible: repositories that are pure Python, so the agent's
working copy can be mounted into the task container (django, sympy, sphinx, xarray, pytest,
pylint, requests, seaborn, flask); difficulty below ">4 hours". Excluded: matplotlib,
scikit-learn and astropy, whose compiled extensions don't survive the mount. **15 tasks**, drawn
at random with seed `20261006`, at most 5 from one repository. The draw is printed by
`node bench/swe.mjs --select` and saved in `bench/swe-tasks.json` before any run.

**Arms.** Claude Code headless, model Haiku, same prompt, same tools.
- **off:** Snout records only (the async observe hook; it changes nothing the agent sees).
- **on:** Snout enforcing: read gate, section reads, repeat skip, Squeeze.

Each arm runs each task **2 times** (60 sessions). Cap $2.00 and 30 minutes per session. No
project instructions, no user settings, no plugins, no MCP servers. The agent sees the issue text
only (no hints). `python`, `python3` and `pytest` on its PATH run inside the task's official
container, with its working copy mounted, so it types the commands it normally would.

**Grading.** Quality is graded by the **official SWE-bench harness** (`swebench` 5.0.2, prebuilt
task images): a task is resolved when its FAIL_TO_PASS tests pass and its PASS_TO_PASS tests still
pass. The agent never sees those tests. Snout plays no part in grading.

**Metrics.**
- Primary: change in total cost, on vs. off, with a 95% bootstrap interval (resample tasks, then
  runs within each task; seeded).
- Secondary: input tokens (cached and uncached), output tokens, turns, tokens Snout kept out.
- Quality: resolved rate per arm, and tasks resolved in one arm but never in the other.
- Reliability: **Pass^k**, the share of tasks resolved in every run, per arm, with an exact
  two-sided sign test on tasks resolved every run in one arm and not the other. Trimming can make
  an always-solved task sometimes-solved before it makes anything unsolvable (Min et al., 2026,
  arXiv:2609.36526), and the mean resolved rate hides that.
- Recovery cost: later reads of files Snout trimmed or denied, and their tokens (they are already
  inside the totals; this shows how much of the saving the agent spends getting content back).
- Peak context: the largest single model call per session.
- Snout's own cost: any Jev spend is added to the enforce arm's cost. Text Snout puts in front of
  the agent is already inside the agent's measured tokens.

**Exclusions.** Only infrastructure failures: Docker or API errors before the agent's first turn.
Each one is rerun once and listed in the results. Sessions that hit the cost or time cap count as
run and unresolved.

**What the pilot decides.**
1. If the point estimate of the cost change is weaker than −5%, stop: Snout doesn't save on
   ordinary issue-fixing work, and that finding is published as it is.
2. Otherwise, size the full run from the pilot's per-task variance: the number of tasks at which
   the expected 95% interval excludes zero, plus 20%.
3. Any task resolved in every off run and no on run is investigated before the full run, as a
   possible regression.

**Frozen inputs.** Snout git commit and `dist/snout.mjs` hash, Claude Code version, the model ID
and the `swebench` version are recorded in the results file.

## Track A: file classification (`bench/gold.mjs`)

Written 2026-10-06, before any label in this set was collected.

**Question.** For each file: is it machine-owned (generated, vendored, lockfile, minified,
snapshot, binary) or hand-authored content a developer maintains? This is the claim Snout's
read gate makes before it trims a file. Trimming a hand-authored file is a **harmful trim**.

**Files.** The 100-repo corpus pinned in `bench/manifest.json` (15 languages, path, size and
first 2 KB of every file). Files labeled in earlier runs are excluded: rules were tuned against
them. Seed `20261006`. Two pools, reported separately and never mixed:
- **Random:** 1,500 files, at most 30 per repository. Shows the real-world mix.
- **Decided:** 500 further files that Snout's rules act on, so trim precision has enough cases.

**Labels.**
1. Every file: Snout's rules (free) and Jev 1.13 (about $0.10 in total).
2. Opus 5.5 labels every file where Snout and Jev disagree or Jev errored, plus a random audit of
   75 agreed "machine-owned" and 75 agreed "source" files. The audit measures how often an
   agreed label is wrong. That rate is published next to the results.
3. Final label: Opus where it labeled the file, otherwise the agreed label.
4. A human checks every low-confidence Opus label (below 0.7) and a random 50 of the rest.
   Corrections replace Opus's label, and the human–Opus agreement rate is published.

Because only disagreements go to Opus, a file Snout and Jev both get wrong keeps the wrong
label. The audit bounds that error, and it is reported, not hidden.

**Judges scored.** Snout's rules (trim = value 0), Jev, and two free baselines fixed now: path
rules (dependency, build and vendor directories, lockfile names, `.min.js`, `.map`, `.snap`) and a
100 KB size cap. Opus is the reference, so it is not scored.

**Metrics, per pool.** Harmful-trim rate (share of trims that hit hand-authored files, Wilson 95%
interval), recall (share of machine-owned files trimmed), precision, cost per 1,000 files and
latency.

**Claim threshold.** Snout's harmful-trim rate is called "safe" only if the upper end of its 95%
interval on the random pool is at or below 2%.

## Full run (to be fixed after the pilot, before it runs)

Planned shape, to be finalised with the pilot's numbers:
- A fresh random draw that excludes the pilot tasks, sized as above; Haiku and Sonnet.
- **Savings claim** only if the 95% interval for the cost change lies entirely below zero.
- **"No quality loss" claim** only if the 95% interval for the change in resolved rate has a
  lower bound above −5 points (non-inferiority).
- All runs published with the harness and raw rows; one command reruns any arm.

## Amendments

**2026-10-06, after one smoke session (sympy__sympy-15875, Snout on), before the pilot.** The
smoke session is not part of the pilot.
1. The agent first ran Python through a `./py` wrapper. Snout's Squeeze only engages on known
   commands (`pytest`, `python -m pytest`, …), so the wrapper would have switched it off and
   understated Snout. Replaced with `python`, `python3` and `pytest` on the agent's PATH.
2. The smoke session cost $0.68 over 71 turns, close to the $1.00 cap. A cap that cuts sessions
   short in one arm more than the other biases the comparison, so it is now $2.00 per session.

**2026-10-06, after the Track A sample and Jev labels were built, before any Opus label or
score.** Three of Snout's trim rules don't claim a file is machine-owned: `license` (legal
boilerplate), `secret` (kept out of context for safety) and `always-deny` (the user's own deny
list). They are scored apart as policy trims, with their count and labels reported, instead of
as harmful trims. Snout's headline harmful-trim rate covers the rules that claim machine-owned
content: binary, generated, lockfile, minified and vendored.

**2026-10-06: pilot paused after 2 of 60 sessions** to save plan usage. It resumes after Track A
and the product fixes it points to; those 2 sessions are discarded, and the pilot reruns in full.

**2026-10-06, before any counted pilot session.** Added the reliability, recovery-cost,
peak-context and Snout-cost metrics above (`bench/stats.mjs`). The sign test reproduces the
published p-values of Min et al. (Table 8). Snout itself changed before the pilot: Squeeze now
recognises Django's and unittest's runners, keeps traceback and file-and-line locations, and names
the files a grouped search leaves out. The pilot measures that version.

**2026-10-06: repo map arm added, before any map session.** `bench/swe.mjs` gains a third arm,
`map` (Snout enforcing plus repo-map file suggestions on the prompt), compared with both `off`
and `enforce` so the map's own effect is separate from the rest of Snout. Extra metrics for that
arm: suggestions made, their tokens, and the share of suggested files the agent opened. Offline,
on the 485 held-out Verified tasks, the map put a file the real fix edited in its top 10 for 49%
of tasks, against 40% for BM25 and 25% for identifier grep (`bench/mapeval.mjs --heldout`). The
task slices and runs per arm for the agent A/B are fixed here before it starts.

**2026-10-06: repo map fixed and re-scored.** Using the map on this repository showed two design
bugs: a name typed exactly as declared was dropped when only one file contained it, and plain
English words in a request counted as anchors. Both were fixed from that example, not from the
held-out results, but the 485 held-out tasks have now been scored twice, so the second result
(top 10: map 62%, BM25 40%, grep 25%) is confirmed on tasks neither version has seen before it is
published: the SWE-bench full test split minus Verified.

**2026-10-06: repo map confirmed on unseen tasks.** On the SWE-bench full test split minus all of
Verified (1,788 tasks, neither map version scored on them before; `bench/mapeval.mjs --confirm`),
a file the real fix edited was in the top 10 for 57% of tasks (map), 34% (BM25) and 28%
(identifier grep): map − BM25 +23.1 points, 95% CI +20.7 to +25.4, sign test p = 1.7e-79. The map
leads BM25 on all 12 repositories. This is the published figure; the Verified numbers are
development results.

**2026-10-06: Track A v2, fixed before it is built.** files-v1 found three harmful trims and a
snapshot rule that asked about hand-written fixtures; the rules were fixed against it (root-only
`deps/`, no weak generator marker inside a quoted string, no plain `fixtures/` folders). A combined
judge was chosen on files-v1: trim when Snout's rules trim, or when Jev says machine-owned with
probability at least 0.99 (files-v1 random pool: catch rate 50% → 66%, harmful trims 2 of 131).
Because both were tuned on files-v1, they are scored on **files-v2**: 2,000 new files from the same
corpus, seed `20261007`, excluding every file in files-v1 and earlier label runs, built and labeled
exactly as files-v1. The 2% safety threshold applies to files-v2.

## PointFive AI Efficiency Benchmark (primary public benchmark)

Independent benchmark (PointFiveLabs/ai-efficiency-benchmark v1.0.0): Claude Code on six pinned
repositories plus a synthetic repo, deterministic judges, paired arms per block, metric **billed
cost per successful run**. Snout runs as an extra arm through a minimal fork of its runner
(`runner_snout.py`: Snout arm, arm selection, `.snout/` ignored by the judge as `.claude/` is,
real Claude Code version recorded, results kept apart from the retained data). Billing is real
API billing.

**2026-10-06, calibration + C1 (development).** Snout 7101eb35 (enforce + repo map), Haiku,
106 clean paired blocks ($9.75): cost per success −8.8% (task-clustered 95% CI −24.7% to +9.3%),
success 95 vs 93. Transcript review found two Snout defects behind the largest losses: the size
cap judged ranged reads by the whole file (a 400-line read of a 1.4 MB log was asked about, which
headless runs treat as a refusal), and search grouping fired on small results whose paths were
long. Both are fixed in Snout 457e4acd. Because they were found on C1, C1 is a development result.
The fixed build is measured next on the expansion split (`e_char_c1`, tasks not in C1), and that
is the first result eligible for publication. The interval must lie below zero to claim a saving.

**2026-10-06: confirmation phases, fixed before any of them runs.**
- Snout build: `6b4af03d` (the C1 fixes, plus repo-map ranking tuned on C1's prompts only:
  prose files rank below code, plain words of four letters or fewer are never anchors). On
  SWE-bench Lite its strict Acc@5 rose from 54.7% to 63.7%.
- Arms: plain Claude Code and Snout (enforce + repo map), paired per block, order randomised by
  the runner. No change to Snout between phases.
- Phases, all on tasks C1 did not use: `e_char_c1` (Haiku), `e_char_c2` (Sonnet), `e_char_opus`
  (Opus), `holdout` and `e_holdout` (Haiku and Sonnet).
- **Primary result:** cost per successful run, Snout vs. plain Claude Code, pooled over every
  confirmation block, with a 95% interval from a bootstrap that resamples tasks. Power check on C1's
  variance: about ±10.5 points with the 77 unseen tasks.
- **Claim rule:** "cheaper per successful task" only if the interval's upper end is below zero;
  "no loss in success" only if successes in the Snout arm are not lower by more than 5 points
  (bootstrap interval lower bound above −5).
- Secondary, reported whatever they show: per-model rows, per-family rows, Pass^k where blocks
  repeat, turns, and infrastructure failures (excluded and listed).

**2026-10-06: map build b4aaac44 confirmed on unseen tasks.** SWE-bench full test split minus
Verified (1,788 tasks): a fix file in the top 10 for 66% of tasks (was 57%), full-text BM25 44%,
identifier grep 28%; strict Acc@5 (every edited file in the top 5) 49.4% vs 29.3% for full-text
BM25. Map vs full-text BM25 isn't separately bootstrapped here; map vs identifier BM25: +32.0
points at top 10 (95% CI +29.7 to +34.3).

**2026-10-07, before the confirmation run: final build `6b4af03d` and both estimators.** Re-analysing
C1 with PointFive's own primary contrast (P4: paired cost difference per task where both arms
succeed, tasks weighted equally) gave −1.9% (95% CI −14.7% to +11.8%), against −8.8% for cost per
success: Snout's saving concentrates on long, expensive tasks, and on short ones the map's list
cost about what it saved. So the map now offers at most 4 files (was 8) and fires only when the
prompt names a declared identifier verbatim. The confirmation run reports both cost per success
(primary, the total-bill measure PointFive also headlines) and P4 (secondary), whatever they show.
Claude Code is pinned for the campaign (no
auto-update) and the runner resumes after an interruption without rerunning finished runs.

**2026-10-07: confirmation result (PointFive, Snout `6b4af03d`).** 463
paired blocks on 77 unseen tasks (Haiku 264, Sonnet 166, Opus 33), 1,389 runs, $56.81 billed, no
infrastructure failures. Analysis exactly as pre-registered (`analyze_snout.py`):

| vs. plain Claude Code | Cost per success (95% CI) | PointFive P4 (95% CI) | Success |
|---|---|---|---|
| **Snout** | **−11.9% (−16.2% to −7.8%)** | **−9.9% (−13.7% to −6.3%)** | 450/463 vs 450/463 |

Both claim rules pass for Snout: the interval lies below zero, and success is not lower (difference
0.0 points, 95% CI −1.5 to +1.7). Per model: Haiku −15.8% (CI −23.7% to −8.2%); Sonnet −9.8% (CI −15.4% to −3.7%) with success
2.4 points lower (CI −5.5 to 0.0, so the no-loss rule is not met for Sonnet alone); Opus −5.8% (CI
−14.0% to +2.7%, 33 blocks, not significant). Of the four Sonnet blocks plain Claude Code passed and
Snout failed, three had no Snout intervention (arithmetic and answer errors); one was a Snout defect,
fixed after the campaign: after `cd lib` Snout wrote its bookkeeping folder inside `lib/`, which the
judge counted as an edit. The published numbers are this run's, not a rerun with the fix.

**2026-10-07: latency confirmation on Haiku 5.5, fixed before it runs.** Phase `lat_h55`: the 49
expansion tasks, Claude Haiku 5.5 (`claude-haiku-5-5`), high effort, 2 repeats (98 blocks). Arms in
the same blocks: plain Claude Code, Snout `610d93e4` with command hooks, and the same
build with fast hooks (the gate and Squeeze as HTTP hooks to one `snout serve`, started before the
phase from the frozen build, in a clean home directory). In both Snout arms Stop and PreCompact
are asynchronous, as in the shipped plugin (the earlier campaign ran them blocking). Claude Code
2.1.293. Primary latency metric: per-block wall-clock difference vs. plain Claude Code, averaged
within each task, 95% interval from a task bootstrap. The claim "adds at most X seconds" uses the
interval's upper end as X. Cost per success and success are reported for all arms by the
pre-registered analysis; these tasks were already used, so this phase is a confirmation of latency
and a current-model row, not a new savings claim.

**2026-10-07: latency confirmation result (Haiku 5.5, 98 blocks, 392 runs, $0.69).** Paired
wall-clock difference vs. plain Claude Code (mean of per-task means, 95% CI): Snout with command hooks +0.70 s (+0.22 to +1.16); **Snout with fast hooks +0.12 s (−0.50 to
+0.75)**. Median wall-clock: plain 5.44 s, Snout 6.08 s, Snout fast 5.77 s; p95: 11.02 s,
15.20 s, 11.26 s. So fast hooks add at most 0.75 s per task by the pre-registered rule, and
the difference from plain Claude Code is not distinguishable from zero. Cost per success on Haiku
5.5 (secondary; tasks already used): Snout −2.5% (−8.5% to +3.7%), Snout
fast −4.2% (−11.1% to +3.1%), none significant; success 98/98 in every arm. Haiku 5.5 finishes these
tasks in about 3 turns at $0.0018 each, leaving little for any layer to save on this task mix.

**2026-10-07: SWE-bench Verified pilot moves to Claude Haiku 5.5, fixed before it runs.** Same 15
tasks (seed `20261006`, `bench/swe-tasks.json`), official SWE-bench grading, 2 runs per arm. Arms:
plain Claude Code (`off`) and Snout enforcing with the repo map (`map`, build in the results file).
Claude Code 2.1.293, `claude-haiku-5-5`, billed to an API key (`--api`), cap $2.00 per session.
Snout's gate runs as command hooks here: this run measures cost and quality, not latency. Metrics as
in the pilot section, plus the format the context-compression literature reports on SWE-bench
Verified: total billed tokens relative to plain Claude Code at the observed resolve rates. Still a
pilot: it sizes the full run and is not a published claim.


**2026-10-08: SWE pilot harness change, mid-run.** Sessions 24–34 measured a Docker Desktop
file-sharing hang (macOS bind mounts stopped answering; `python` froze), not the agent. They are
kept in the results file under `excluded`. The harness no longer bind-mounts: each session has its
own container, and before each `python`/`pytest` call the files the agent changed (and any script
outside the repo it runs) are copied in. The 22 sessions that ran before the hang used the old
harness, which cost the agent extra turns finding its way (`cd`, `pwd`, `ls`); they are not mixed
with later rows in any reported number, and the pilot stays unpublished.

## Long sessions (`bench/swelong.mjs`), fixed 2026-10-08 before it runs

**Why.** In real Claude Code use (19 local sessions, ~200 API calls each, peak context ~270k
tokens) most of the cost is the conversation re-read on every call; tool output is 6–15%. Single
SWE-bench tasks (≈10 turns, ≈30k peak) cannot show that, so this track chains issues into one
session.

**Pilot (development, done).** Chain `django20` (20 django issues, seed `20261008`), Claude Haiku
5.5, Snout observe-only in both arms, 2 runs each. A 100k auto-compact window vs Claude Code's
default: cost −78.5% priced with Haiku 5.5's long-prompt tier (−29.8% at flat prices); resolved 34/40
vs 35/40. Snout's budget values (Haiku 5.5: 100k; other models: 300k) were set from this pilot and a
replay of local sessions, so neither is evidence for the claim.

**Confirmation run.**
- Tasks: three chains drawn with seed `20261009` from SWE-bench Verified issues rated under an hour,
  excluding the pilot chain and the 15 SWE pilot tasks: `djangoB` (20 django), `sympy20` (20 sympy),
  `sphinx20` (20 sphinx). Issue order within a chain is fixed by the draw.
- Arms: `off` (Snout observe-only) and `snout` (Snout as shipped when on: enforce, plus the context
  budget written by `installBudget`, the code `snout mode enforce` runs). Repo map off.
- Model `claude-haiku-5-5`, Claude Code 2.1.293, API billing, $3.00 cap per issue, 3 runs per arm per
  chain, run one chain at a time in the order rep → chain → arm.
- Cost: per call from the transcripts at list prices including the long-prompt tier (Claude Code's
  own `total_cost_usd` is cumulative across `--resume` and is not summed). Also reported at flat prices.
- Quality: every issue graded by the official SWE-bench harness.
- **Primary metric:** cost per resolved issue, `snout` vs `off`, with a 95% bootstrap interval over
  chain-runs. **Savings claim** only if the interval lies entirely below zero. **No-quality-loss
  claim** only if the 95% interval for the change in resolved rate (paired by issue) has a lower bound
  above −7 points (180 issue attempts per arm).
- Chain-runs that fail for infrastructure reasons are rerun once and reported.
- A Sonnet 5.5 slice is sized from this run's context growth and fixed here before it runs.

**2026-10-08, amendment to the long-session confirmation, before any `snout` session ran.** The
first launch was stopped during its first `off` session (no `snout` session had started; nothing
from it is kept). Two changes: (1) the `snout` arm now includes Snout's compaction handoff (its
PreCompact hook lists the request, changed and recently read files, last test result and open
to-dos for the summary), because it is part of what ships with the context budget; (2) both arms
run a frozen Snout build (`bench/frozen/snout-confirm.mjs`, sha256 `a0d1adfb4fff…`, recorded in the
results file), so later edits to `dist/` cannot change the arm under test. Everything else is as
fixed above.

**2026-10-09: long-session confirmation, result.** Held-out chains `djangoB`, `sympy20`, `sphinx20`,
Claude Haiku 5.5, `off` vs `snout` (enforce + context budget 100k for Haiku 5.5 + compaction
handoff), 3 runs each, frozen build `a0d1adfb4fff`, official grading. Two `snout` chain-runs hit the
30-minute per-issue limit (djangoB run 2 issue 15; sympy20 run 3 issue 10) and were rerun once as
fixed above; the originals are kept under `excluded`. Spend ≈ $10.

- Pre-registered view: cost per resolved issue **−83.7%** (95% CI −88.6% to −75.0%, 9 paired
  chain-runs) — savings claim met. Resolved **−1.7 points** (95% CI −6.1 to +2.8, 180 paired issues) —
  no-quality-loss claim met (floor −7).
- Strict view (the original timed-out runs counted, unfinished issues unresolved): cost per resolved
  −81.9%; resolved **−8.9 points** (95% CI −14.4 to −3.3) — not met.
- At flat prices (no Haiku 5.5 long-prompt step), paired: cost per resolved −29% to −31%.
- Both timeouts were in the `snout` arm (0 of 9 in `off`) and both followed a compaction after which
  the agent no longer knew how the project's tests run (it installed and ran pytest on sympy, or
  wrote its own runner in /tmp) and waited past the limit. We read this as a real quality risk of
  frequent compaction (4–6 per session at 100k), not only an infrastructure failure.
- Follow-up decision: the context budget is removed from Snout (Claude Code's default compaction
  again) until a fix for forgetting after compaction is measured.

## Memory run (`bench/swelong.mjs`), fixed 2026-10-09 before it runs

**Question.** When compaction is frequent, does Snout's post-compaction memory restore (exact
facts from the session plus `.snout/pins.md`, re-injected at SessionStart `compact`; no model)
remove the quality loss seen in the confirmation's strict view?

- Tasks: fresh chains, seed `20261010`, disjoint from every earlier chain and the 15 SWE pilot tasks:
  `djangoC` (20 django), `sympyB` (20 sympy), `sphinxB` (19 sphinx). The memory rules were shaped by
  failures on the earlier chains, so those chains are not reused.
- Arms: `c100k` (Snout observe-only, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`) and `snout-c100k`
  (Snout on — enforce, compaction handoff and memory restore — under the same window). The window is
  set the same way in both arms, so the difference is Snout.
- Claude Haiku 5.5, Claude Code 2.1.293, frozen build `bench/frozen/snout-memory.mjs` (sha256
  `2dbdf304f539…`), 3 runs per arm per chain, order rep → chain → arm, $3.00 cap per issue, run stops
  at $15 spent, official grading.
- **Primary:** resolved rate, `snout-c100k` vs `c100k`, paired by issue, **strict view** (chain-runs
  that time out are counted with unfinished issues unresolved). Pass if the 95% interval's lower bound
  is above −7 points **and** `snout-c100k` has no more timeouts than `c100k`.
- Secondary: timeouts per arm; cost per resolved issue; calls per issue after each compaction.
- Timed-out chain-runs are not rerun for the primary metric (strict view by design).

**2026-10-09, memory run amendment (before any session finished).** The single sequential runner was
stopped during its first session (nothing kept) and replaced by three runners in parallel, one per
run index (`--reps 0|1|2`), each capped at $5 (same $15 total). Each run index keeps the fixed
order chain → arm. Results are merged into one file before analysis. Nothing else changes.

**Memory run result (2026-10-09, `bench/ab-results/swelong-memory-merged.json` (not in the repo yet), ~$3.7).** Strict
view (primary): resolved −2.3 points (95% CI −7.3 to +2.3), lower bound below −7 → **not met**;
timeouts `snout-c100k` 1, `c100k` 0 → **not met**. Cost per resolved −12.2% (CI −19.4% to −3.1%).
Default view: resolved +0.0 points (CI −5.1 to +5.1), cost per resolved −12.8%. The memory was
injected after all 49 compactions, but 21 of 46 restored test commands were one-off `python -c`
scripts, not the test runner (fixed in commit `74839b5`). The one timeout (sympyB, run 1, issue 16)
followed the agent's own change making the polys tests hang.

## Memory fix rerun, fixed 2026-10-09 before it runs

- Same chains, model and settings as the memory run; only the `snout-c100k` arm is rerun, 3 runs,
  on frozen build `bench/frozen/snout-memfix.mjs` (sha256 `a34d8f410aec…`: the memory run's build plus the
  test-command fix; the other differences, pin redaction and a lazy HTTP import, do not act in this
  benchmark). Compared with the memory run's `c100k` rows, paired by issue.
- Three runners in parallel (`--reps 0|1|2`), $3 cap each; grading afterwards, one file at a time.
- Primary and pass rule unchanged: strict view, lower bound above −7 points and no more timeouts
  than `c100k` (0). Not rerun on timeout.
- Claude Code pinned to 2.1.293, auto-update off. Correction after the run: the baseline file records
  2.1.295 (Claude Code auto-updated during the memory run), so the versions do not match exactly. The
  baseline was measured hours earlier.

**Memory fix rerun result (2026-10-09, `bench/ab-results/swelong-memfix-vs-c100k.json` (not in the repo yet), ~$2).** Strict
view (primary): resolved −5.6 points (95% CI −10.7 to −0.6) → **not met**; timeouts 2 (`snout-c100k`)
vs 0 → **not met**. Cost per resolved −3.6% (CI −26.3% to +19.3%), not met. Default view: resolved
−1.5 points (CI −6.6 to +3.6). Both timeouts, like the memory run's, were sympyB issue 16
(sympy-19040): the agent's change made the polys tests hang and it waited on them; Snout blocked or
trimmed nothing during that issue, and the restored test commands were real runner commands. Across
both runs, `snout-c100k` timed out on that issue in 3 of 6 runs, `c100k` in 0 of 3.

## Hang-guard check on sympy-19040, fixed 2026-10-09 before it runs

- Why: every timed-out chain-run in the memory runs was sympyB issue 16 (sympy-19040): the agent's
  change made the polys tests hang and it waited on them. Snout now adds a note when a command
  outlives the tool limit (`hangNote`), and asks for `.snout/progress.md` after a compaction.
- Design: `bench/swe.mjs`, task `sympy__sympy-19040` alone, arms `off` (observe) and `enforce`,
  10 sessions each, Claude Haiku 5.5, Claude Code 2.1.296, frozen build
  `bench/frozen/snout-hang.mjs` (sha256 `44039539abc9…`), $2 cap and 30-minute limit per session, official grading.
- A single issue does not compact, so this checks the hang note only, not the progress notes.
- Read: sessions that hit the 30-minute limit per arm, resolved per arm, minutes per session. Too
  small for a claim; it decides whether the chain confirmation is worth running.

**Issue-16 hang-guard result (2026-10-09, `bench/ab-results/swe-1791600532320.json` (not in the repo yet), ~$1.10).** Resolved
`off` 10/10, `enforce` 8/10 (not significant); no session hit the 30-minute limit in either arm; slow
sessions about 4 per arm. The note fired in 5 enforce sessions and the agent stopped the run in 1. The
hang note was removed from Snout: it did not change what the agent did.

## Sonnet compaction run (`bench/swelong.mjs`), fixed 2026-10-10 before it runs

**Question.** On a mainstream model, does compacting long sessions earlier, with Snout's
post-compaction memory, keep quality? Replay (`snout replay --compact-at`) says compacting at 300k
would cut the cost of the user's long real sessions by about 41% (calibrated; 13–16% if each
compaction loses a lot), but only a live run says whether the agent still resolves its issues.

- Design: a stress test. Compaction at 150k makes 40-issue chains compact 2–3 times (300k would
  compact under once on average at this length, too few to see a loss). If quality holds at 150k, it
  holds at 300k, which compacts less. The 300k saving itself comes from replay, not from this run.
- Tasks: two fresh chains, 40 django issues each (`djangoL1`, seed 20261011; `djangoL2`, seed
  20261012), disjoint from every earlier chain and the 15 SWE pilot tasks. Only django has 80 unused
  eligible issues, so this run covers one repository.
- Arms: `default` (Snout observe-only, Claude Code's own compaction for the model) and `snout-c150k`
  (Snout on: enforce and the post-compaction memory, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000`). If the
  `default` arm compacts on its own, that is recorded and reported with the result.
- Claude Sonnet 5.5, Claude Code 2.1.296 pinned (auto-update off), frozen Snout build
  `bench/frozen/snout-sonnet.mjs` (sha256 recorded in the result file), 3 runs per arm per chain
  (12 sessions), runners in parallel (one per chain and run index), $35 cap each ($210 total),
  $6.00 cap per issue (raised from $3.00 before launch; see below), 30-minute limit per issue, official grading one file at a time.
- **Primary:** resolved rate, `snout-c150k` vs `default`, paired by issue, **strict view** (unfinished
  issues in timed-out chain-runs count as unresolved). Pass if the 95% interval's lower bound is
  above −7 points. Timeouts are reported per arm; they are not a separate pass rule, because the
  strict view already counts them and a single unrelated hang decided earlier runs.
- Secondary: cost per resolved issue at flat prices; tokens; compactions per chain-run; replay's
  prediction for this run's `default` transcripts at 150k against the measured `snout-c150k` cost
  (a check on the simulator).
- Estimated cost from the measured growth of 20-issue chains at Sonnet prices: ~$14 per `default`
  and ~$9 per `snout-c150k` chain-run, ~$140 in all; the $210 cap allows for Sonnet using more tokens
  than Haiku.
- Size: 3 runs per arm (240 paired issues). From the memory run's paired variance, a run with no
  true quality difference passes this rule ~92% of the time (2 runs: ~78%).
- Before launch, free and cheap checks (2026-10-10): the replay simulator was conservative on 8 of 11
  pairs measured both ways (median 7 points), never worse than its harsh bound; the fixed memory cut
  compactions followed by test-runner fumbles from 33% (no memory) to 6%; a 5-issue Sonnet chain
  (~$2) measures Sonnet's growth and whether it compacts on its own, and two issues per arm on the
  frozen build (~$1) check the setup end to end.
- If it passes: Snout's context budget comes back in enforce mode at 300k (no new settings), and the
  claim for long sessions rests on replay at 300k plus this run's quality result. If it fails: no
  budget, and the claim stays at what gating measures.
- Pre-launch amendments (2026-10-10, before any session ran):
  - Build: `bench/frozen/snout-sonnet.mjs`, sha256 `7bd608ca3006…` (replaced `49410a02d255…` on 2026-10-11, see below). Its post-compaction memory also
    restores the user's instructions verbatim (last 12, at most 1,600 characters, pasted issue text
    excluded). Measured offline with `bench/retention.mjs` on 205 recorded compactions: facts kept
    after compaction 68% with Claude Code's summary alone, 81% with Snout's memory; instructions 41%
    → 90% verbatim.
  - Per-issue cap $3.00 → $6.00. Repricing earlier chains at Sonnet rates gave up to $1.76 per issue
    at a 260k context; 40-issue `default` chains reach about twice that, so a $3 cap could cut off
    late issues in the `default` arm only and bias the comparison. The $35 runner caps still bound
    the total.
  - Claude Code's advisor tool is disabled in every arm (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`). It is
    switched on by a fetched flag, and its uncached full-transcript reads would add cost unevenly.
  - Checked without model calls: Claude Code 2.1.296 reports a 1M auto-compact window for Sonnet 5.5
    under the API key (so `default` is the 1M case), and 150k when `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
    is set; the per-issue budget counts only the spend of each `claude -p` call, not the resumed
    session's total; both chains have 40 distinct issues, disjoint from every earlier chain and the
    SWE pilot; all 80 images are pulled before launch; the frozen build's hooks restore the test
    command and instructions, narrow a lockfile read and trim passing test output in the Snout arm,
    and do nothing in `default`.

  - Harness fix (both arms): `python`/`pytest` run in the task's container, and files were copied
    only into it. The smoke run showed an agent that fixed an issue with a `python - <<EOF` script
    editing source inside the container, so its patch came back empty. After each call the shim now
    copies back repository files the command changed in the container (checked against a real
    container: the edit reaches the patch, exit codes pass through). New untracked files a command
    creates there still stay in the container.
  - Smoke run (2026-10-10, `--chains smoke`: 5 practice django issues outside both test chains,
    one run per arm, $0.88 plus $0.04 for one forced compaction): sessions, grading and pricing work
    end to end on Sonnet 5.5; default 4/5 resolved, 24 calls, peak 37k, $0.26; `snout-c100k` 3/5,
    41 calls, peak 61k, $0.62. Not evidence either way (n=1, 5 issues): the unresolved difference
    is the empty patch above, Snout made no interventions during the work, and one issue took 11
    turns in one arm and 23 in the other. Neither arm reached 100k, so one compaction was forced
    with `/compact` on the kept Snout session: Snout's memory was injected (test command, changed
    files, "Do not modify the existing tests.", no issue text).
  - Revised estimate from Sonnet's measured growth (~7k tokens and ~5 calls per issue): ~$10 per
    `default` and ~$7 per `snout-c150k` 40-issue chain-run, ~$100 in all; `snout-c150k` should
    compact about twice per chain-run. Runners: 3 in parallel (one per run index, each running
    both chains and both arms), $70 cap each, $210 total, because Docker on this machine has only
    been proven with 3 sessions at once.
  - Build change (2026-10-11, still before any session ran), following arXiv 2609.20804, whose
    summary keeps the user's goal verbatim and records errors and fixes: the memory also restores
    the session's first request (read from the transcript's start even when it is longer than the
    16 MB tail) and the last error a command printed with no passing test run or clean rerun after
    it. `bench/retention.mjs` on 207 recorded compactions: first request 15% → 100% verbatim, last
    unresolved error 27% → 87%, all facts 66% → 82%. The summary now also breaks unresolved issues
    down by kind (wrong fix, no edit, hang, not reached, budget cap, context full, CLI error).
  - Final checks (2026-10-12, still before any session ran):
    - Hang path, without model calls (a stand-in `claude` that never finishes chosen issues, and a
      shortened limit): after one hang the issue's container is restarted, its stuck process is
      gone and the chain continues with every issue patched; after three the chain-run stops and
      is marked as an infrastructure failure. The progress line no longer crashes on a chain-run
      without a priced transcript.
    - End to end on the frozen build (`--chains smoke`, Sonnet 5.5, one run per arm, $0.59 plus
      about $0.05 for one forced compaction): `default` 4/5, `snout-c150k` 4/5 (both miss
      django-15916), graded with no empty patches or errors; neither arm reached 150k. On `/compact`
      (43k → 3k tokens) Snout's memory restored the test command with its last result, the first
      request verbatim (no issue text), the current request, the changed files and the user's
      instructions. Known gap: a file edited by a `python` script rather than an edit tool is not
      in Snout's changed-files list (Claude Code's own summary kept it here). Left as is so the
      build stays the frozen one.
    - Docker holds exactly the 85 images the chains and smoke run use; a django container grows
      about 3 MB while running tests, so space is not a constraint.

## Long-session SWE-bench run, 80 issues per session (`bench/swelong.mjs`), fixed 2026-10-12 before it runs

Replaces the Sonnet compaction run above, which never launched. Two findings before launch changed
its design: Sonnet adds about 4–5k tokens per issue on an 18k base (the estimate above assumed 7k), and
Claude Code compacts about 33k below the window, so 40-issue chains at 150k would compact only once
or twice, late. The question is now Snout against plain Claude Code.

**Question.** In one long session of real SWE-bench Verified issues, does Claude Code with Snout
(compaction at 300k with Snout's post-compaction memory) cost less per resolved issue than plain
Claude Code, with no loss in the resolved rate?

- Tasks: `djangoL80`, one session of 80 django issues: `djangoL1` then `djangoL2` (seeds 20261011,
  20261012), in that fixed order. Never run by any arm; disjoint from every earlier chain and the 15
  SWE pilot tasks. Django is the only repository with 80 unused eligible issues.
- Arms: `default` (Snout observe-only; Claude Code's own window, 1M for Sonnet 5.5, so no compaction
  is expected) and `snout-c300k` (Snout on: enforce, post-compaction memory,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`). If `default` compacts, that is reported.
- Claude Sonnet 5.5, Claude Code 2.1.296 pinned (auto-update off), API key billing, frozen Snout
  build `bench/frozen/snout-long80.mjs` (sha256 `58bbe46bab02…`, recorded in the result files), the
  advisor tool off in both arms. 3 runs per arm (6 sessions, 240 paired issue attempts). Two runners
  in parallel, one per arm, each running runs 0, 1, 2 in order, so the arms run at the same time
  (`SWE_SHARED_DOCKER=1`). $6.00 cap per issue, 30-minute limit per issue, $75 cap per runner ($150
  in all). Official grading, one file at a time, after both runners finish.
- **Primary:** resolved rate, `snout-c300k` vs `default`, paired by issue and run, strict view. Pass
  if the 95% interval's lower bound is above −7 points (from the memory run's paired variance, a run
  with no true difference passes ~92% of the time at 240 pairs).
- **Headline cost figure:** cost per resolved issue over the whole session, with its 95% bootstrap
  interval (resampling sessions), priced per call from the transcripts at list prices.
- **Secondary:** cost over the second half of each session (issues 41–80, where the context is
  large); peak context; compactions; cost per issue across the session (a chart). Reported whatever
  they show.
- Cost accounting (fixed before launch): the compaction call is not in Claude Code's transcript, so
  each compaction is charged conservatively as the whole pre-compaction context at the uncached input
  price plus the summary at the output price (on the smoke run: $0.10 for one 43k compaction,
  about twice its likely real cost). Calls are attributed to the issue whose prompt they follow.
- Expected: `default` peaks around 340–420k with no compaction; `snout-c300k` compacts about once,
  around issue 50–60. If quality holds, cost per resolved issue falls an estimated 25–35%, more in
  the second half. Estimated spend ~$110.
- Build since the smoke check (2026-10-12): the memory now puts the user's instructions before the
  facts, so the cap never cuts them, says that a later instruction holds where two conflict, and lists
  as many changed files as fit (cap 4,000 → 6,000 characters). `bench/retention.mjs` on 210 recorded
  compactions: all facts kept 82% → 97%, changed files 79% → 99%, real sessions 53% → 65%.

## Publication standard, fixed 2026-10-13

Applies to every number published from now on: README, site, posts. Earlier results are listed
against it in [claims.md](claims.md).

1. **Fixed before the run, in this file:** the task set, arms, model and agent versions, the frozen
   Snout build, the primary metric, and the no-quality-loss margin in points (5 unless a section
   says otherwise; the long-session runs keep their registered 7).
2. **Primary metric:** cost per solved attempt (total cost over total solved), arm vs. plain agent,
   tasks paired. For agents that report tokens and not dollars, effective tokens (uncached input +
   0.1 × cached input + output), labelled as tokens.
3. **Intervals:** 95%, from a bootstrap over tasks with a fixed seed (`bench/report.mjs`).
   "Saving" only if the cost interval lies below zero. "No quality loss" only if the interval for
   the change in solved attempts lies above −margin. A result that meets neither is published as
   measured, with both intervals, and is not called a saving.
4. **Everything run is reported:** every arm and configuration, attempts excluded for
   infrastructure (agent never ran, usage limit, harness failure) counted and listed, never
   dropped silently. A subset (bulk-path tasks) is published only next to the whole run.
5. **Published with the number:** `docs/results/<study>/` holding `attempts.csv`, `summary.json`
   and `chart.svg` from `bench/report.mjs`, the command that rebuilt them, and the results file
   they came from. Anyone can rebuild them without a key or a paid call.
6. **A number whose per-attempt data isn't in the repository is not published.** Raw transcripts
   stay private; the per-attempt table is enough to rebuild every statistic.

## Claude Code confirmation on held-out SWE-bench Verified, fixed 2026-10-14 before it runs

**Question.** On SWE-bench Verified issues no Snout run has used, does Claude Code with Snout
(enforce) cost less per resolved issue than plain Claude Code, with no loss in resolved issues?
The target is a narrow interval: the headline is the point estimate with its 95% interval.

- **Tasks.** 80 issues drawn by `node bench/swe.mjs --select --seed 20261014 --count 80 --per-repo 20`
  (written to `bench/swe-draw-20261014.json` via `SWE_TASKS_FILE`, then split into
  `bench/swe-tune-tasks.json` and `bench/swe-confirm-tasks.json`), with the pilot's eligibility rule:
  the nine repositories in `bench/swe.mjs`, no issue rated over 4 hours, at most 20 per repository.
  Every issue named in `bench/swe-tasks.json`, `bench/codex-heldout-tasks.json` or any results file
  under `bench/ab-results/` is excluded (18 issues). The three files are committed before any attempt;
  that commit is the record of the draw.
  - **Tuning set:** the first 20 in draw order. Used to tune Snout and run the pilot; never reported
    as a result.
  - **Confirmation set:** the other 60. No tuning, inspection of transcripts or rerun selection
    happens on them before the confirmation run is complete.
- **Arms.** `plain` (Claude Code with no Snout installed at all) and `enforce` (Snout on). Internal-only
  arms may add other Claude Code context tools under the same conditions; they are reported only
  in internal notes unless the owner decides otherwise before the run.
- **Agent and model.** Claude Code headless 2.1.301 (the latest release on 2026-10-15, installed
  apart from the operator's own copy and passed as `CLAUDE_BIN`), version recorded,
  auto-update off; `--model claude-sonnet-5-5`, default effort; API key billing; every session in an
  empty Claude Code config folder, so no operator settings, plugins, skills, connectors or memory
  reach either arm; same prompt, tools, budget ($2.00 per
  attempt) and 30-minute limit in every arm. Arms run interleaved, so time-of-day effects fall on
  both, and which arm runs first rotates by task and attempt, so the prompt-cache discount a second
  session can get from the first falls on both arms equally.
- **Build.** The committed `dist/snout.mjs` of the commit under test, its sha256 and the commit
  recorded in every result file; the runner refuses to start with uncommitted `src/` or `dist/`. Any
  change after the confirmation run starts makes a new study.
- **Pilot (not a result).** Tuning set × 2 attempts per arm, arms `plain`, `enforce` and `map`
  (enforce plus the repo map, to decide whether the map ships on). It checks the harness on this
  machine, measures cost per attempt and run-to-run variance, and is where Snout is tuned. Stop and
  fix if 2+ attempts fail for infrastructure reasons or Snout's records are missing.
- **Confirmation size, set from the pilot before the confirmation starts.** From the pilot's
  `plain` and `enforce` rows: the spread of the per-task log cost ratio across tasks and the
  attempt-to-attempt spread within a task. The number of attempts per task (3 unless this rule
  gives more) is the smallest that gives an expected 95% half-width of ±8 points on the cost change
  over the 60 confirmation tasks, capped by the owner's budget. The calculation, the chosen size
  and the cap are recorded here and committed before the first confirmation attempt; the size is
  never changed after any confirmation result is seen.
- **Confirmation.** 60 tasks × the size above, arms `plain` and `enforce` (with the map if the pilot
  decided it ships), run only after its cost is quoted to and approved by the owner.
- **Primary metric.** Billed cost per resolved attempt (total cost / total resolved), `enforce` vs
  `plain`, tasks paired, 95% bootstrap over tasks (seed 20261014, `bench/report.mjs`). Resolved =
  the official SWE-bench grader on the final diff.
- **Rules.** Margin 5 points: no quality loss only if the interval for the change in resolved
  attempts lies above −5 points. Saving only if the cost interval lies below zero. Earlier runs of
  this size gave about ±10 points; if the interval is wider than planned, it is published as
  measured, not narrowed by adding runs after looking.
- **Secondary, reported whatever they show.** Turns per attempt, cache-write and cache-read tokens,
  output tokens, wall time, Snout interventions and regrets (a held-back file or trimmed output
  fetched again). Turns and cache writes are reported next to cost because compression that cuts
  tokens can raise the bill through extra turns.
- **Exclusions.** Attempts where the agent never ran or the harness failed are counted, listed and
  rerun once; never dropped silently.
- **Publication.** Per the publication standard, both arms and every attempt are published. The
  headline "N% lower cost per solved task (95% interval A–B), same solve rate" is used only if both
  rules pass.

## Memory pilot on held-out SWE-bench Verified (`bench/swe.mjs`, `bench/memseed.mjs`), fixed 2026-10-16 before it runs

- **Question.** Does memory of a team's earlier work on the repository, kept by Snout's own hooks and
  shared between Claude Code and Codex, change the cost per solved task or the solve rate, beyond
  what the gate alone does? This is a pilot: it sizes a later study and gives no public claim.
- **Tasks.** `bench/swe-memory-tasks.json`, drawn by `node bench/swe.mjs --select-memory` (seed
  20261016): 20 tasks from 9 repositories, at most 6 per repository, none over 4 hours, each with 10 or
  more earlier issues in its repository, none used in an earlier agent run. 16 have related prior
  work (an earlier issue whose fix touched a file this fix touches); 4 have none, to check that
  memory costs nothing when nothing in it applies. Offline evaluations (sessioneval, recalleval,
  mapeval-heldout) scored nearly every Verified issue without running an agent, so they do not
  exclude a task; no Verified task is unseen by Snout's offline tuning.
- **Arms.** `plain` (no Snout), `enforce` (the gate), `memory` (the gate plus the memory hooks:
  recall on the prompt, a card at every Stop). Only the memory arm starts with prior work: one card
  for each of the newest 150 earlier issues of the repository (created before this one, never this
  one), made by Snout's shipped Stop hook from the public trajectory of that issue. Which agent
  worked an earlier issue is fixed by a hash of its id: half Claude Sonnet 4.5 sessions written as
  Claude Code transcripts, half GPT-5.2-Codex sessions written as Codex rollouts. A recalled Codex card in
  a Claude Code session is the cross-agent handoff case. Transcripts are kept outside the workspace,
  so prior work reaches the agent only through memory. Memory reaching another arm is flagged as a
  harness fault. No arm here gives the agent's own native memory the same prior work; that
  baseline is for the later study.
- **Agent, model, limits, build.** As in the Claude Code confirmation protocol of 2026-10-14:
  headless Claude Code, `--model claude-sonnet-5-5`, API billing, an empty config folder per session,
  the same prompt in every arm, $2.00 and 30 minutes per session, arms interleaved, the committed
  build recorded in every result file.
- **Free gate before any paid session.** The memory arm runs once on all 20 tasks with the stand-in
  agent (`SWE_FAKE_AGENT=1`), which sends the same prompt. The paid run starts only if recall at the
  prompt names a file of the fix on 5 or more of the 16 related tasks. Otherwise recall is fixed
  first, with no paid sessions.
- **Stage A.** 20 tasks × 3 arms × 1 attempt = 60 sessions, `--max-spend 8`. Projected cost: earlier
  Sonnet sessions on this harness averaged $0.055 (36 sessions, 2026-10-15), so about $3.50–5.
- **Gate before stage B.** Stage B (a second attempt of the same 60) runs only if none of these hold:
  memory resolves 2 or more fewer tasks than enforce; memory's cost per resolved task is more than
  20% above enforce's; 2 or more sessions failed for infrastructure reasons; memory reached another
  arm. Stage B's `--max-spend` keeps the pilot's total at or below $15.
- **Primary metric.** Billed cost per resolved attempt, memory vs enforce (what memory adds) and
  memory vs plain, tasks paired, 95% bootstrap over tasks (`bench/report.mjs`). Resolved = the
  official SWE-bench grader on the final diff.
- **Secondary, reported whatever they show.** Resolved attempts per arm; turns; input, cache and
  output tokens; wall time; for the memory arm: sessions where recall fired, recalls that named a
  file the fix needed, reads of recalled files the fix did not need, recalls of Codex cards, memory
  tokens. The 4 unrelated tasks are reported on their own.
- **Use.** All rows are kept and published with the later study. The pilot sets that study's size
  and decides whether memory goes into it; it is not quoted as a result.
