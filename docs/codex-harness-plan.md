# Codex harness plan

Status (2026-10-13): Active work is in `C:/Users/buster/Desktop/snout-context`, branch `codex/integration` at `c697b6f`. Freshly fetched `origin/main` (`c399258`) is already in this branch's history. This checkout passed `npm run verify` again after the Windows PowerShell location fix (294 tests); Codex trusted its three reviewed hooks, denied a whole task-checkout lockfile read in a live session, and earlier restored the exact 13-pass test fact after manual `/compact`. The temporary enforce config was removed. No commit or push was made during this validation. The 18-session held-out pilot on the earlier bundle is recorded but did not clear its quality/scope gate and had no Snout interventions. The rebuilt bundle has only the focused live denial so far. The supervised pilot and cross-agent parity remain open; see `docs/harness-validation-codex.md` and `docs/codex-claude-handoff.md`.

Earlier status, retained for history (2026-10-12): The uncommitted Codex implementation has been ported from the independent `C:/Users/buster/Documents/snout-context-codex` checkout onto a separate, clean `codex/harness-main-sync` branch in `C:/Users/buster/Documents/snout-context-codex-main`, based on verified GitHub `main` at `6d0fc83`. The original checkout and its uncommitted work remain intact, with a local backup in its ignored `.snout/port-backup-2026-10-12/` directory. The port preserves main's newer replay, compaction memory, and Windows changes; it does not restore main's deleted handoff module. On the new branch, typecheck and build pass, `npm test` passes 285/286 tests with one Windows symlink-permission skip, the 71-case classifier evaluation passes, and the latency benchmark passes. The earlier live Codex pilots are historical evidence from the original checkout; they have not been rerun on this branch. The new checkout is trusted in Codex: all three hooks fired in live sessions, and one enforced lockfile denial recovered through targeted search. Snout was returned to observe mode. The earlier three paired pilots have not been rerun on this branch. No commit or push has been made. See `docs/harness-validation-codex.md` for the split evidence and remaining gates.

## Goal and boundaries

Snout's classification, ledger, reporting, and policy should be shared across agents. Codex has its own hook adapter and session format; the Claude Code plugin and hook configuration stay as they are. Local Codex can use project hooks. Cloud execution needs its own capability check and evidence before making the same enforcement or savings claim. Treat hook coverage as a guardrail, not an absolute file-access boundary: some specialized Codex tool paths can opt out.

Do not commit, push, or rewrite commits without the user's explicit authorization for each action. Keep work on the Codex branch as uncommitted files for review. Generated `.codex/hooks.json` contains machine-specific paths and is ignored. PreToolUse, PostToolUse, and SessionStart are trusted in the independent clone. `snout init codex` now installs only those three by default and removes old Snout-owned UserPromptSubmit and Stop entries on re-run, without touching another tool's hooks. UserPromptSubmit and Stop are untrusted in the current local test and remain out of its ignored hook file.

## Implementation order and exit criteria

