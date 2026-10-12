# Evaluation

This page records what is measured today, what is estimated, and which claims are not yet supported.

## What is measured

Measured on an Apple M-series Mac, Node v22, 5,000 iterations in-process:

| Tier 0 case | p50 | p95 | p99 |
| --- | --- | --- | --- |
| lockfile (name match, no file read) | 0.007 ms | 0.011 ms | 0.017 ms |
| ordinary source (2 KB head read, falls through) | 0.065 ms | 0.124 ms | 0.212 ms |
| generated file (2 KB head read, marker hit) | 0.045 ms | 0.087 ms | 0.149 ms |

Hook process lifetime, self-reported across 40 sequential invocations:

| | p50 | p95 | max |
| --- | --- | --- | --- |
| whole hook, including Node start-up | 50 ms | 57 ms | 77 ms |

**Read that table together.** Our classification is two to three orders of magnitude
inside its budget; the cost the user feels is almost entirely Node process start-up, which
no optimisation inside `src/` can remove; a long-running sidecar is the planned fix.

Invocation forms, 25 sequential runs each, wall clock including the shell:

| form | mean |
| --- | --- |
| `node "…/dist/snout.mjs" pre-tool` (shell) | 146.8 ms |
| exec form, `command: "node"` + `args` | 137.8 ms |
| direct shebang execution | 163.0 ms |

Shell form is shipped: the ~9 ms it costs against the exec form buys a documented
guarantee about placeholder expansion, and a silently dead hook is this plugin's worst
failure.

## Classifier quality

Moved to [benchmark.md](benchmark.md), and to
[../eval/README.md](../eval/README.md) for the methodology and limitations. Two pages
reporting the same numbers is how they drift apart; this page keeps latency and token
accounting, that one keeps classifier quality.

Run it with `npm run eval`.

## What is estimated

**Token counts for withheld content.** A file that is not read has no measurable token
count. We divide byte length by a per-extension bytes-per-token ratio (1.9 for
lockfiles, 2.2 for TypeScript, 2.7 for prose, 2.3 default), **measured** with
`bench/tokens.mjs` against Claude's `count_tokens` endpoint (claude-opus-5) on real corpus
files, and validated on a holdout of 573 different files: 29 of 31 extensions within ±10%,
most within ±5%. `.txt` and `.xml` are mixed types whose two samples disagree by 15-19%;
they use the mean of both samples and carry a wider band. A single file can sit about
±15% either side of its extension's average. Older and smaller models
tokenize more compactly, so for them these estimates run high. Every number derived from
them still carries a `~`.

## What is still not claimed

`eval/` now measures classification quality (see [benchmark.md](benchmark.md)). These
remain unmeasured, and the gaps matter more than the numbers that exist:

- **Task-success delta.** Measured by `bench/ab.mjs` on real headless sessions: 90/90 runs
  pass, 45/45 with enforce on (2026-09-28, Haiku, 9 tasks, n=5). Nine tasks is a smoke test, not a
  release gate.
- **Generalisation.** The eval has no held-out split — its cases were written alongside the
  rules — so it measures regression protection, not behaviour on an unseen repository.
- **Calibration.** Deterministic rules return 1.0 or 0.8 by construction, so there is no
  calibration to report; the table stays empty by design until a model-backed tier ships.
- **Cost and latency.** The classifier eval makes no API calls, so it has no cost. Agent spend is
  measured separately by the A/B harnesses (see benchmark.md).

## A correction to the original savings model

The original design proposed a `turnsMultiplier`: a file avoided early in a long session
saves its tokens on every subsequent turn, so the saving should be multiplied.

Inspecting real transcripts showed why that is wrong as stated. Usage records carry
`cache_creation_input_tokens` and `cache_read_input_tokens` separately, and in a live
session the cache-read figure dominates — content already in context is re-billed on later
turns at the cache-read rate, not the full input rate. A naive per-turn multiplier would
therefore overstate the saving by roughly the ratio between those two prices.

The multiplier is not applied. The report counts each avoided file once, which understates
the true saving and is the direction we prefer to be wrong in. Deriving an honest
multiplier from cache-tier accounting is planned.
