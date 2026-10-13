# Codex harness plan

Status (2026-10-12): The uncommitted Codex implementation has been ported from the independent `C:/Users/buster/Documents/snout-context-codex` checkout onto a separate, clean `codex/harness-main-sync` branch in `C:/Users/buster/Documents/snout-context-codex-main`, based on verified GitHub `main` at `6d0fc83`. The original checkout and its uncommitted work remain intact, with a local backup in its ignored `.snout/port-backup-2026-10-12/` directory. The port preserves main's newer replay, compaction memory, and Windows changes; it does not restore main's deleted handoff module. On the new branch, typecheck and build pass, `npm test` passes 285/286 tests with one Windows symlink-permission skip, the 71-case classifier evaluation passes, and the latency benchmark passes. The earlier live Codex pilots are historical evidence from the original checkout; they have not been rerun on this branch. The new checkout is trusted in Codex: all three hooks fired in live sessions, and one enforced lockfile denial recovered through targeted search. Snout was returned to observe mode. The earlier three paired pilots have not been rerun on this branch. No commit or push has been made. See `docs/harness-validation-codex.md` for the split evidence and remaining gates.

## Goal and boundaries

Snout's classification, ledger, reporting, and policy should be shared across agents. Codex has its own hook adapter and session format; the Claude Code plugin and hook configuration stay as they are. Local Codex can use project hooks. Cloud execution needs its own capability check and evidence before making the same enforcement or savings claim. Treat hook coverage as a guardrail, not an absolute file-access boundary: some specialized Codex tool paths can opt out.

Do not commit, push, or rewrite commits without the user's explicit authorization for each action. Keep work on the Codex branch as uncommitted files for review. Generated `.codex/hooks.json` contains machine-specific paths and is ignored. PreToolUse, PostToolUse, and SessionStart are trusted in the independent clone. `snout init codex` now installs only those three by default and removes old Snout-owned UserPromptSubmit and Stop entries on re-run, without touching another tool's hooks. UserPromptSubmit and Stop are untrusted in the current local test and remain out of its ignored hook file.

## Implementation order and exit criteria

| Order | Work | Exit criterion | Current state |
| --- | --- | --- | --- |
| 1 | Isolate the checkout and hook source | Codex reports this repository's own hook file and bundle; no old worktree bundle runs | Passed in independent clone |
| 2 | Preserve Claude behavior | Shared changes pass Claude-relevant tests; no Claude hook or plugin configuration changes | Windows `npm test`: 273 passed, zero failed, one symlink privilege skip; Claude hook configuration untouched |
| 3 | Establish Codex hook semantics | Gate uses supported deny/allow output, never unsupported ask/output replacement; observe mode records without blocking | Adapter and live `updatedInput` tests pass; `PostToolUse` non-error replacement remains unproven in this CLI |
| 4 | Gate native Windows reads | Whole-file PowerShell lockfile/secret reads are handled; bounded searches remain allowed; reason gives a usable recovery command | Unit tests, live lockfile deny/search, two natural vendored-library denials, and live single-command generated-file trim pass; compound commands retain denial |
| 5 | Restore context after compaction | Codex rollout reader extracts exact task facts, redacts pins, and returns bounded context on compact SessionStart | Passed in a local Codex manual `/compact` test: the model-visible hook block included the exact test command and 13-pass result. Automatic compaction and cloud remain open. |
| 6 | Measure returned output and usage | PostToolUse records actual returned bytes for supported paths; Codex usage is read from CLI JSON; quality and latency accompany usage | MCP accounting and Codex CLI usage pass; a three-repeat Windows pilot reports an effective-token proxy, not billed cost |
| 7 | Test task correctness under enforcement | In one Codex session, deny, recover, finish a coding task, and pass its deterministic task test without edits outside scope | Passed in a controlled fixture: full generated-bundle read denied, targeted search used, source fixed, and 2 checkout tests passed in the same Codex session. The stricter natural-task pilot passed all 12 external checks and 12 in-session tests; held-out quality remains open. |
| 8 | Run repeated paired tasks | Same task set and baseline in off/on arms; both arms pass; include bulk-read, control, and adverse cases; publish distributions, not one run | `money,cart`, `usersRead,cart`, and adverse `usersCompound,cart` each passed three paired repeats and the stricter quality gate. Forced native trim: bulk proxy −25.3%, control +5.3%; forced compound deny/recovery: bulk −31.9%, control +22.5%. Held-out cases remain open. |
| 9 | Held-out and supervised pilot | Frozen repositories/tasks unseen by classifier tuning, false-deny review, timeouts/fail-open accounting, rollback to observe, operator review | Open |
| 10 | Merge handoff | Review diff against current main and coordinate with Claude instance; user authorizes any commit and later push separately | Clean main-based branch, local regression checks, and live three-hook connection plus one denial/recovery probe passed; CI and final review remain open |

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

## Validation matrix

- **Hook registration:** `/hooks` must identify the independent clone and show only the approved events active. Recheck after changing the hook command or bundle path; trust is scoped to the reviewed command.
- **Gate:** assert Codex's tool call is blocked before a full read; verify one `client: codex` ledger row and a targeted search that returns the requested fact.
- **Quality:** run a task-specific test in the Codex session, then check no unintended tracked file changes. The repository `npm test` selects `--test-isolation=none` on Windows; direct `node --test` still needs that flag in this sandbox. A shell-launch or test-spawn error fails the task gate even if Snout's deny worked.
- **Savings:** save off/on traces and Codex's input/cached/output usage. Require at least three passing paired repeats, a bulk-path and a control task, and an observed gate intervention before publishing an efficiency headline. Report medians and spread. `tokensAvoidedEst` is a file-size estimate, not realized model savings. A ChatGPT-plan run does not expose Claude-style per-run billed dollars.
- **Safety:** test secrets, uncertain reads, quoted Windows paths, pipelines, repeat reads, large MCP output, hook timeouts, and all unsupported response fields. Document any tool path the hook does not observe.
- **Memory:** local manual `/compact` now triggers trusted SessionStart and restores the exact test command/result in a model-visible developer block. Recheck automatic compaction and future Codex rollout formats before a broader parity claim.
- **Cross-platform:** run Windows native, macOS, and Linux CI with appropriate symlink and path fixtures. Local Windows `npm test` and the hook-latency benchmark pass; Windows CI and the symlink test with privilege remain open, as recorded in the validation report.

## Coordination and release decision

This branch starts from GitHub `main` at `6d0fc83`. Before a merge proposal, refresh `main`, review the diff and run CI, including Claude behavior and the new Codex hooks. Rebase or merge any newer main changes into this branch only after preserving these uncommitted files. The older `Documents/ChatGPT/snout-fde` branch has unrelated history; do not merge it into this branch. Give the Claude Code instance the reviewed diff and test report, then resolve overlap against the latest main before the user authorizes a commit. A push is a separate authorization.

Release wording today: **Codex local hook gate, controlled recovery, native single-command read trim, and manual post-compaction memory restoration passed in the independent Windows repository. Local `npm test` passed 273 tests with one symlink privilege skip. Three repeated off/on pilots passed all 12 external and in-session task tests each: natural-denial `money,cart` (bulk proxy −35.0%, control +3.1%), forced native-trim `usersRead,cart` (bulk −25.3%, control +5.3%), and forced compound deny/recovery `usersCompound,cart` (bulk −31.9%, control +22.5%). Codex output Squeeze is disabled after a live replacement probe surfaced a tool error. These fixture-specific results do not establish Claude-equivalent or general savings. Automatic compaction, cloud behavior, held-out quality, and the supervised pilot remain open.**

