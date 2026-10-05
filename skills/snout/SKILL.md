---
name: Snout
description: >
  Understand and work on Snout, a context classifier for coding agents. Use when
  the user asks why a file was allowed, asked about or denied; when they want to read or
  change their classification policy, modes or thresholds; when they want to understand
  their token savings report; or when working on the plugin's own code. Also use when a
  session is running out of context and the user wants to know what is consuming it.
license: MIT
---

# Snout

A Claude Code plugin that decides, before a file enters context, whether it is worth its
tokens — and records what that decision saved. It is a permission engine whose subject is
token value rather than safety.

## How a decision is made

Tier 0 runs today; tiers 1 and 2 are planned. First answer wins.

| Tier | Cost | What it does |
| --- | --- | --- |
| 0 | free, ~0.05 ms | Deterministic rules: secrets, the user's lists, binaries, lockfiles, vendored trees, minified output, generated-file markers, a size cap. |
| 1 | one Jev request per turn | Ranks the whole repo map against the user's goal, giving a relevance score per file. Planned. |
| 2 | one Jev request per file | A `Score` for context value plus `Noul`s for generated content and prompt injection, on a digest rather than the file body. Planned. |

A raw classification becomes a verdict through the mode:

- `observe` (default) — record only, block nothing.
- `advise` — `ask` before a low-value read.
- `enforce` — `deny` a low-value read at high confidence, `ask` otherwise.

## Invariants that must not be broken

When changing this plugin, these are not preferences:

1. **Fail open.** Every error, timeout, missing key and unparseable response allows the
   read. The plugin's worst case must be being useless, never being in the way.
2. **Low confidence allows.** A classifier reporting that it does not know must not act.
3. **`observe` never blocks**, in any code path.
4. **Secrets are not a token-value decision.** They are never sent to any API and never
   silently allowed, in any mode.
5. **stdout is the hook protocol.** Diagnostics go to stderr, via `src/util/log.ts`.
6. **We never spend the user's tokens.** User-facing text goes in `systemMessage`, never
   `additionalContext`. A token optimiser that injects context has to justify every token.
7. **Measured and estimated numbers are never mixed.** Withheld content is never read, so
   its token count cannot be measured; estimates carry a `~` in every view.

## Answering "why was this file blocked?"

Run `/snout:explain <path>`. It prints the label, rule, tier, context value, confidence, the
threshold band (act ≥ 0.90 · ask ≥ 0.50 · else read — what enforce would do) and the
sentence the user saw, then a score per label. Scores are independent per label (a
lockfile inside `vendor/` scores 1.00 on both); `read` is 1 minus the strongest flag.
A score of 0.40 marked *near miss* is evidence one step short of a rule — shown, never
acted on, because it is below the ask threshold. `--json` gives the same as data. If the user disagrees, `/snout:allow <path>` adds it to the
always-allow list, which outranks every built-in rule.

An override is our false positive. `/snout:report` lists them under FALSE-DENY, and that
number is the one that decides whether enforcement is trustworthy.

## Seeing a whole folder before any session

`/snout:scan [dir]` runs the same rules over every file and prints the per-label
distribution: files, estimated tokens and share per label, the same split by threshold
band, and the largest flagged files. Nothing is recorded. The tokens are exposure — every
file read whole — not what a session spent. `--deny 0.95 --ask 0.6` previews other
thresholds without changing any setting; `--json` for scripts.

## Reading the report

`/snout:report` covers the current session; `--all` covers the whole ledger; `--by-agent`
splits the waste by subagent. With subagents, REDUNDANCY counts reads that repeated one
another agent already made (same file, version and range). Tokens only —
dollars are an org view, derivable from the same rows, and never in the default report.

- **headline** — how much context the session's reads added, and how much of it a rule
  judged low value (0 or 1 out of 3). In `observe` mode none of it was withheld.
- **COVERAGE** — classified vs fell through. Tier 0 is silent on ordinary source by
  design, so a low classified share is expected; the semantic tier is what raises it.
- **BY CLASS** — reads, flagged tokens, withheld tokens and overrides per rule. If one
  class dominates, check it is right.
- **FALSE-DENY** — asks and denies the user overrode. Each is our error, and this rate
  decides whether `enforce` is trustworthy. `n/a` in observe mode: nothing was asked.
- **added latency** — only when the blocking hook is installed; it delays the agent.

## Working on the code

`src/gate/rules.ts` (run by `tier0.ts`) is ordered by authority, not cost, and the order is the policy: the
tests in `test/tier0.test.mjs` assert it.

Run `npm run verify` before any commit: typecheck, build, tests, and the latency benchmark.
The build refuses to ship a bundle it cannot execute.
