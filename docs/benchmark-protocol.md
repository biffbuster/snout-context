# Benchmark protocol (pre-registered)

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
API billing. Published Haiku bar, cost per success against plain Claude Code: RTK with ML
features −4.5%, RTK +3%, Headroom +47%.

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
A same-day RTK arm (current stable release v0.51.0, official binary, checksum-verified, installed
with its own installer) runs in the same blocks. Claude Code is pinned for the campaign (no
auto-update) and the runner resumes after an interruption without rerunning finished runs.

**2026-10-07: confirmation result (PointFive, Snout `6b4af03d`, RTK v0.51.0, same runs).** 463
paired blocks on 77 unseen tasks (Haiku 264, Sonnet 166, Opus 33), 1,389 runs, $56.81 billed, no
infrastructure failures. Analysis exactly as pre-registered (`analyze_snout.py`):

| vs. plain Claude Code | Cost per success (95% CI) | PointFive P4 (95% CI) | Success |
|---|---|---|---|
| **Snout** | **−11.9% (−16.2% to −7.8%)** | **−9.9% (−13.7% to −6.3%)** | 450/463 vs 450/463 |
| RTK v0.51.0 | −6.9% (−12.0% to −2.1%) | −5.9% (−12.0% to −0.8%) | 452/463 vs 450/463 |

Both claim rules pass for Snout: the interval lies below zero, and success is not lower (difference
0.0 points, 95% CI −1.5 to +1.7). Snout vs. RTK directly: −5.4% cost per success (95% CI −9.2% to
−1.3%). Per model: Haiku −15.8% (CI −23.7% to −8.2%); Sonnet −9.8% (CI −15.4% to −3.7%) with success
2.4 points lower (CI −5.5 to 0.0, so the no-loss rule is not met for Sonnet alone); Opus −5.8% (CI
−14.0% to +2.7%, 33 blocks, not significant). Of the four Sonnet blocks plain Claude Code passed and
Snout failed, three had no Snout intervention (arithmetic and answer errors); one was a Snout defect,
fixed after the campaign: after `cd lib` Snout wrote its bookkeeping folder inside `lib/`, which the
judge counted as an edit. The published numbers are this run's, not a rerun with the fix.

**2026-10-07: latency confirmation on Haiku 5.5, fixed before it runs.** Phase `lat_h55`: the 49
expansion tasks, Claude Haiku 5.5 (`claude-haiku-5-5`), high effort, 2 repeats (98 blocks). Arms in
the same blocks: plain Claude Code, RTK v0.51.0, Snout `610d93e4` with command hooks, and the same
build with fast hooks (the gate and Squeeze as HTTP hooks to one `snout serve`, started before the
phase from the frozen build, in a clean home directory). In both Snout arms Stop and PreCompact
are asynchronous, as in the shipped plugin (the earlier campaign ran them blocking). Claude Code
2.1.293. Primary latency metric: per-block wall-clock difference vs. plain Claude Code, averaged
within each task, 95% interval from a task bootstrap. The claim "adds at most X seconds" uses the
interval's upper end as X. Cost per success and success are reported for all arms by the
pre-registered analysis; these tasks were already used, so this phase is a confirmation of latency
and a current-model row, not a new savings claim.

**2026-10-07: latency confirmation result (Haiku 5.5, 98 blocks, 392 runs, $0.69).** Paired
wall-clock difference vs. plain Claude Code (mean of per-task means, 95% CI): RTK −0.02 s (−0.46 to
+0.41); Snout with command hooks +0.70 s (+0.22 to +1.16); **Snout with fast hooks +0.12 s (−0.50 to
+0.75)**. Median wall-clock: plain 5.44 s, RTK 5.58 s, Snout 6.08 s, Snout fast 5.77 s; p95: 11.02 s,
11.47 s, 15.20 s, 11.26 s. So fast hooks add at most 0.75 s per task by the pre-registered rule, and
the difference from plain Claude Code is not distinguishable from zero. Cost per success on Haiku
5.5 (secondary; tasks already used): RTK −3.6% (−8.3% to +0.9%), Snout −2.5% (−8.5% to +3.7%), Snout
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
