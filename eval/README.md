# Evaluation

Read this before quoting any number from `npm run eval`.

The methodology: real
runs, a dated measurement, identical confidence bins, macro P/R/F1 on the multi-label
table, and the caveats stated in the output rather than in a footnote nobody reads.

## Running it

```bash
npm run eval          # the tables
npm run eval:json     # the same numbers as JSON, for tracking over time
EVAL_REPEATS=10 npm run eval
```

No API key, no network calls. The eval covers the deterministic tier only, so every run
is reproducible on any machine and the cost column is genuinely zero.

## What is measured, and why each column exists

| Column | Question it answers |
| --- | --- |
| **coverage** | What fraction of files does the tier have any opinion on? |
| **acc/covered** | When it does answer, how often is it right? **This is the accuracy number.** |
| **acc/overall** | Counting silence as "worth reading". A *coverage* measure, not a correctness one. |
| **exact 0-3** | Agreement on the full context-value scale. The strict view. |
| **calibration** | Accuracy binned by the confidence the answer carried. |
| **unsure** | Accuracy on items under 0.7 confidence — the only ones an escalation tier touches. |
| **macro P/R/F1** | Per-rule quality, averaged over classes present in the gold set. |
| **false-deny** | Share of *essential* files we would have withheld. **The gate.** |
| **flag precision** | Of everything flagged low-value, how much really was. |
| **waste recall** | Of everything that really was low-value, how much we caught. |
| **token reduction** | Estimated tokens withheld over tokens offered. |

### Why accuracy is three columns

Reporting one number would mislead. A rule-based tier is silent on most files *by design* — `cls: null` in the gold set
means no rule should fire. Scoring that silence as a wrong answer mixes two different
things: how often the classifier is wrong, and how often it declines to answer. One number
would read as "wrong about a quarter of files" when in fact every answer it gave was
correct and it simply had no opinion on the rest.

The split also keeps the incentives right. Gating on overall accuracy would pressure the
rules to guess on files they should stay quiet about, which is precisely how a context gate
starts withholding things people need.

### Why false-deny is the gate

A file counts as *needed* when its gold value is 3: the stated goal cannot be met correctly
without reading it. A deny is any prediction of value 0, which is what `enforce` mode
blocks. Every other metric can look excellent while this one makes the product unusable,
so it is the number that decides whether enforcement may ship. Ceiling: 2%.

`npm run eval` exits non-zero on false-deny > 2%, flag precision < 95%, or accuracy on
covered cases < 95%.

## Limitations

These are real and they bound what the numbers mean.

- **One annotator.** No adjudication and no inter-annotator agreement. The labels are one
  engineer's judgement of what each file is worth for the stated goal.
- **No held-out split.** These cases were written alongside the rules. The multi-label
  table therefore measures **regression protection** — that a rule which worked still
  works — and not generalisation. A macro F1 of 1.000 is a reason for suspicion, not
  satisfaction: a new file shape that fools a rule stays invisible to this number until
  somebody adds it as a case.
- **Synthetic content.** Files are realistic in shape (real generator banners, real
  lockfile structure, real ELF headers) but generated, not sampled from real repositories.
- **Small n.** 71 cases across 4 repository shapes; treat gaps under about 5 points as noise.
- **No calibration to report.** Deterministic rules return 1.0 or 0.8 by construction, so
  the calibration table is empty by design; a model-backed tier is what would populate it.

## What the eval has already caught

Kept as a record, because a harness that has never found anything is not yet evidence of
anything:

- An **extensionless compiled binary** (`bin/server`, an ELF file with no suffix) fell
  through every rule and was scored worth reading. Fixed by sniffing the 2 KB head that was
  already being read — no extra I/O.
- A **fixture that did not represent its own label**: a CSV labelled `oversized` was written
  at 26 KB, well under the 200 KB cap, so the rule never fired and the label asserted a
  property the file did not have.
- A **bug in the harness itself**: `require()` inside an ES module threw on every file, so
  each size read as zero and token reduction silently reported 0.0%.
- Two gaps found by `bench/run.mjs` against real repositories (not this synthetic set) and
  fed back here as regression cases, currently failing on purpose: **generated JSON with no
  comment syntax** (`kubernetes/kubernetes`'s OpenAPI spec dump — a banner-sniffing rule can
  never see it), and **a third-party library vendored with no `vendor/` directory and no
  banner** (`WordPress/WordPress`'s bundled `class-pclzip.php`). See `bench/README.md`.

## Adding a case

1. Add the file and its content to the right repo in `eval/dataset.mjs`.
2. Add its gold label: `value` 0-3, and `cls` — the rule that should fire, or `null` when
   the file must fall through to a semantic tier.
3. Run `npm run eval`. If the new case disagrees, decide honestly which is wrong — the rule
   or the label — and say which in the commit message.

Adding a case that the rules already pass teaches nothing. The useful cases are the ones
that fail.
