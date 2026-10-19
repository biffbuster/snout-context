# Benchmark status for Snout 0.3.1

The 0.3.1 candidate has passed local build and test checks, but it has **no release-grade or held-out agent score**. A small [GPT-6 Sol Codex pilot](experiments/codex-gpt6-sol-2026-10-19/README.md) is recorded for diagnosis; its intervals cross zero. Historical results, reports, and methodology are preserved in [the pre-0.3.1 archive](archive/pre-0.3.1/README.md). Do not use those numbers as evidence for the current build.

Run the same held-out coding tasks on this Windows machine with Snout off and on, using the exact built package users install. Record the package version, commit, dirty state, bundle and harness hashes, model, machine, task IDs, every attempt, pass/fail, and cost or tokens. Compare cost per solved task and report the paired 95% interval and any task that passes off but fails on. Preserve failed attempts and infrastructure exclusions.

Start with an offline install and hook smoke test for Claude Code and Codex. Then run a small, capped paid pilot to check feasibility and variance. The proposed 14-task × 5-repeat confirmation is 140 Claude Code sessions; it requires separate spend authorization. A Codex off/on benchmark is a separate agent result, measured in effective tokens until billed cost is available. Rebuild derived reports from the new raw rows with `node bench/report.mjs` and cite only those files in [current claims](claims.md).

The publication rules and held-out task protocol are in [benchmark-protocol.md](benchmark-protocol.md). The current release-claim check will fail until fresh evidence is recorded.
