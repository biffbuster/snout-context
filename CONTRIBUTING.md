# Contributing

Thanks for helping. Bug reports, small fixes and measured improvements are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Report security problems privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## Making a change

1. Fork the repo and create a branch.
2. Install with `npm ci`. The source is in `src/`; `dist/` is the built bundle and is committed.
3. Make the change with a test in `test/`. Tests make no network calls.
4. Run `npm run verify`. It type-checks, builds, checks the cited benchmark results, and runs the
   tests, the classifier eval and the latency check. On Windows, run it from PowerShell.
5. Commit the rebuilt `dist/` together with the source change, and open a pull request against `main`.

[docs/development.md](docs/development.md) describes the layout, the eval and the limits.

## Changes to Snout's behavior

- Every change must work for both Claude Code and Codex, or say plainly which agent it covers.
- Snout must never block or alter a read it is unsure about. When in doubt, the read goes through.
- Nothing may leave the user's machine by default. Network features stay opt-in.

## Numbers and claims

A number about cost, tokens or recall goes in the README, the docs or a pull request only if it is in
[docs/claims.md](docs/claims.md) and backed by a results file in `bench/ab-results/`, measured on the
build it describes. `node scripts/check-claims.mjs --strict` checks this, and releases run it.
