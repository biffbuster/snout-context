# Codex validation and main-branch integration

## Merged into the main checkout — 2026-10-13

This work now lives in `C:/Users/buster/Desktop/snout-context` on branch `codex/integration`: `codex/harness-main-sync` (commit `9932e22`) merged with current `main`. Work only in that folder; the clones named below are superseded. Changes made in the merge:

- One Codex session reader, `src/compact/codex.ts`, used by `codexSessionFacts`. It keeps this branch's rules (`content_item_kinds`, `CommandExecution`) and adds the desktop app's records: `shell_command`, code-mode `exec` cells (`tools.exec_command`, `tools.apply_patch`, `tools.update_plan`), the freeform `apply_patch` tool, the `## My request:` part of a message with attached files, and injected context without metadata (`# AGENTS.md instructions for …`, a leading tag). Checked on 185 local Codex sessions: no injected text is restored as the request.
- `npm.cmd test` counts as a test run, and a `node --test` run with failures shows `ℹ pass N · ℹ fail N` and keeps the last error.
- Windows tests: the symlink test still runs its copy half without symlink rights; the crafted filename uses U+2028; the latency bench spawns hooks through Git Bash, as Claude Code does on Windows.
- Not taken: a Codex PreCompact hook and an MCP-output hook. Both need new hook approval and a live check first.

`npm run verify` passes on Windows: 293 tests, eval, latency.

The Codex implementation is uncommitted on `codex/codex-harness-live` in the independent clone at `C:/Users/buster/Documents/snout-context-codex`. Its `origin` is `https://github.com/biffbuster/snout-context.git`; HEAD is `406e7a3`, the verified `origin/main` baseline at setup. The clone has its own `.git`, dependencies, built bundle, and ignored project-local `.codex/hooks.json`. No commit or push has been made.


## Current main-based integration — 2026-10-12

The uncommitted integration is on `codex/harness-main-sync` in the independent clone at `C:/Users/buster/Documents/snout-context-codex-main`, based on verified GitHub `main` commit `6d0fc8349e00bf62c9a5ba6d36ae892aaa35c58a`. The original `codex/codex-harness-live` checkout remains untouched, with its diff and untracked files additionally backed up in its ignored `.snout/port-backup-2026-10-12/` directory. No commit or push has been made.

The port took Codex adapter, PowerShell gate, focused tests, and documentation into a clean clone, then merged shared CLI, benchmark, and memory changes against current main. It retained main's replay, progress-memory, dashboard, and Windows changes and did not reintroduce the deleted `src/compact/handoff.ts`. `git diff --check` found no whitespace errors and no conflict markers remain. Typecheck and build passed. Focused agent/memory/security tests passed 54/54. The full Windows `npm test` passed 285 of 286 tests, with zero failures and one explicit symlink-permission skip. `npm run eval` passed its 71 deterministic cases; it remains a synthetic, non-held-out classifier set. `npm run bench` passed its 1 ms classification and 75 ms plugin-overhead budgets (20.4 ms median overhead in this run).

The first read-only CLI probe (`01a130e5-29cf-7453-98af-317593ac99a4`) produced no heartbeat because this new folder was not yet trusted. Codex CLI then displayed all three project hooks as installed but inactive pending review. After reviewing the exact local commands in `.codex/hooks.json`, the new folder and its PreToolUse, PostToolUse, and SessionStart hooks were trusted through the normal Codex UI, without the trust-bypass flag. A fresh read-only session (`01a13130-cfd2-7bd2-85ed-7569126e236b`) recorded its SessionStart heartbeat. Another read-only session (`01a13131-4139-7542-9cec-8cdea1ce41a9`) recorded SessionStart, PreToolUse, and PostToolUse for a bounded `package.json` read, with no hook errors or tracked edits. A controlled enforce session (`01a13132-2a8b-75d0-8208-a6e13da6536a`) blocked `Get-Content -LiteralPath package-lock.json` before execution; Codex recovered using targeted `Select-String`, found root version `0.2.2`, and reported the block. The ledger records one Codex lockfile denial, 18,728 file bytes and 8,436 estimated withheld file tokens; that estimate is not measured model savings. The local config was returned to observe mode after the probe.

These checks establish local regression compatibility on the main-based branch, including Claude tests. They do not transfer the earlier live hook or paired-task results to the new checkout automatically. The new-path hook trust, live connection, and one controlled denial/recovery probe now pass. CI on Windows/macOS/Linux and held-out quality work remain before a merge or beta claim. Any commit and later push each require separate explicit user authorization.

