# Benchmark

Measured **2026-09-26** on node v22.22.1, 71 cases across
4 repository shapes. Re-run: `npm run eval`
(`eval/run.mjs`). No API key and no network calls, which is also why the cost column is
zero and the calibration table is empty.

Read `eval/README.md` before quoting any of this. The short version: one annotator, no
held-out split, synthetic content, n=71. Gaps under about 5 points are noise.

## Single label

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

## Calibration

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

## Multi label

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

## Withholding quality

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

## Agent A/B: the whole stack

Real headless Claude Code sessions (Haiku), Snout off vs. on, every feature enabled at once: the
read gate, Squeeze and MCP trimming. Each task's own check decides pass or fail. 12 tasks × 2 arms
× 2 runs = 48 sessions (`node bench/ab.mjs --n 2 --model haiku`).

| | Off | On | Change |
| --- | --- | --- | --- |
| Tasks that meet bulk (generated code, a noisy test run, a large MCP result) | $0.96 | $0.65 | **−32.7%** |
| Low-value tokens the agent read, those tasks | ~93k | ~26k | −72% |
| Control tasks (nothing to trim) | $0.29 | $0.29 | −2.7% (noise) |
| All tasks | $1.26 | $0.94 | −25.7% |
| Passing | 24/24 | 24/24 | |

### Per category, measured

| What entered context | Cut | Where measured |
| --- | --- | --- |
| A large generated file read (a dependency lock) | −90% (7.6k tokens withheld, 0.8k delivered) | real Claude Code session |
| A passing test run's output | −87% (944 lines → 120) | real session, `npm test` in this repo |
| A medium test suite's output | −96% (18k characters → 0.6k) | A/B fixture |
| A large MCP result (60 issues) | −74% (45k characters → 12k) | A/B fixture |
| Bulky tokens in the agent's context | −94% (Haiku, 90 runs) · −59% (Sonnet, 36 runs) | A/B |

## Long sessions (`bench/long.mjs`)

Multi-step tasks in a larger project ("shopfront": ~30 modules, ~250 passing tests, a long
engineering handbook in markdown, a night of production logs, two MCP connectors — an issue tracker
and a wiki — plus the generated, vendored and built files real projects carry). Each run is graded
twice: the task's own tests must pass, **and** the project's existing suite must still pass.
Everything on: read gate, section reads, repeat skip, Squeeze, MCP trimming.

Measured 2026-10-02, Haiku, 11 tasks × 2 arms × **1 run** (`node bench/long.mjs --n 1 --model haiku`;
raw rows in `bench/ab-results/long-1790956853084.json`).

| | Off | On | Change |
| --- | --- | --- | --- |
| Cost, all 11 tasks | $1.00 | $0.72 | **−28.4%** |
| Input tokens (cached and uncached) | 4.17M | 2.48M | **−40.5%** |
| Output tokens | | | −7.5% |
| Turns | | | −13.0% |
| Passing (task done and existing suite green) | 11/11 | 11/11 | |

Where it came from: command output (test runs, searches) ~132k tokens, the long log ~111k, the long
handbook ~24k, MCP results ~4k. By task:

| Task | What the agent had to read | Cost off → on |
| --- | --- | --- |
| rename (a field across the codebase) | search results, many files, repeated test runs | $0.323 → $0.094 (−71%) |
| refund | source, tests, test output | $0.099 → $0.056 (−43%) |
| policy (rates from the handbook) | a 70 KB markdown handbook | $0.081 → $0.051 (−37%) |
| tax · suite | source, test output | −16% · −12% |
| incident (cause in a 4,000-line log) | the log | $0.059 → $0.061 (flat; input −19%) |
| coupons · lowstock · currency · eta · ticket | small files, one MCP lookup | flat to +24% (route variance) |

One run per task, and single runs of the same task routinely differ by 20–40%,
so the per-task rows are anecdotes and the total is the number. The saving concentrates in long,
search-heavy and document-heavy work (the rename task alone is $0.23 of the $0.28); short tasks
that touch a few small files move within noise. The next step is 3 runs per task and a Sonnet pass
before any of this is quoted as a headline.

### A clean library: nothing to trim

A control: one task on a small, clean repository. On
[sindresorhus/ky](https://github.com/sindresorhus/ky) (~100 files, installed, one code question graded
against the source; `node bench/library.mjs`), Snout trimmed nothing in any run: there was no junk
on the agent's path. Totals varied by the agent's route (3–7 tool calls; one run chose to read a
large test file), 101k → 155k median tokens at n=3, which is route variance, not overhead. On a repo
without bulk, Snout costs nothing and saves nothing. Its savings come
from what it keeps out.

## What is not measured

- **Generalisation.** No held-out split, so nothing here predicts behaviour on an unseen
  repository.
- **Real cost and latency under load.** Zero API calls means neither exists yet.
- **Calibration.** See above. There is none to report.

## Model identity

The rules call no model, so these results record `model: null`. A model-backed tier will pin `jev-1.13.0`;
every decision records the model that produced it, and a response from any other model fails
loudly instead of being accepted silently.
