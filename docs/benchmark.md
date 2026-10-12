# Benchmark

How every number in the README was measured. Agent results come first: real headless agent
sessions, Snout off vs. on, each graded by the task's own check. Raw rows for each run are in
`bench/ab-results/`; re-print any of them with `node bench/ab.mjs --summarize <file>` (or
`bench/long.mjs --summarize` for `long-*` files).

## Long sessions (`bench/long.mjs`)

Multi-step tasks in a larger project ("shopfront": ~30 modules, ~250 passing tests, a long
engineering handbook in markdown, a night of production logs, two MCP connectors — an issue tracker
and a wiki — plus the generated, vendored and built files real projects carry). Each run is graded
twice: the task's own tests must pass, **and** the project's existing suite must still pass.
Everything on: read gate, section reads, repeat skip, Squeeze, MCP trimming.

Measured 2026-10-05, Haiku, 11 tasks × 2 arms × **3 runs** = 66 sessions
(`node bench/long.mjs --n 3 --model haiku`; raw rows in `bench/ab-results/long-1791229121880.json`).

| | Off | On | Change |
| --- | --- | --- | --- |
| Cost, all 11 tasks (mean of 3 runs each) | $2.77 | $2.23 | **−19.4%** (95% CI −37.1% to +6.0%) |
| Input tokens (cached and uncached) | | | **−21.5%** |
| Output tokens | | | −3.9% |
| Turns | | | −3.1% |
| Passing (task done and existing suite green) | 33/33 | 33/33 | |

The interval is a bootstrap over tasks, then over runs within each task. It crosses zero: across
this mix of tasks the saving is likely but not proven. By task (mean of 3 runs):

| Task | What the agent had to read | Cost off → on |
| --- | --- | --- |
| rename (a field across the codebase) | search results, many files, repeated test runs | $0.264 → $0.126 (**−52%**, all 3 on-runs below all 3 off-runs) |
| policy (rates from the handbook) | a 70 KB markdown handbook | $0.089 → $0.051 (**−43%**, same) |
| tax · eta · currency · ticket · lowstock | source, test output, one MCP lookup | −7% to −15% |
| coupons · suite | source, test output | flat |
| refund | source, tests, test output | $0.060 → $0.066 (+10%) |
| incident (cause in a 4,000-line log) | the log | $0.054 → $0.082 (**+52%**, all 3 on-runs above all 3 off-runs); fixed, see below |

Nearly all of the saving is in search-heavy and document-heavy work: rename and policy account for
$0.53 of the $0.54 saved. Without them, the other nine tasks move −0.6%, which is no change.

**Incident was a regression, now fixed.** The log is 258 KB. Claude Code refuses a whole-file Read
over 256 KB on its own, with a one-line note to search or read a range, and the agent then greps
for the error: a 114-character result. Snout stepped in first and returned an 8.5 KB tail, which
costs more than that refusal and rides along on every later turn. Its "kept out" tally for this
file was also fictional: none of the log was ever going to reach the context. Snout now steps aside
on Claude Code for whole-file reads over 256 KB and records no saving for them. Re-run after the
fix, 3 runs per arm (`long-1791232350718.json`): $0.066 → $0.060 (−8.7%, 95% CI −32% to +21%),
3/3 passing: no difference, as it should be. The suite total above predates the fix; the lockfile
and minified bundle in this fixture are also over 256 KB, so the next full run will show their
reads going to Claude Code's own refusal too.

The earlier single-run pass (2026-10-02, `long-1790956853084.json`, not published) measured
−28.4% cost and −40.5% input; three runs per task brought both down, which is why single runs are
not quoted.

### A clean library: nothing to trim

A control: one task on a small, clean repository. On
[sindresorhus/ky](https://github.com/sindresorhus/ky) (~100 files, installed, one code question graded
against the source; `node bench/library.mjs`), Snout trimmed nothing in any run: there was no junk
on the agent's path. Totals varied by the agent's route (3–7 tool calls; one run chose to read a
large test file), 101k → 155k median tokens at n=3, which is route variance, not overhead. On a repo
without bulk, Snout costs nothing and saves nothing. Its savings come
from what it keeps out.