## Historical live Codex validation — original checkout

### Verified results

| Check | Observed result |
| --- | --- |
| Hook source and trust | Codex CLI 0.153.4 identified this clone's own `.codex/hooks.json` and `dist/snout.mjs`. PreToolUse, PostToolUse, and SessionStart are trusted. UserPromptSubmit and Stop remain untrusted and are omitted. After regenerating the three-hook file with `snout init codex`, a read-only CLI session (`01a123eb-0e36-7ae2-932e-1909b1ae686d`) recorded its SessionStart heartbeat in `.snout/hooks.jsonl`; it made no tool calls. |
| Live gate and recovery | Two controlled enforce-mode Codex runs blocked `Get-Content -LiteralPath package-lock.json` before execution and recovered with targeted PowerShell `Select-String` to find root version `0.2.2`. The second run also completed `node --test --test-isolation=none test/bash.test.mjs` in the same Codex session: 13 passed, 0 failed. Session `01a12297-e3c8-7a71-8ef9-8baaaf383b1a`; ignored trace at `.snout/repo-gate-complete.jsonl`. |
| Gate ledger | Each controlled run has a Codex `Bash` row: `decision: deny`, `rule: lockfile`, 18,728 file bytes, and `tokensAvoidedEst: 8436`. That last value is an estimate of withheld file text, not measured model-token savings. |
| Repository state | The live task made no tracked edits. `git diff --check`, typecheck, and build passed. The intentional Codex edits remain uncommitted. |
| Focused behavior | Typecheck and build passed. The Codex/memory subset passed 27/27. After the wrapped PowerShell fix, `node --test --test-isolation=none test/agents.test.mjs test/memory.test.mjs test/integration.test.mjs test/mode.test.mjs test/serve.test.mjs` passed 96/96 across Codex adapters, shared policy, memory, and Claude lifecycle behavior. |
| Deterministic classifier eval | `npm run eval` passed 71 synthetic cases: 36 covered; 100% accuracy on covered cases; zero false denies among nine essential files. The dataset informed the rules and is not held out. |
| Paired Codex task pilot | The stricter `money,cart` run (`run-1791605425807.json`) passed 12/12 external and in-session task tests across three off/on repeats per task. Two natural enforce-arm denials occurred. The bulk-task effective-token proxy fell 35.0% in aggregate, while the control rose 3.1%; see the spread and limitations below. Earlier `deps` and `orders,cart` runs produced no score. |
| Full local test suite | `npm test` now passes on Windows: 274 tests, 273 passed, zero failed, one explicit symlink privilege skip. The test launcher selects no worker-process isolation on Windows. The earlier MCP audit home fixture, dead-server timeout, path, and invalid-filename failures are fixed. CI has not yet run on these changes. |
| Classifier and latency gates | `npm run eval` passed 71 deterministic regression cases, with 36 covered, 100% covered accuracy, and zero false denies among nine essential files. `npm run bench` passed at its full sample size: median hook overhead 16.1 ms over a same-shell floor, within the 75 ms budget. Neither result measures Codex task savings. |
| Native Codex read trim | Live session `01a1267e-eddf-7fb3-9f62-ad7395cf6410` rewrote a standalone `Get-Content -LiteralPath 'src/client.gen.js'` to `-TotalCount 60`. The model-visible result stopped at line 60 (`op59`), and the agent answered from that bounded output. The Codex ledger recorded `trimmed: true`, range `1:60`, 155,836 original file bytes, 1,905 estimated read tokens, and 64,692 estimated withheld tokens. Those estimates are not realized savings. |
| Paired native-trim pilot | Three off/on `usersRead,cart` repeats (`run-1791648506486.json`) passed all 12 external and in-session task tests. All three enforce generated-read runs recorded one trim and a `-TotalCount 60` command; all off arms read whole, and controls had no intervention. Bulk-task effective-token proxy changed 91.0k → 68.0k (−25.3%); control changed 52.6k → 55.4k (+5.3%). This is a forced-read fixture, not natural or held-out savings. |
| Paired compound-command pilot | Three off/on `usersCompound,cart` repeats (`run-1791648964445.json`) passed all 12 external and in-session task tests. All three enforce bulk runs denied the compound whole-file print, used targeted search, and finished the fix; none showed the full generated output. Bulk-task proxy changed 91.8k → 62.5k (−31.9%), while control rose 43.9k → 53.8k (+22.5%). This is a forced adverse fixture, not a general savings estimate. |
| PostToolUse replacement probe | In live CLI 0.153.4 sessions, `continue: false` with either `stopReason` or `additionalContext` left the original marker visible. `decision: block` hid the original marker and delivered the short hook feedback, but surfaced a tool error. Probe code was removed after testing. Codex Squeeze remains disabled; no MCP-output replacement claim follows. |

