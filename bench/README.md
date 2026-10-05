# The cross-repo corpus

`eval/` measures regression on 71 synthetic, hand-written cases. That is enough to catch a
rule breaking, but it cannot say the rules generalise — the cases were written alongside
the rules they test. This directory builds a second, independent corpus: real files from
real repositories, pinned to exact commits, so results are reproducible and the classifier
is judged on trees it was never tuned against.

This corpus does not replace `eval/`. It answers a different question: not "did we break
anything", but "does this hold up outside our own repository".

## Files

- **`manifest.source.json`** — the curated, hand-edited list of 100 repos: owner, repo,
  primary language, tags (popularity tier, age, project shape), and a one-line reason for
  inclusion. Edit this file to add, remove, or replace a repo.
- **`pin.mjs`** — resolves every entry to its current HEAD commit via `git ls-remote` (not
  the GitHub REST API, which rate-limits at 60 requests/hour unauthenticated) and writes
  `manifest.json`. Run it once to freeze the corpus; run it again only to deliberately
  re-pin to newer commits.
- **`manifest.json`** — generated, committed. The frozen, reproducible list: every entry
  carries the exact commit SHA it was pinned at. Never hand-edit this file.
- **`fetch.mjs`** — downloads each pinned commit as a tarball from `codeload.github.com`
  (not a git clone — no `.git` history overhead, which matters on a repo the size of
  `torvalds/linux`), walks the tree, records each file's path, byte size, and the first
  2 KB (base64) — the same head read tier 0 does for generator-banner and binary-sniffing
  — then deletes the extracted tree. Writes `bench/corpus/<owner>__<repo>.json`.
- **`corpus/`** — gitignored output of `fetch.mjs`. Regenerate it locally; it is metadata
  and a content sample, not a repo mirror, but it is still tens of MB and goes stale the
  moment a repo's default branch moves past its pinned commit.

## Why 100 repos, chosen this way

Coverage matters more than count here — 500 near-duplicate npm CLIs teach less than 100
repos spread across shapes:

- **15 languages**, weighted toward what real users run: JS/TS, Python, Go and Rust lead;
  Java/Kotlin, C/C++, Ruby, PHP, C#, Swift and Elixir each get a handful.
- **Age**: `established-old` includes repos from the 2000s still under active
  development — `torvalds/linux`, `sqlite/sqlite`, `curl/curl`, `git/git`, `nginx/nginx`,
  `WordPress/WordPress`, `django/django`, `rails/rails` — because a rule tuned on last
  year's build tooling can fail on decades-old conventions.
- **Popularity**: 33 "mega" repos (100k+ stars) down to single-maintainer tools
  (`sindresorhus/execa`, `BurntSushi/ripgrep`, `simonw/datasette`) and one repo one day old
  at pin time (`unreallabsai/unreal-agent`) — a classifier that only works on famous
  monorepos is not measuring what a solo builder's repo looks like.
- **Shape**: monorepos with heavy generated code (`protocolbuffers/protobuf`,
  `kubernetes/kubernetes`, `tensorflow/tensorflow`), minimal single-purpose libraries
  (`expressjs/express`, `pallets/click`), and everything between.

## Running it

```bash
node bench/pin.mjs                    # re-freeze manifest.json (rarely needed)
node bench/fetch.mjs                  # download and extract every pinned repo
node bench/fetch.mjs redis/redis      # one repo, for testing the pipeline
BENCH_MAX_FILES=500 node bench/fetch.mjs   # cap files per repo (default 2000)
```

A repo capped at `BENCH_MAX_FILES` is marked `"truncated": true` in its corpus file — this
is expected for the largest monorepos (`torvalds/linux` hits the cap) and does not bias the
sample toward any one file class, since the walk order is directory order, not sorted by
size or type.

## What this corpus is for, and what it is not

- **It is** a source of real file trees for scoring tier 0's rules outside our own
  repository, and eventually for calibrating the token estimator against real byte/token
  pairs per extension (`bench/tokens.mjs`).
- **It is not** a labelled dataset by itself. A file's path, size, and first 2 KB are not a
  gold "worth reading" label — that still requires either hand annotation on a sample, or
  running real tasks against these repos and recording which files an agent actually needed
  (`bench/ab.mjs`). Labelling is the next step after this corpus exists,
  not part of `fetch.mjs`.
- **It is not tuned against.** Any rule change justified by a specific repo in this
  manifest should be treated with the same suspicion as tuning against the eval set — the
  point of a held-out corpus is that we don't get to peek.

## Accuracy and token checks (need an API key)

- **`label.mjs`** — Claude labels 400 random + 100 hard-case corpus files as machine-owned
  or source and compares with tier 0. Output is candidates for human review
  (possible-false-deny, possible-gap), not gold labels. ~$3 per full run on Opus 5.
- **`tokens.mjs`** — counts corpus samples with the `count_tokens` endpoint and compares
  with the ratios in `src/ledger/tokens.ts`. `--holdout` checks different files than the
  ratios were fitted to; that is the run that counts. Gate ±10% per extension.

Re-scoring an old label run against new rules costs nothing: rebuild tier 0's predictions
over the stored samples and reuse the stored labels.
