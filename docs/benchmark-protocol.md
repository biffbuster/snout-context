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