| Order | Work | Exit criterion | Current state |
| --- | --- | --- | --- |
| 1 | Isolate the checkout and hook source | Codex reports this repository's own hook file and bundle; no old worktree bundle runs | Passed in Desktop checkout: three active hooks target its bundle |
| 2 | Preserve Claude behavior | Shared changes pass Claude-relevant tests; no Claude hook or plugin configuration changes | Desktop Windows `npm run verify` passed after the Codex-only path fix (294 tests, classifier eval, latency); Claude hook configuration untouched |
| 3 | Establish Codex hook semantics | Gate uses supported deny/allow output, never unsupported ask/output replacement; observe mode records without blocking | Adapter and live `updatedInput` tests pass; `PostToolUse` non-error replacement remains unproven in this CLI |
| 4 | Gate native Windows reads | Whole-file PowerShell lockfile/secret reads are handled; bounded searches remain allowed; reason gives a usable recovery command | Unit tests, live lockfile deny/search, two natural vendored-library denials, and live single-command generated-file trim pass; compound commands retain denial |
| 5 | Restore context after compaction | Codex rollout reader extracts exact task facts, redacts pins, and returns bounded context on compact SessionStart | Passed in a local Codex manual `/compact` test: the model-visible hook block included the exact test command and 13-pass result. Automatic compaction and cloud remain open. |
| 6 | Measure returned output and usage | PostToolUse records actual returned bytes for supported paths; Codex usage is read from CLI JSON; quality and latency accompany usage | MCP accounting and Codex CLI usage pass; a three-repeat Windows pilot reports an effective-token proxy, not billed cost |
| 7 | Test task correctness under enforcement | In one Codex session, deny, recover, finish a coding task, and pass its deterministic task test without edits outside scope | Passed in a controlled fixture: full generated-bundle read denied, targeted search used, source fixed, and 2 checkout tests passed in the same Codex session. The stricter natural-task pilot passed all 12 external checks and 12 in-session tests; held-out quality remains open. |
| 8 | Run repeated paired tasks | Same task set and baseline in off/on arms; both arms pass; include bulk-read, control, and adverse cases; publish distributions, not one run | Historical independent checkout: `money,cart`, `usersRead,cart`, and adverse `usersCompound,cart` each passed three paired repeats and the stricter quality gate. Forced native trim: bulk proxy −25.3%, control +5.3%; forced compound deny/recovery: bulk −31.9%, control +22.5%. Held-out cases remain open. |
| 9 | Held-out and supervised pilot | Frozen repositories/tasks unseen by classifier tuning, false-deny review, timeouts/fail-open accounting, rollback to observe, operator review | Three pinned tasks ran three off/on pairs each under the prior bundle. Official grades: off 8/9, enforce 9/9; one off-arm modified an existing test against the frozen prompt; no Snout intervention occurred. The new path fix has a live denial but needs fresh held-out quality and the supervised pilot. |
| 10 | Merge handoff | Review diff against current main and coordinate with Claude instance; user authorizes any commit and later push separately | Latest origin/main is still an ancestor; local verification and the live path-gate check passed. Branch CI, a Mac Claude/Codex smoke check, cross-agent review, and user-authorized commit/push remain open for an integration merge; held-out scores remain a later release claim gate |

The supervised pilot comes after controlled task evaluations because a gate can save context yet still block a needed file, miss an alternate tool path, or break a task. The pilot bounds the first real deployments and provides a quick switch back to observe mode. Held-out tasks guard against mistaking synthetic cases written alongside the rules for general performance.

## Claude–Codex parity boundary

Both adapters call the same classifier, gate policy, ledger, report, and compact-memory
selection. The host agent decides which hook events and response fields can actually act:

| Outcome | Claude Code plugin | Codex CLI on this branch |
| --- | --- | --- |
| Pre-read gate | `Read` and shell hooks can deny or trim a read | Shell `PreToolUse` denies ambiguous whole-file prints and trims one literal generated-file read to 60 lines via `updatedInput`; bounded reads and searches continue |
| Tool and MCP output | Squeeze can replace returned output | Snout records only. In a live Codex CLI probe, `decision: block` replaced the result but surfaced a tool error; `continue: false` left the original visible. Safe Squeeze parity remains open. |
| Compaction memory | Plugin lifecycle restores selected facts | Trusted `SessionStart` restored selected facts after manual `/compact` in one local test |
| Prompt and stop lifecycle | Plugin registers `UserPromptSubmit` and `Stop` | Excluded from default setup pending separate review; no parity claim |
| Measurement | Claude cost and usage from its own run record | Codex input, cached input, and output from CLI JSON; effective tokens are a proxy |

The common policy can extend to more agents through adapters, but each adapter needs its
own capability map and live correctness tests. A shared ledger row alone does not prove
that a host blocked, trimmed, or restored model-visible context.

## Next engineering slice, in priority order

1. **Add held-out and natural cases to the evaluation.** The forced native-trim and
   compound-command pilots passed three paired repeats each, and a multiline credential
   regression stays denied. The tasks were built beside the implementation. Freeze
   fresh repositories and natural prompts, with in-session and external checks;
   measure intervention frequency separately from task-level usage.
2. **Keep Codex output Squeeze disabled pending a safe host contract.** The live
   `PostToolUse` probe found only error-producing replacement in CLI 0.153.4. Recheck
   `continue: false` and a large MCP result on a future CLI without changing the trusted
   hook command; enable only after the model sees a compact success result without a
   tool error and passes task checks. Claude's output replacement remains unchanged.
3. **Extend cross-agent evaluation.** Run the same tasks and task checks with each
   agent's own off/on baseline, including bulky files, noisy test/MCP output, ordinary
   source, and adverse cases. Require in-session and external task tests, record
   intervention and false-deny rates, and report paired distributions. Compare
   relative reductions within each agent; Codex effective tokens are not Claude dollars.