## Agent A/B: the whole stack

Real headless Claude Code sessions (Haiku), Snout off vs. on, every feature enabled at once: the
read gate, Squeeze and MCP trimming. Each task's own check decides pass or fail. 12 tasks × 2 arms
× 2 runs = 48 sessions (`node bench/ab.mjs --n 2 --model haiku`; raw rows in
`bench/ab-results/run-1790779257454.json`). Bulk-task input tokens fell 17%; the larger cost cut
comes from fewer cache writes.

| | Off | On | Change |
| --- | --- | --- | --- |
| Tasks that meet bulk (generated code, a noisy test run, a large MCP result) | $0.96 | $0.65 | **−32.7%** |
| Low-value tokens the agent read, those tasks | ~93k | ~26k | −72% |
| Control tasks (nothing to trim) | $0.29 | $0.29 | −2.7% (noise) |
| All tasks | $1.26 | $0.94 | −25.7% |
| Passing | 24/24 | 24/24 | |

### Per category, measured

Single examples, so each is one measurement, not an average. Note the unit in each row.

| What entered context | Cut | Unit | Where measured |
| --- | --- | --- | --- |
| A large generated file read (a dependency lock) | −90% (7.6k withheld, 0.8k delivered) | tokens | one real Claude Code session |
| A passing test run's output | −87% (944 → 120) | lines | one real session, `npm test` in this repo |
| A medium test suite's output | −96% (18k → 0.6k) | characters | A/B fixture |
| A large MCP result (60 issues) | −74% (45k → 12k) | characters | A/B fixture |
| Low-value tokens the agent read, bulk tasks | −94% Haiku (90 runs) · −59% Sonnet (36 runs) | tokens | read-gate A/B below |

Squeeze alone on the medium test suite (Haiku, 3 runs per arm): spend −35.7%, 3/3 passing
(`run-1790708920778.json`). MCP trimming alone on the 60-issue tracker (Haiku, 2 tasks × 3 runs):
spend −32.5%, 6/6 passing (`run-1790734338726.json`). In both, total input tokens barely move
(−14% and +4%); the saving is mostly fewer cache writes, which cost 1.25× the input rate.

## Agent A/B: read gate alone

Nine short tasks (4 control, 5 that meet a bulky file on the way), read gate only. Pass is the
task's own check.

| Agent | Runs | Bulk tasks | Control tasks | Passing | Raw rows |
| --- | --- | --- | --- | --- | --- |
| Claude Code, Haiku | 9 tasks × 2 arms × 5 = 90 | spend **−24.3%** ($1.47 → $1.11) | +0.1% | 45/45 · 45/45 | `run-1790613461290.json` |
| Claude Code, Sonnet | 9 × 2 × 2 = 36 | spend **−23.3%** ($0.84 → $0.64) | −5.4% | 18/18 · 18/18 | `run-1790709277914.json` |
| Codex | 60 of 90 planned (usage limit hit; the 30 cut-off runs are excluded) | effective tokens **−22.6%** | +0.6% | 30/30 · 30/30 | `run-1790632506002.json` |

Codex reports tokens, not dollars, so its column is effective tokens: uncached input + 0.1 × cached
input + output. That run predates trimming: the gate denied bulky reads outright (10 denials) where
Claude Code got the head and an outline. Total input tokens on bulk tasks fell only 7–8% in all three.
These runs did not record the cache split, so how the spend cut divides between cache writes and
reads is not measured here; the later runs above, which do record it, show cache writes.

## Classifier eval (rules only, synthetic cases)

This section scores the file classifier by itself, not an agent. Measured **2026-09-26** on node
v22.22.1, 71 cases across 4 repository shapes. Re-run: `npm run eval` (`eval/run.mjs`). No API key
and no network calls, which is why the cost column is zero and the calibration table is empty. The
rules call no model, so these results record `model: null`.

Read `eval/README.md` before quoting any of this. The short version: one annotator, no held-out
split, synthetic content, n=71. Gaps under about 5 points are noise.

### Single label

*Is this file worth reading for the stated goal?* Low value (0-1) against worth reading
(2-3).