## Native trim and output-contract probe

The existing trusted PreToolUse hook exercised the new Codex-only rewrite in an ignored
in-repository fixture. The JSON event and the agent's answer agree: the executed command
included `-TotalCount 60`, the result ended at `op59`, and no later function was visible.
The fixture trace is `.snout/native-trim-live.jsonl`. The unit regression checks the
allow/`updatedInput` response and rejects compound commands, pipes, redirects, and
variable paths for rewriting; those continue through the existing gate. Only generated
and vendored classifications can take this trim path. A separate regression verifies
that a multiline `.env` remains denied without exposing even its first line.

The trusted PostToolUse hook was probed with a harmless `ORIGINAL_BULK_MARKER_93`
file. The two non-error response shapes left the marker in the model-visible result
(`.snout/post-feedback-probe-2.jsonl` and `-4.jsonl`). A `decision: block` response
replaced it with `SNOUT_PROBE_REPLACED`, and Codex logged a tool error
(`.snout/post-feedback-probe-3.jsonl`). This CLI behavior does not provide a safe
success-shaped Squeeze replacement yet. The temporary probe branch was removed from
the source and rebuilt bundle; no new hook command or trusted event was installed.

Windows portability work also fixed a real MCP audit bug: a child server that exited
before returning `tools/list` consumed the full 60-second timeout. The child now
settles immediately on close. Tests use the Windows user-profile home for fake Claude
sessions, normalize project-relative handoff paths, and use a Windows-valid crafted
filename. The symlink test reports a skip only when Windows denies symlink creation.

## Paired native-trim coding task

The controlled `usersRead` task required the same first whole-file read in both arms,
then a fix to `fetchUserName` and an in-session test. The unchanged `cart` task was the
control. `bench/ab.mjs` created each fixture under this repository's ignored `.snout/`
directory and used the three already trusted hooks. The runner required three pairs,
an observed intervention, external grading, and a passing test inside each Codex
session. The run exited 0 under `--gate`; the JSON record is
`bench/ab-results/run-1791648506486.json`, with per-session traces in the preserved
ignored fixtures.

| Task | Pair 1 off → on | Pair 2 off → on | Pair 3 off → on | Aggregate change |
| --- | --- | --- | --- | --- |
| `usersRead` (forced generated read) | 32,668 → 22,511 | 29,849 → 27,392 | 28,478 → 18,097 | −25.3% |
| `cart` (control) | 14,692 → 17,548 | 17,537 → 17,562 | 20,363 → 20,293 | +5.3% |

The three bulk pair changes were −31.1%, −8.2%, and −36.5%; combined effective tokens
for both tasks were 143.6k → 123.4k (−14.1%). Effective tokens use the same
uncached-input + 0.1 × cached-input + output proxy as the earlier pilot, not billed
cost. The task deliberately forced the first read and reused a synthetic fixture, so
this result validates the new trim's task quality and a local usage signal. It does
not estimate spontaneous intervention frequency, performance on held-out repos, or
Claude-equivalent savings.

## Paired compound-command recovery

The `usersCompound` task forced a marker, whole generated-file print, and second marker
in one shell command before the same `fetchUserName` fix. A safe rewrite cannot preserve
that command's semantics, so the Codex gate denied it. In the strict three-pair run
(`bench/ab-results/run-1791648964445.json`), each enforce arm recorded exactly one
denial, followed a targeted search, never showed the full generated output in its
trace, and passed the in-session and external users test. All six control-task arms
also passed. The run exited 0 under `--gate`.

| Task | Pair 1 off → on | Pair 2 off → on | Pair 3 off → on | Aggregate change |
| --- | --- | --- | --- | --- |
| `usersCompound` (forced adverse read) | 29,085 → 19,054 | 29,017 → 24,060 | 33,720 → 19,424 | −31.9% |
| `cart` (control) | 13,843 → 18,572 | 17,488 → 17,627 | 12,580 → 17,604 | +22.5% |