4. **Complete the release gate.** Windows `npm test` now runs with no worker-process
   isolation and passes locally; verify Windows CI and the one symlink test on a host
   with symlink permission. Then verify automatic compaction, held-out repositories,
   a bounded observe-first supervisor pilot, and cloud execution separately.

## Held-out Codex task protocol — fixed before execution

This next gate uses real public issue reports from [SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified) and independent test outcomes, not the generated `shopfront` tasks in `bench/ab.mjs`. The Windows-capable Codex runner is `bench/codex-heldout.mjs`; `bench/codex-heldout-grade.py` invokes official SWE-bench 3.0.17 to grade the saved patches. The existing `bench/swe.mjs` remains Claude-specific and its results cannot be relabeled as Codex results.

1. First draw: from the SHA-256-verified 500-row SWE-bench Verified test Parquet (`a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd`), take exactly one `<15 min fix` issue from each of `astropy/astropy`, `matplotlib/matplotlib`, and `scikit-learn/scikit-learn`. These three repositories did not appear in the earlier SWE task-pilot set; they are not claimed to be absent from the broader 100-repo file corpus. Within each repository, choose the row with the smallest SHA-256 of UTF-8 `20261013:<instance_id>`, ordered lexicographically. Reject any ID seen in prior task runs. Freeze the task IDs, repository/base commits, issue text, Docker image digests, Snout bundle SHA-256, CLI/model versions, and prompts **before** the first Codex run. Keep the task list immutable; any later change is a dated amendment and a fresh run.
2. Use the same natural issue prompt and environment for three paired repeats of observe/off and enforce/on per task. The Codex runner must use this trusted checkout's reviewed three-hook command, prove the hooks fired in each run, isolate every task checkout, and record a bounded timeout. Do not copy credentials, bypass hook trust, or enable output Squeeze.
3. Require an in-session task-specific test and the official external FAIL_TO_PASS plus PASS_TO_PASS grade. Save the patch and reject edits outside the task scope. A run that timed out or failed to start is reported separately; it is not silently discarded or counted as savings.
4. Report task resolution and regressions first. Then report per-arm input/cached/output tokens, the effective-token **proxy** (not billed dollars), paired spread, and gate intervention count per tool read and per task. Review each apparent false denial and every follow-up read after a deny/trim; distinguish a quiet task from a successful intervention.
5. Only after held-out quality passes, run a small operator-reviewed pilot in observe mode, then enforce for a bounded group with a documented switch back to observe. Automatic compaction and cloud need separate checks. A savings claim requires the pre-registered quality gate and uncertainty analysis, not a single favorable session.

Docker Desktop is authenticated and its Linux engine reports about 16 GB of memory. The 500-row official Verified Parquet is SHA-256 checked; the frozen IDs are `astropy__astropy-7166`, `matplotlib__matplotlib-22719`, and `scikit-learn__scikit-learn-14141`, with pinned image digests in `bench/codex-heldout-tasks.json`. All three images are downloaded. A root-started Codex run reaches the three trusted hooks while its task checkout stays under the locally excluded `bench/heldout-workspaces/`. A sandboxed Codex process cannot open Docker Desktop’s named pipe, so `python`/`pytest` bridge through a local runner request queue into the pinned container. The first direct-Docker Astropy pair is infrastructure-invalid; the queue-backed replacement pair passed in-session pytest and official SWE-bench FAIL_TO_PASS plus PASS_TO_PASS grading in both arms. SWE-bench 3.0.17 needs a Windows-only process-local shim for its unused POSIX `resource` import and LF writes of its Linux eval script; the first CRLF external grade is likewise infrastructure-invalid. There were zero Snout gate interventions in the valid pair, so no savings conclusion follows. Keep the prior fixture scores labeled controlled until the three-task, three-repeat protocol is complete.

## Validation matrix

