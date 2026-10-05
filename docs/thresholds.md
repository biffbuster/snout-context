# Thresholds

## Today

There are two, both in `src/gate/policy.ts`:

```ts
export const THRESHOLDS = {
  denyMinConfidence: 0.9,   // enforce mode denies at or above this, asks below it
  askMinConfidence: 0.5,    // below this, every mode allows
} as const;
```

They barely matter yet: Tier 0 rules return confidence 1.0 (a lockfile is a lockfile) or
0.8 (snapshots, oversized files). Nothing lands in the interesting middle until the
semantic tiers arrive.

One more floor applies only to the blocking hook, `MIN_GATE_TOKENS = 2000`: a flagged read
smaller than that, or a path that is not a regular file, is recorded but never blocked. A
deny costs the agent a turn, and a turn re-sends the conversation, so blocking a small file
costs more than it saves — the A/B measured exactly that on a 9-token config file. Secrets
and crafted file names are exempt: withholding them is a safety decision, not a token one.

## Bands: where a confidence lands

Every classification falls in one of three bands, which is what `enforce` would do with it,
whatever mode you are in:

| Band | Confidence | enforce | advise | observe |
| --- | --- | --- | --- | --- |
| **act** | ≥ `denyMinConfidence` (0.90), low-value rule | withholds | asks | records |
| **ask** | ≥ `askMinConfidence` (0.50), or a marginal rule, or a secret | asks | asks | records |
| **read** | below 0.50, or no rule applies | reads | reads | reads |

A marginal rule (snapshot, oversized) is never in the act band, whatever its confidence:
its verdict is ask by construction. A secret is always ask, at any threshold.

`/snout:explain <path>` prints the band and the thresholds. `/snout:scan` prints files and
tokens per band for a whole folder, and `--deny` / `--ask` preview other values without
changing anything.

## Scores per label

`/snout:explain` also prints a score for every label, not just the winner. Each rule runs on
its own, so scores are independent — a lockfile inside `vendor/` is 1.00 on both — and
`read` is 1 minus the strongest flag. The winner is still the first rule in authority
order; the scores explain a verdict and never change one.

Near misses score `HINT_SCORE` (0.40): a "DO NOT EDIT" banner with no generator named, a
1,000-character line with no `.min` in the name, a `testdata/` or `golden/` path, a file over
half the size cap. 0.40 is under the ask threshold, so by the invariant below a near miss
is shown and never acted on. `test/scores.test.mjs` asserts that.

## The invariant

**Below `askMinConfidence`, every mode allows.** A classifier reporting that it does not
know must not act on it. Per TypeSafe's guidance on confidence, a low value means the
distribution is flat — the model is telling you the question was a poor fit or the evidence
was insufficient. A context gate that blocks on that signal breaks work for no reason.

`test/mode.test.mjs` asserts this in all three modes. It is not a tunable.