```
  classifier              coverage   acc/covered   acc/overall   ms/item   $/1k
  --------------------------------------------------------------------------------
  snout tier 0      52.1%        100.0%         78.9%     0.139  0.000
```

Exact agreement on the full 0-3 scale: **62.0%**.

Three columns rather than one because they answer different questions. `coverage` is how
often the tier has an opinion at all — deterministic rules are silent on ordinary source by
design, and 34 of 71 files here are
cases where no rule *should* fire. `acc/covered` is correctness where it did answer, and is
the accuracy number. `acc/overall` counts silence as "worth reading" and is therefore a
coverage measure — the one a semantic tier improves, not the one above it.

`ms/item` is local CPU, median of 3 passes: pure classification cost, no API call.

### Calibration

Accuracy by the confidence the classifier attached to its own answer.

```
  confidence          n     accuracy
  ---------------------------------
  [0.9, 1.0]       33      100.0%
  [0.7, 0.9)        4      100.0%
  [0.5, 0.7)        0      n/a
  [0.0, 0.5)       34      55.9%
```

**This is a null result.** Deterministic rules return 1.0 or 0.8 by construction, so the
middle bins are empty and nothing here says how much to believe a given answer. A model-backed tier
is what would populate this table.

The `[0.0, 0.5)` row is the fallthrough: files no rule matched, recorded at confidence 0.
Its 55.9% is not a model being unsure, it is the absence of a model.

Unsure subset (confidence < 0.7): n=34, accuracy 55.9%.
That subset is the only set an escalation tier would touch.

### Multi label

One class per file, macro-averaged over the 11 rule classes present in
the gold set. Absent classes are skipped rather than scored zero.

```
  class            n    P       R       F1
  ----------------------------------------
  secret           4  1.000   1.000   1.000
  always-allow     2  1.000   1.000   1.000
  binary           2  1.000   1.000   1.000
  binary-content   1  1.000   1.000   1.000
  lockfile         4  1.000   1.000   1.000
  vendored        11  1.000   1.000   1.000
  minified         2  1.000   1.000   1.000
  snapshot         3  1.000   1.000   1.000
  generated        6  1.000   1.000   1.000
  oversized        1  1.000   1.000   1.000
  license          1  1.000   1.000   1.000
  MACRO               1.000   1.000   1.000
```

A macro F1 of 1.000 is a reason for suspicion, not satisfaction.
These cases were written alongside the rules and there is no held-out split, so this table
measures **regression protection** — that a rule which worked still works — and says
nothing about repositories nobody here has seen. A new file shape that fools a rule stays
invisible until someone adds it as a case.

### Withholding quality

The metrics a gate cannot ship without.

```
  false-deny rate           0.0%   (0 of 9 essential files withheld)
  flag precision          100.0%   (35 of 35 flags were right)
  waste recall             70.0%   (caught 35 of 50 low-value files)
  token reduction          96.3%   (~898.2k of ~932.4k tokens)
```

**false-deny is the gate.** A file counts as needed when its gold value is 3 — the goal
cannot be met correctly without it. A deny is any prediction of value 0, which is what
`enforce` mode blocks. Ceiling 2%; `npm run eval` exits non-zero above it.

**waste recall is the honest weakness.** 70.0% means roughly a
third of genuinely low-value files get through, and every one of those misses is a
fallthrough rather than a wrong answer. That gap is the case for a semantic tier: rules catch the
cheap, unambiguous majority, and a semantic tier is worth paying for on the ambiguous
remainder — not on the unambiguous generated files.

## What is not measured

- **Repos we did not build.** Every agent task above runs on a project made for the benchmark,
  with bulk placed on the agent's path. No public task set (such as SWE-bench) has been run yet,
  so none of this predicts the saving on an arbitrary repository.
- **Confidence intervals.** Most cells are 1–5 runs per task, and single runs of the same task
  differ by 20–40%. Treat gaps under ~10% as noise.
- **Larger models.** Haiku carries most of the data; Sonnet has the read-gate run only; no Opus.
- **Classifier generalisation and calibration.** No held-out split and no calibration; see the
  classifier eval above.
- **Billing.** Spend is the agent's reported cost at API list prices, from runs on a subscription,
  not an invoice.