- **Hook registration:** `/hooks` must identify the Desktop checkout and show only the approved events active. Recheck after changing the hook command or bundle path; trust is scoped to the reviewed command.
- **Gate:** assert Codex's tool call is blocked before a full read; verify one `client: codex` ledger row and a targeted search that returns the requested fact.
- **Quality:** run a task-specific test in the Codex session, then check no unintended tracked file changes. The repository `npm test` selects `--test-isolation=none` on Windows; direct `node --test` still needs that flag in this sandbox. A shell-launch or test-spawn error fails the task gate even if Snout's deny worked.
- **Savings:** save off/on traces and Codex's input/cached/output usage. Require at least three passing paired repeats, a bulk-path and a control task, and an observed gate intervention before publishing an efficiency headline. Report medians and spread. `tokensAvoidedEst` is a file-size estimate, not realized model savings. A ChatGPT-plan run does not expose Claude-style per-run billed dollars.
- **Safety:** test secrets, uncertain reads, quoted Windows paths, pipelines, repeat reads, large MCP output, hook timeouts, and all unsupported response fields. Document any tool path the hook does not observe.
- **Memory:** local manual `/compact` now triggers trusted SessionStart and restores the exact test command/result in a model-visible developer block. Recheck automatic compaction and future Codex rollout formats before a broader parity claim.
- **Cross-platform:** run Windows native, macOS, and Linux CI with appropriate symlink and path fixtures. Local Windows `npm test` and the hook-latency benchmark pass; Windows CI and the symlink test with privilege remain open, as recorded in the validation report.

## Coordination and release decision

This branch contains GitHub `main` through `c399258`, verified against freshly fetched `origin/main` on 2026-10-13. Before a merge proposal, refresh `main`, review the diff and run CI, including Claude behavior and the new Codex hooks. Rebase or merge any newer main changes into this branch only after preserving these uncommitted files. The older `Documents/ChatGPT/snout-fde` branch has unrelated history; do not merge it into this branch. Give the Claude Code instance the reviewed diff and test report, then resolve overlap against the latest main before the user authorizes a commit. A push is a separate authorization.

Release wording (2026-10-13): **In the Desktop `codex/integration` checkout, local Windows verification, the three trusted hooks, lockfile denial with targeted recovery, and manual post-`/compact` memory restoration passed. The earlier paired fixture scores remain historical evidence from an independent checkout and are not treated as held-out or merged-checkout measurements. Codex output Squeeze remains disabled. Automatic compaction, cloud behavior, held-out task quality, and the supervised pilot remain open.**
## 2026-10-13 held-out decision and next gate

The frozen first draw completed three off/enforce pairs on each of Astropy, Matplotlib, and scikit-learn (18 sessions, including the smoke pairs). The saved official SWE-bench reports show 8/9 resolved off and 9/9 resolved enforce, with no grader errors after the LF shim. Every session had trusted hook events and a passing task-specific Python test response; four Matplotlib `python -m pytest` runs are misreported as false by the older runner report parser, so inspect the saved bridge responses. One Astropy off-arm patch failed the official FAIL_TO_PASS grade. One Matplotlib off-arm patch changed an existing test despite the frozen prompt's scope restriction. The quality/scope gate therefore did not pass. All 18 sessions had zero Snout denies/trims, so there is no held-out savings estimate.

A later controlled check revealed that the old PowerShell parser resolved a read after `Set-Location` against the Snout root instead of the task checkout. The 18 sessions are useful connection and task-quality observations for bundle SHA `edeb0e16b5f76fb003a509e5a5eaa72c28092f296c0c2968c03b10892add8985`, but cannot validate enforcement coverage or the rebuilt bundle. The Codex-only parser now follows literal directory changes conservatively; a direct hook check and a real trusted Codex session denied a 24 KB task lockfile at the correct task path. The rebuilt `dist/snout.mjs` SHA-256 is `9d2320fb7e068938971e46be59a686fe6854647a8b00b71b4639d930e8bd7966`. `npm run verify` passed after that change: 294 tests (one symlink half skipped on this Windows host), 71 classifier cases, and latency budget. The original frozen manifest deliberately retains the old bundle hash; a fresh pre-registered manifest and runs are required for a score on the new bundle.

The user has chosen an integration merge before score work. The integration merge can be proposed after the uncommitted changes are reviewed, branch CI passes on macOS/Windows/Linux, and the Mac Claude Code and Codex sessions pass a same-version smoke check. This is distinct from release parity: do not claim Claude-equivalent scores. Next, freeze a fresh paired held-out draw for the rebuilt bundle, require task tests and official grades in both arms, inspect edits and false denials, and compare with a matched Claude Code run. Recheck automatic compact, cloud hook behavior, and a bounded observe-first supervisor pilot before broader deployment. Claude output Squeeze remains available only in Claude; Codex output Squeeze remains disabled until its host can replace successful tool output safely. See `docs/codex-claude-handoff.md` for the agent-to-agent handoff.