The bulk pair changes were −34.5%, −17.1%, and −42.4%; combined effective tokens
changed 135.7k → 116.3k (−14.3%). The control increase shows substantial run noise
even without intervention. These tasks are synthetic and the read was forced, so this
is evidence of bounded recovery and quality under the adverse command shape, not a
held-out or deployment savings forecast.

## SessionStart isolation and controlled coding recovery

Codex `SessionStart` no longer repairs `.claude` gate settings or starts Claude's fast-gate server. Claude's own SessionStart retains both behaviors. Typecheck, bundle build, and 27 focused agent/memory tests pass, including a regression that leaves a stale Claude gate byte-for-byte unchanged under Codex and confirms Claude still repairs it. The user then authorized trusting Codex SessionStart alone; UserPromptSubmit and Stop remain off.

A live Codex CLI 0.153.4 session (`01a123c3-086c-7610-9006-60ba58705789`) ran `node --test --test-isolation=none test/bash.test.mjs` (13 passed), then manually invoked `/compact`. The approved SessionStart hook fired on startup and after compaction. The first compact run exposed two real-rollout gaps: Node TAP reports `ℹ pass 13`, which the parser had not recognized, and Codex stores injected `AGENTS.md` instructions as user-role messages. Snout now recognizes the TAP verdict and uses Codex's `content_item_kinds` metadata to exclude injected instructions from the restored request. In the final live continuation, the rollout's model-visible developer message contained the exact test command, `ℹ pass 13`, and the actual prior user request; the agent reported the command and count correctly. The rollout is under `C:/Users/buster/.codex/sessions/2026/10/09/rollout-2026-10-09T22-02-26-01a123c3-086c-7610-9006-60ba58705789.jsonl`. This verifies manual local compaction for the tested CLI format, not automatic compaction or cloud behavior.

A controlled Codex CLI 0.153.4 session in an ignored repository fixture was instructed to attempt a full read of `dist/shopfront.min.js` before fixing a checkout bug. The trusted PreToolUse hook denied the read (`client: codex`, `rule: vendored`, estimated 96,289 file tokens withheld). The agent then used targeted `rg -n -C 3` across the bundle, source, and test, changed only `src/checkout.js` in the fixture, and passed both `test/checkout.test.js` cases in that same session. Session `01a123bb-bc67-7450-9519-b53e633848f2`; ignored trace at `.snout/ab-fixtures/snout-ab-enforce-vgKC4h/.snout/codex-recovery-guidance.jsonl`. Because the prompt required a bulk-read attempt, this establishes gate recovery and task correctness, **not** naturally occurring intervention or realized token savings.

The first controlled recovery exposed a guidance bug: after the denial, the agent tried `snout allow`, which was unavailable on PATH in that fixture, then recovered by inspecting source and passed both tests. The Codex denial message now directs bounded reads/searches and reserves allow-list changes for the user; the second run followed that guidance. An earlier `crash` runner invocation never reached the model because this machine's configured default `gpt-6.1-sol` was rejected by the CLI's ChatGPT account. Explicit `gpt-5.6-luna` worked, as in the earlier paired pilot. The rejected-model invocation is excluded from quality and savings results.

A natural `orders,cart` Codex A/B run used three off/on repeats per task in ignored
in-repository fixtures (`bench/ab-results/run-1791604341991.json`). All 12 task checks
passed and every run recorded 8–10 hook events, but there were zero denials or trims. The
runner exited 1 under `--gate` and withheld its efficiency score. One off-arm `orders` trace
printed `src/api/client.gen.js` whole inside a compound `pwsh.exe -Command` string. The
existing PowerShell gate parser missed that wrapper. It now extracts literal whole-file
prints from simple wrapped scripts and leaves bounded or piped reads alone. A regression
uses the observed command form; replaying the saved off-arm command through the rebuilt
parser returns `src/api/client.gen.js` among its targets. A subsequent live enforce-only
`orders` run (`run-1791604494736.json`) passed, but chose `-TotalCount 240` and had no
denial. These results establish the blind spot and its parser fix, not a realized savings
score. A later `money,cart` task set did exercise the fixed gate, as shown next.

## Intervention-bearing paired pilot

An initial three-repeat `money,cart` run on the fixed parser (`run-1791605036273.json`)
passed all 12 external task checks, with two natural denials. Trace review showed that
two Codex sessions never passed their requested Node test inside the Windows sandbox:
`node --test` hit `spawn EPERM` and the final files passed only when graded outside the
agent. Its 28.1% bulk-task effective-token reduction is diagnostic and not the accepted
quality-gated result.

