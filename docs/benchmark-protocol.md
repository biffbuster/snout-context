# Current benchmark protocol: Snout 0.3.1

This document defines the next measurements. **No release-grade or held-out 0.3.1 agent score has been recorded.** A [three-task Codex pilot](experiments/codex-gpt6-sol-2026-10-19/README.md) is diagnostic only. The older pre-registration, pilots, amendments, and results are preserved in the [historical protocol](archive/pre-0.3.1/benchmark-protocol.md). Their scores cannot be relabeled as current.

## Candidate and machine

Run on this Windows machine, from one frozen candidate. Record OS, Node, agent CLI and model versions; Snout package version, commit, dirty state, bundle SHA-256, and benchmark harness SHA-256. Install the same plugin and gate that users receive. An edited build, changed model, changed task prompt, or changed grading rule starts a new run; never append those rows to an earlier result. Preserve all attempts, errors, exclusions, and off/on order.

Before paid runs, pass `npm run verify`, inspect `npm pack --dry-run`, check the Claude Code and Codex hook contracts, and run a local install/hook smoke test. The strict claim check is expected to fail until a current raw result is cited in [claims.md](claims.md).

## Release regression run: internal coding tasks

`bench/ab.mjs` has 14 authored coding tasks. Run each on Claude Code with Snout off and enforce, five repeats per arm: 140 sessions. This checks the complete shipped hook path, command output, MCP and memory interactions, and regressions in task completion. Use one model and identical caps for both arms. The proposed whole-run cap is $7 and the earlier estimate was about $6.30; these are planning figures, **not authorization or measured spend**. Do not start the paid run until the user approves its cost and billing route.

This fixture is useful as a release regression gate, but its tasks were written alongside Snout and are not a held-out estimate of typical repository savings. Report every task's off/on pass count, cost and attempts. A task that passes off and fails on is a headline regression. The principal efficiency metric is cost per solved task with a paired, task-bootstrap 95% interval; also report total spend, input/cache/output tokens, turns, Snout interventions, and recovery reads. A cost reduction requires the entire interval below zero. The predeclared no-quality-loss margin is −5 percentage points; its 95% lower bound must be above that margin. Merely equal point estimates or a small all-pass sample are not enough to imply general quality parity.

## Product score: held-out repository tasks

After the release regression run, use the existing `bench/swe.mjs` task selection and official SWE-bench grader on repositories we did not author. Freeze selected task IDs, agent/model, Snout build, Docker image, prompts, per-session limits, exclusion rule, and quality margin before the pilot. Pair off/on attempts by task and repeat. The primary score is **cost per solved held-out task**, with a task-clustered 95% interval and the resolved-rate difference. Report Pass^k, timeout and recovery cost as secondary measures. A small capped pilot estimates feasibility and variance; scale to a confirmation run only if the pilot justifies the spend. Docker grading requires a working Docker/WSL2 or Mac setup on the machine that runs it. This Windows machine has Docker and the SWE Python environment, and a fake-agent official-grader smoke passed on one cached image; a live agent pilot remains pending.

## Codex and memory

Run Codex on its own matched off/on task set. Under a plan, its effective-token measure is a proxy, not a dollar bill; never combine Codex and Claude rows into one effect estimate. Run compaction and cross-agent recall as separate quality evaluations with same-set, current-build rows, including facts retained, false recalls, and task outcome. The older 66%→97% retention figures came from different sets and cannot be a 0.3.1 claim.

## Publication standard (fixed 2026-10-13)

Publish only a complete, version-stamped, reproducible result. A savings claim requires the paired 95% interval for cost per solved task entirely below zero. A no-quality-loss claim requires the 95% lower bound for the resolved-rate change above the predeclared margin, and all material regressions and exclusions must be visible. Keep the raw JSON and derived attempts CSV, summary JSON, and chart in the repository. Cite each current result from [claims.md](claims.md). Historical results remain labeled as historical in the [archive](archive/pre-0.3.1/README.md).

For an all-pass paired set, the ordinary task bootstrap has a misleading zero-width quality interval. The reporter instead uses a one-sided 95% exact zero-harm lower bound based on the count of unique tasks, not repeated attempts: `100 × (0.05^(1/tasks) − 1)` percentage points. This is a conservative quality gate for small all-pass samples; the paired task bootstrap still supplies the efficiency interval. Historical reports are frozen with their original analysis.
