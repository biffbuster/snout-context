# Windows validation and handoff — 2026-10-19

> Historical audit snapshot taken before the clean 140-session 0.3.1 run. Its pending-score and uncommitted-candidate statements describe that earlier point in time. See [current claims](claims.md) and [benchmark status](benchmark.md) for the current result.

Repository: `claude/launch-cleanup`, with intentional uncommitted 0.3.1 candidate work. No commit, push, or paid agent run was made during this audit.

## Evidence inventory

The 0.3.1 candidate had no scored agent A/B result. We moved 10 tracked pre-0.3.1 raw JSON results, 18 derived report files, and three historical narrative/protocol documents to `docs/archive/pre-0.3.1/`. We moved 29 additional local-only raw JSON results to `.snout/archive/pre-0.3.1/ab-results/`. All 39 old raw files are preserved; 29 are unstamped and 10 are marked 0.3.0. The `bench/` scripts and task fixtures remain active. The README and current claims now state that 0.3.1 scores are pending. `scripts/bench-clean.mjs` reads both archives before considering transcript cleanup.

## Checks on this machine

- `npm run verify`: passed (typecheck, build, benchmark syntax, non-strict claims check, tests, classifier eval, and local performance bench). Built `dist/snout.mjs` as version 0.3.1.
- `npm pack --dry-run --json`: package `usesnout@0.3.1`, 17 files.
- `git diff --check`: passed.
- Rebuilt all six archived studies using `node bench/report.mjs` and archived raw rows into `.snout/rebuild-check/pre-0.3.1/`. All 18 regenerated CSV, JSON, and SVG files were byte-identical to the archive. This verifies old calculations on Windows, not current performance.
- `node scripts/compat.mjs`: latest fetched Claude Code 2.1.303 had all 11 checked contract strings; latest fetched Codex 0.163.0 had all nine. The installed CLIs are older: Claude Code 2.1.280 and Codex CLI 0.153.4. Contract-string presence is not a live hook behavior check.
- Docker Desktop 27.5.1 responded, WSL2 is active, SWE Python exists, and three selected task images were cached.
- With `SWE_FAKE_AGENT=1`, ran `pytest-dev__pytest-5809` through off and enforce arms, then the official SWE-bench grader. Both patches resolved (1/1 each); the enforce arm trimmed a command result and recorded about 5,276 characters/tokens of withheld output in the diagnostic row. This was a fake-agent integration smoke, not a Snout cost or quality score. Its local ignored result is in `bench/ab-results/`.
- `node scripts/check-claims.mjs --strict`: intentionally fails, because no current 0.3.1 raw result is cited. The gate now checks exact version, a clean measured build, and the current bundle hash, not just major/minor version.
- Release-candidate package smoke: `npm pack` produced a 17-file `usesnout@0.3.1` tarball; installing that tarball into an ignored local fixture succeeded. The installed CLI reported 0.3.1, scanned 217 files in this repository, wrote all five Codex hook events against the installed bundle, and completed MCP initialize, tools/list, and a source-file read. Direct calls to the packaged Codex and Claude hook entry points bounded the same generated-file read to 60 lines. This verifies the shipped bytes and hook adapters, not a live host session.
- After release-documentation and workflow edits, `npm run verify` passed again: 348 tests, classifier evaluation, and Windows latency bench. `git diff --check` and parsing the publish workflow as YAML passed. The publish workflow now expects npm trusted publishing; the npm-side publisher connection is still pending.
- Latest fetched `main` remains at 0.3.0 and has no file changes since this branch's common base; npm `latest` remains 0.2.2. No upstream file conflict is present as of this check. The uncommitted candidate cannot be called merge-ready or published until it is frozen and the strict claims gate passes.
- A one-turn Codex CLI host probe from the ignored package fixture attempted the requested PowerShell read, but the nested Codex runtime's shell policy rejected process creation before the command ran. It returned zero lines, with no Snout outline and no live hook heartbeat. This is an environment-limited probe, **not** a passing live hook check. The direct packaged-hook checks above passed; live host behavior still needs a fresh trusted Codex session opened in this repository outside the nested CLI probe.

For the npm OIDC release workflow, the package owner must configure a GitHub Actions trusted publisher for user `biffbuster`, repository `snout-context`, workflow filename `publish.yml`, and direct `npm publish` permission. Create this connection when the release is imminent: npm requires a newly created publisher to complete its first successful publish within two days. The workflow does not publish until an approved version tag on `main` is pushed.

## Remaining blockers and order

1. Freeze one clean 0.3.1 build and exact CLI versions. The 14-task A/B runner now records OS/Node/agent CLI versions plus build/harness hashes and refuses a resume with a different runtime. The current candidate remains uncommitted; do not score it as a published release.
2. Live-smoke the shipped plugin and hooks under the chosen installed Claude Code and Codex versions. The compatibility scan alone cannot establish behavior.
3. Decide the billing route and explicitly approve spend. The 14-task × five-repeat Claude Code release regression is 140 sessions, previously estimated at about $6.30 with a proposed $7 whole-run cap. `bench/ab.mjs` currently uses the local Claude login and has no `--api` option; `bench/swe.mjs --api` can use the separate local API key. Codex can launch the runner, but that does not switch the agent under test or its billing account. Do not launch a paid run from this note.
4. After a successful release regression, run a separately capped held-out SWE-bench pilot on this machine. Its official grader path worked with the stand-in agent. Report cost per solved task and resolved-rate change, then decide whether a larger confirmation is warranted. A [matched GPT-6 Sol Codex pilot](experiments/codex-gpt6-sol-2026-10-19/README.md) now exists, but its three authored tasks and dirty build make it diagnostic only. Run a clean, larger Codex evaluation and compaction/memory evaluations separately; do not borrow Claude scores.

Only current, complete raw results should be added to `docs/claims.md`, with generated reports and all failures disclosed. Historical results stay in the archive.