The runner now gives both Windows Codex arms the same working `node --test --test-isolation=none` command and requires a successful in-session TAP result for tasks
that request a Node test. The stricter three-repeat `money,cart` run
(`bench/ab-results/run-1791605425807.json`, model `gpt-5.6-luna`) exited 0 under `--gate`:
all 12 external checks and all 12 in-session tests passed. The off arm read the vendored
file in all three `money` runs; the enforce arm denied it in two and chose a bounded
route in the third. Across the three pairs, effective tokens were:

| Task | Pair 1 off → on | Pair 2 off → on | Pair 3 off → on | Aggregate change |
| --- | --- | --- | --- | --- |
| `money` (bulk) | 43,035 → 33,960 | 30,768 → 19,202 | 34,966 → 17,586 | −35.0% |
| `cart` (control) | 10,594 → 17,710 | 15,232 → 15,968 | 20,421 → 13,989 | +3.1% |

The bulk pairs changed −21.1%, −37.6%, and −49.7%; the control pairs changed +67.2%,
+4.8%, and −31.5%. Combined effective tokens changed 155k → 118k (−23.6%). Effective
tokens are **uncached input + 0.1 × cached input + output**, a comparison proxy for this
ChatGPT-plan Codex run, not billed dollars. The ledger's roughly 70k withheld tokens
estimate is a file-size estimate, not realized model savings. The task set is synthetic,
small, and reused during development; no held-out inference or Claude-equivalent savings
claim follows from it.

An earlier controlled lockfile gate/test run reported 80,785 input, 72,448 cached input, and 727 output tokens, with no paired off arm. The initial `deps` pair had no intervention or control; the three-repeat `orders,cart` pair had a control but no intervention. The stricter runner now rejects a release score unless both arms pass final grading and required in-session tests, at least three repeats include bulk and control tasks, and an enforce arm records an intervention. An older `deps` pair in a read-only disposable fixture failed both arms and is excluded.

## Why earlier live checks missed the gate

`C:/Users/buster/Documents/snout-context` looked like a standalone checkout but is a linked Git worktree whose common `.git` directory is under `Documents/ChatGPT/snout-fde`. Interactive Codex reported the old checkout's hook file as its project hook source even when `-C` and the displayed working directory pointed to `Documents/snout-context`. That old bundle wrote hook heartbeats but let the new PowerShell read through. The independent clone resolved the source mismatch. The older checkout and Claude plugin remain unchanged.

The default Codex CLI Windows `elevated` sandbox failed to launch shell commands with `CreateProcessWithLogonW failed: 5`. A one-command `unelevated` sandbox probe succeeded, so the live gate test used a per-invocation `windows.sandbox=unelevated` override. No saved sandbox setting changed. This fallback has weaker network isolation; plain `node --test` inside it failed with `spawn EPERM`. Node's `--test-isolation=none` allowed the 13 pure parser tests to pass inside the Codex session. The installed CLI 0.153.4 does not recognize `mxc`. The 27 focused adapter/memory tests above passed when run directly on the host.

## Remaining acceptance work

1. Extend the two repeated forced-read pilots to held-out repositories and natural task prompts. Both passed quality gates, but neither measures natural intervention frequency or deployment savings.
2. Keep Codex Squeeze off until a CLI version can replace a successful tool result without reporting a tool error. Test large command and MCP output against that version, then compare task quality and usage. Claude's Squeeze remains unchanged.
3. Verify the green Windows `npm test` run in CI, including the symlink case on a host with permission. Direct `node --test` inside this Codex sandbox still fails worker spawn; the repository test script chooses the passing no-isolation mode on Windows.
4. Verify automatic compaction, then run held-out repositories and a bounded observe-first supervisor pilot. Validate cloud hooks separately before claiming release parity with Claude Code. Keep Claude hooks and plugin packaging untouched.

`snout init codex` now emits only the three trusted core hooks. Re-running it removes
Snout's older UserPromptSubmit and Stop entries, while preserving third-party entries. A
focused regression test covers that migration and the Codex fallback denial guidance no
longer suggests a CLI command that may be absent from PATH. The regenerated hook file has
a fresh read-only Codex SessionStart heartbeat; an interactive `/hooks` review of that
file remains open.

The implementation and test order is maintained in `docs/codex-harness-plan.md`.

