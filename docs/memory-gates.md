# Memory gates

Drafted 2026-10-24. The [memory study](benchmark-protocol.md#memory-study) and the [shipped-default evaluation](eval-shipped-default.md) are large paid runs. Before either one runs, four smaller checks must pass, in order. Each gate answers one question, and its pass criteria are fixed before it runs. When a gate fails, the failure is fixed, a regression test is added for it, and the gate runs again. Nothing advances on a failed gate, and no gate is repeated at a larger size to get a different answer.

| Gate | Question | Cost |
|---|---|---|
| 1. Live accounting (passed 2026-10-24) | Do Snout's hooks run, and does the harness count tokens, cost and failures correctly? | Free checks, then 2 Claude Code sessions ($0.11) and 2 Codex sessions (plan) |
| 2. Fresh install (passed 2026-10-26) | What does a new user get, and do the docs say the same? | Free |
| 3. Local recall (passed 2026-10-26 on fresh set unseen 9, words only) | Given a realistic history, does Snout return the right, current, cited fact in a small budget, and stay quiet when it has none? | Free |
| 4. Real-agent pilot | With that history, do Claude Code and Codex solve new tasks at lower total tokens and cost per solved task with Snout than without? | About 32 sessions; Claude Code ceiling $8 |

## Gate 1: live accounting

**Why.** The real harness check on 2026-10-24 marked a `memory` chain invalid, and the question was whether the product failed or the checker misread it.

**Pass criteria.**

1. **Hooks ran.** In every Claude Code `trim` and `memory` session, Snout logged a PostToolUse heartbeat for every tool call its hook covers, plus the session start and the first prompt. In every arm with Snout's hooks, the side-call watch saw Snout processes. For Codex: hook rows and watched processes in every session, and per-call coverage once a real Codex session shows its event shape.
2. **Tokens and cost.** Each session's saved tokens equal the sum over its transcript's calls (each call once), and its cost equals those tokens at list price. Claude Code's own cost figure agrees within 2%.
3. **Failures.** A session that hits the time or budget limit counts as attempted, not solved, even if its patch would pass. A session the run started but never recorded (the run was killed) is priced from its transcript and counted in spend, not scored. API refusals invalidate the chain.
4. **Validity flags.** Every flag the checker raises traces to a real product or run failure.
5. **Network scan.** No hits on commands that stay local (an installed tool run through `npx`, a URL inside an edit), and every fetch in the test list is caught.

**Result: pass, 2026-10-24.** Evidence: 9 real Claude Code sessions from the stopped harness check; the kept Snout folders of 3 Hugo sessions; stand-in runs; and 4 live Gate 1 sessions on vite-22944 in `trim` and `memory`, 2 in Claude Code ($0.11) and 2 in Codex (plan). All 4 solved the task, and none was invalid.

- **Tokens: pass.** Every Claude Code session's saved tokens equal its transcript's sum exactly. Both Codex sessions' saved tokens equal Codex's own session totals exactly; output tokens include reasoning tokens.
- **Cost: failed once, fixed.** On the live sessions, the harness's cost was 17–24% above Claude Code's own figure. The two sessions' token counts fit Claude Code's totals exactly with cache reads at $0.10 per million, which is the listed price for Sonnet 5.5 (0.05× input). The harness's table (`bench/swelong.mjs`) had $0.20. Fixed, with the two live sessions as the regression test; `--summarize` now reprices Claude Code sessions from their transcripts. At list prices, the stopped check's 10 sessions cost $0.72, not the $0.89 recorded at the time. The wrong price inflated arms that read more from cache, so it would have biased `trim` and `memory` against `plain`. No published number used this table: the 140-session result in [claims.md](claims.md) used Claude Code's own cost figure.
- **The invalid flag: checker error.** Snout writes `mode: "observe"` on rows it measures but never judges: a search's unattributed lines (`tool-output`) and a user's override (`reversal`). They are written whatever the configured mode. A content search with context separators produced one in the `vite-22796` `memory` session, and the checker read it as Snout running in observe. Fixed by checking only judged rows (`bench/study-checks.mjs`, `modeProblems`). The regression test runs Snout's real hook on such a search in enforce mode.
- **Hooks: pass.** By hand, in `hugo-15086` `trim`, all 4 covered tool calls got a heartbeat. The harness now checks every session. The live Claude Code sessions saw 12 of 12 tool calls (`hookCoverage`). In Codex, the pre-tool hook fired once per shell command, 10 of 10 and 11 of 11 (`codexHookCoverage`); post-tool fires more often because file edits trigger it too. One cost found: each Claude Code Bash command that matched two of the read gate's command patterns started the pre-tool hook twice. That makes no double record, but two process starts for one call; it matters for the latency budget in the shipped-default evaluation.
- **Failures: two fixes.** The harness graded a session that hit a limit as solved if its patch passed, against the protocol; now it is attempted, not solved (`scoreStep`). A killed run lost its in-flight session's cost ($0.11 on 2026-10-24); the harness now saves the session before it starts, and `--summarize` prices it. Tested by killing a stand-in run mid-session.
- **Network scan: two fixes.** All 20 hits in the vite check were `npx vitest`, which runs the installed copy, and one Hugo hit was a URL inside a `sed -i` edit. Fixed; both are regression cases.
- **Report.** With 2 tasks the bootstrap interval is meaningless but was printed with "saving". Below 10 tasks no interval is printed.

**Regression tests:** `test/study-checks.test.mjs`, one case per failure above.

## Gate 2: fresh install

**Why.** The default mode is observe. In observe, Snout records which notes fit a prompt (`recall.jsonl`, `injected: false`) and shows the agent none (`src/cli.ts`, `promptNotes`). The README says observe "records what it would do and changes nothing", which matches. The draft shipped-default evaluation said observe "still shows notes that fit"; that was wrong and is corrected. So today, memory does not work out of the box.

**Check.** From an empty Snout config folder and a scratch project, install exactly as the README says for Claude Code and for Codex. Then run two stand-in sessions: the first establishes a fact (a passing test command), and the second asks a prompt it fits. Record what gets installed, the mode, the hooks registered, the MCP server, and every piece of text Snout adds to either session.

**Pass.** The README and the docs describe exactly what the check shows, and a regression test pins the default (observe, no notes shown). Whether notes should show in observe mode, so memory works without turning on trimming, is a product decision for the owner and is not made by this gate.

**Result: pass after doc fixes, 2026-10-26.** Two builds, each installed as the README says into empty config folders: the published 0.3.2 (the plugin from `main`, `usesnout@0.3.2` from npm) and this branch (the plugin from a clean copy, the package from `npm pack`). Each ran two stand-in sessions per agent in a new Node project. The first ran a passing `npm test`; the second asked "The add tests fail after my change. Run the tests and fix it." The stand-in fires the installed hooks the way each agent does and writes the transcript in the agent's format.

- **Installed.** Claude Code: the plugin's five command hooks (SessionStart, UserPromptSubmit, PostToolUse, PreCompact, Stop) and its status band; no MCP server (`snout init claude --mcp` adds one). Codex: `snout init codex` writes only `.codex/hooks.json` (five hooks) and `.codex/config.toml` (the MCP server) in the project, both with absolute paths to the installed package. Nothing is written to the user's home or config folders at install.
- **Mode: observe** in both agents and both builds. In both, the agent got no text from Snout in any session. You see a "Snout is on (observe)" line at session start, and a prompt-coach tip on each prompt that names no file or outcome.
- **Memory in observe.** Both builds save "Run the tests with: npm test" from the first session and record it as fitting the second prompt (`recall.jsonl`, `injected: false`), but don't show it.
- **Memory in enforce** (`snout mode enforce`, for comparison). This branch shows the test command on the second prompt with its source (about 79 tokens). The published 0.3.2 shows every saved note at each session start. That includes "Run the tests and fix it.", saved as a standing instruction after one session, and it was shown on an unrelated third task ("Rename the heading in the README."). This branch saves that line only as proposed, and never shows it.
- **Doc fixes.** The README didn't say that observe saves notes without showing them, that the coach tip appears, or that `.snout/` (whose session cards hold the start of each request) should be ignored by git; only `docs/privacy.md` said so. All three are now in the README.
- **Regression test:** `test/recall.test.mjs`, "a fresh install is in observe…", with no mode set in the environment, the project or the user config.

**Rerun on the SQLite index build, 2026-10-27: pass.** The check is now a script, `bench/fresh-install.mjs`. It packs the checkout and installs it offline into a scratch prefix with an empty home and config folder. It unpacks the same package as the Claude Code plugin and runs `snout init codex`. Each agent gets its own new Node project. Results: `bench/fresh-install/results-sqlite.json`. All 10 checks pass:
- nothing is written to the home or config folder at install;
- the agent gets no note in observe, in either agent;
- the fitting note is recorded in observe (`injected: false`);
- enforce shows "Run the tests with: npm test" with its record ("seen in a passing test run: npm test → ℹ pass 1"), from each agent's own session;
- no hook fails or writes to stderr;
- the local index is in the config folder, one per project, and none is in either project.

The user sees the same two lines as before: "Snout is on (observe)" and the prompt-coach tip.

**Found on the way.**

- **Tests wrote into the user's real config folder.** On Windows, Snout keeps private notes in `%APPDATA%\snout` unless `SNOUT_CONFIG_DIR` is set, and `test/recall.test.mjs` didn't set it: each run left about five folders of fixture notes (133 found and deleted on 2026-10-26). Fixed: `scripts/test.mjs` gives each test run its own config folder, and so does `test/recall.test.mjs` itself; a regression test checks where notes land. The benchmark harnesses already set `SNOUT_CONFIG_DIR`, so no benchmark result was affected.
- **For Gate 3: the owner's own notes in this repository**, recorded in enforce since 2026-10-21, show the failures Gate 3 must measure. Task-bound lines are saved as active standing instructions ("Do not publish npm as part of this step.", "Do not switch this dirty checkout, stash, reset, commit, merge, or push yet."), and one was shown on 2026-10-23. Wrong missing-tool notes ("snout is not installed on this machine", "resource is not installed…"). A test command from another repository (`field-test`) was saved under this one. A test command run in another folder (`cd <scratch folder> && npm test`) became this project's active test command; it was archived.
- **Product decisions for the owner:** whether observe should show notes (decided under Gate 3: it does not); whether `snout init` and the plugin should add `.snout/` to `.git/info/exclude` on their own; whether the fixes on this branch go out as 0.3.3 before the pilot, since the published 0.3.2 shows one-off instructions at every session start in enforce.

## Gate 3: local recall

**Question.** Given a realistic project history, does Snout return the right, current, source-backed fact within a small token budget, and stay quiet when it has no good answer?

**History.** A scripted history for one project, built from the shapes real sessions leave. It includes test and build commands (one of which later changes), fixes with the files they touched, decisions (one later reversed), a missing tool, facts from failed runs that must not be saved, and unrelated noise. Nothing private.

The history also carries the failures Gate 2 found in the owner's real notes: an instruction tied to one task, a "not installed" note for a tool that is installed, a test command run in another folder, and one from another repository.

**Queries.** About 40 prompts asking for past decisions, fixes and commands, a quarter of which have no answer in the history. They go through all three paths: the prompt notes a session gets, `snout recall`, and the MCP search tool.

**Rules** (set 2026-10-26). A stored source field is not enough; a fact counts as source-backed only when the record behind it can be checked.

1. **Evidence.** Every fact that becomes active without the user points to the record that supports it: the passing test run (its command and result line), the tool failure (its command and error), or the user's own action (added, accepted, or said in two sessions, with both sessions named). Anything an agent concluded without such a record stays a proposal and is never shown.
2. **Current truth.** A new test command or a reversed decision retires the old one. A fact tied to files that have changed since it was saved is withheld until it is checked again. A command keeps the project and folder it ran in, and is never offered in another.
3. **Budget and restraint.** Nothing is shown when the evidence or the fit is weak. The heading, citations, notes and "where you left off" text share one budget per prompt.

**Pass criteria.**

- right and current answer first, on answerable prompts: at least 90%;
- stale facts shown (superseded, reversed, or tied to changed files): none;
- facts shown without a checkable record (rule 1): none;
- commands shown outside the project or folder they ran in: none;
- at most 150 tokens per prompt, everything Snout adds included (median), and never above the configured budget;
- nothing shown on unanswerable prompts: at least 90%.

**Where the code stands before the run** (read from source on 2026-10-26; the run decides):

| Rule | Today | Expected |
|---|---|---|
| Evidence | A note keeps its agent, session, date and sometimes files. The citation shown (`cite`, `src/memory/facts.ts`) says only how it was saved and when, such as "seen in a passing test run; claude, 2026-10-23". The test's command output and the failing command are not kept. A repeated instruction keeps only the first session. | Fail |
| Replacement | A new passing test command supersedes the old one (`applyDistilled`, `src/memory/distill.ts`). Decisions are never replaced automatically. "Not installed" notes are archived only once the tool is on PATH at session start. | Partial |
| Changed files | Not checked. `source.files` is stored and never compared. | Fail |
| Command scope | `generalTestCommand` drops a `cd` into an absolute path, so a command run in another folder is saved as this project's. | Fail |
| One budget | `promptNotes` (`src/cli.ts:638`) caps the note block at 600 tokens (`MEMORY_BUDGET`) and adds the "left off" text outside it. | Fail |

Each failure is fixed with a regression test, and the gate runs again on the same history and prompts.

**Harness.** `bench/recall-gate.mjs` builds a scratch Node project under `~/.snout-bench/g3` and replays `bench/recall-gate/history.json` through Snout's real hooks, CLI and MCP server. The history has 14 stand-in sessions (Claude Code and Codex transcripts in each agent's format, with scripted command output), 3 notes added with `snout memory add`, and 2 MCP saves. Then it asks the 41 prompts in `bench/recall-gate/prompts.json` (30 answerable, 11 with no answer) three ways: the prompt hook in enforce, `snout recall`, and `snout_memory_search`. The history, the prompts with their expected answers, and the scorer were frozen on 2026-10-26 before the baseline (`bench/recall-gate/freeze.json`), and a run refuses to start if any of them changed. No model, network or paid call. A dry run after the freeze checked only that the replay produced the cards and notes the history describes; its scores were not read, and nothing changed before the baseline. It does not use a database or embeddings. Snout keeps notes as JSON files and ranks by words; the optional local embedding model only re-ranks `snout recall` and isn't installed here.

**Result: fail, 2026-10-26.** One baseline run on the code as it was, one final run after the fixes. Both used the same frozen inputs.

| Criterion | Baseline | Final |
|---|---|---|
| Right, current answer first: delivery | 8/21 | 19/21 |
| Right, current answer first: recall | 9/13 | 12/13 |
| Right, current answer first: search | 12/26 | **20/26** |
| Stale facts shown | 9 | 0 |
| Shown without a checkable record (uncited + unsupported) | 63 | **5** |
| Commands shown outside their project or folder | 15 | 0 |
| Delivery tokens per prompt, median / max (budget 600) | 114 / 136 | 87 / 136 |
| Nothing shown on unanswerable prompts: delivery / recall / search | 11/11, 10/11, 10/11 | 11/11, 11/11, 11/11 |
| Claude Code and Codex get the same delivery | 41/41 | 41/41 |

Results with every output: `bench/recall-gate/results-baseline.json`, `results-final.json`.

**Baseline failures and fixes.** Each fix has a regression test in `test/gate3.test.mjs`, named by the baseline prompts it covers.

- **Another folder's test command became this project's** (P01–P10, 11 prompts). A passing `cd ../field-test && npm run test:smoke` replaced the project's own test command, and so did `cd "$SCRATCH" && npm test`. A test run whose `cd` names a place outside the project is no longer saved (`runsElsewhere`), and notes saved that way before are archived at session start. Git Bash's `/c/...` path to the project now counts as the project.
- **A tool the project installs was "not installed"** (11 prompts). A bare `vitest` that the shell couldn't find became "vitest is not installed", though the project installs it and `npx vitest run` passed. A tool on PATH, in `node_modules/.bin`, or in package.json counts as installed (`installedFor`).
- **Citations didn't point to a record** (63 lines). A note now quotes what it rests on: a test command quotes its run's result line, a missing tool quotes its error, and an MCP save the user asked for says so. Search results carry the same citation; before, they had none.
- **A reversed decision stayed active** (P16, P17). When a new note says it replaces an earlier one ("now", "no longer", "instead of") and shares three or more words with it, the old one is superseded, and `snout memory add` says so.
- **A note about changed code was shown** (P28–P30). An MCP save records its files' hashes. A note whose file changed since is held back from every path, and `snout memory list` says why.
- **Search** listed notes the prompt path never shows, matched on one shared word, and ranked old sessions over notes. Search now shows only verified, current notes; it needs two of the query's words; it lists notes before session records, newest first at the same match; and a session line says what it committed.
- **Recall matched on "why"** (P33). It was missing from the stop words.
- **Recall picked an old session about a named file** (P28–P30). Sessions that changed a file the prompt names now come newest first.
- **Notes missed simple variants** (P18, P20). Words now match by stem ("store", "stored", "storage"), and a note about commits fits a task that commits.
- **Budget** (rule 3). The "left off" text and the notes now share one budget; before, the left-off text was added on top.

**Still failing (final run).**

- **Search shows a task-bound line as a standing instruction** (P01, P02, P05, P08, P09). "Run the tests and fix it." was said in two sessions, so it is saved as a preference, and search now finds it under "test". The prompt hook never shows it, because a note the prompt already says is skipped. The search fix exposed it; the underlying failure is in how instructions are saved. Gate 2 found the same pattern in real notes.
- **Search ranking, 6 misses.**
  - P02 and P05: that preference ranks above the test command.
  - P24: the test-command note ranks above the session that moved the tests to vitest.
  - P27: a decision that shares the word "route" ranks above the pagination session.
  - P28: "money representation" shares one word with any record, so the search shows nothing.
  - P30: a session where the user said "never use floats" ranks above the later one that changed how money is stored.
- **Accepted misses, not fixed:**
  - "Is just available on this machine?" gets nothing in delivery or recall. "just" is also an ordinary English word, so it matches only when it is named as a command.
  - P14's prompt names a file with unfinished work, so the prompt hook shows where the last session left off instead of the error-format decision.

**Round 2, 2026-10-26: main set passes, unseen check fails.**

Before the second round of fixes, a separate unseen check was written and frozen (`bench/recall-gate/unseen/`): a Python project with 10 sessions, 3 manual notes and 1 MCP save, and 18 prompts (13 answerable, 5 with no answer). It has different commands (pytest, tox), tools (ruff), wording, and its own versions of the same traps. It never ran before the fixes. The scorer gained `--set` to read it; scoring is unchanged, and the main set's inputs keep their hashes (`freeze.json` records the earlier scorer hash).

Fixes, each with a regression test in `test/gate3.test.mjs` ("round 2"):

- **A task request said twice is still a task request.** An instruction becomes a standing preference after a second session only if its wording makes it lasting: "always", "never", "from now on", "in this project", and similar. "Run the tests and fix it." stays a proposal. One promoted earlier goes back to a proposal at session start. One the user accepted (`snout memory accept`) stays, and is now shown, cited "accepted by you"; before, an accepted instruction that hadn't been repeated was never shown.
- **Search ranks by the question, not by the kind of record.**
  - It scores the share of the query's words a record has, and requires two of them.
  - A test-command note answers any question about running tests, and a "not installed" note answers a question that names its tool.
  - "When", "moved", "switched" and similar raise session records.
  - Naming a file raises the records that touched it.
  - At the same score, a note comes before a session record, then the newest first.
  - When no record has two words, one word counts if two or more records share it, newest first.

| Criterion | Main, final (round 1) | Main, round 2 | Unseen, round 2 |
|---|---|---|---|
| Right, current answer first: delivery / recall / search | 19/21, 12/13, 20/26 | 19/21, 12/13, 25/26 | **8/9**, 3/3, 11/12 |
| Stale / wrong-scope shown | 0 / 0 | 0 / 0 | 0 / 0 |
| Shown without a checkable record | 5 | 0 | **8** |
| Nothing shown on unanswerable prompts: delivery / recall / search | 11/11 each | 11/11 each | 5/5, 5/5, **4/5** |
| Delivery tokens, median / max | 87 / 136 | 87 / 136 | 85 / 118 |
| Verdict | fail | **pass** | **fail** |

What the unseen check caught:

- **The one-word fallback is noise outside the main set** (search Q05, Q14). "config file location" matched sessions on "file". The stemmer cut "theme" to "them", so "dark theme tui" matched two sessions that say "them". The fallback was built for one main-set prompt (P28), so it is overfitted.
- **Stems miss common variants** (delivery Q12). "Add logging to the sync command." doesn't get "Never print secrets in logs.": "logging" and "logs" stem differently.
- **A tox run cites the least informative line** (4 prompts in delivery, 4 in search). The note quotes "py312: OK (3.21 seconds)", tox's last verdict line, instead of "14 passed". The scorer counts it as uncited because it has no count. The record is real, but the line with the count is the more useful one to quote.
- **Held up on the unseen set:** no stale, wrong-scope or other-folder fact reached any path. The reversed config decision was retired, and the export note was held back after its file changed. "Please run the linter and fix what it finds.", said in two sessions, stayed a proposal. Every unanswerable prompt was silent in delivery and recall.

Results: `bench/recall-gate/results-round2.json`, `bench/recall-gate/unseen/results-round2.json`.

**Round 3, 2026-10-26: second unseen check fails.**

Mapping, written before the fixes:

| Failed output (first unseen check) | Cause | Fix |
|---|---|---|
| Search Q05 "config file location" matched sessions on "file" | The one-word fallback | Removed. A session record needs two of the query's words. A verified note may still answer a one- or two-word query on one word, as in round 1. |
| Search Q14 "dark theme tui" matched sessions saying "them" | The stemmer dropped a final "e", turning "theme" into "them" | Word forms instead of one stem: a word matches its own variants ("stored" ~ "store", "logging" ~ "logs", "dates" ~ "date"), never a shorter word it doesn't come from |
| Delivery Q12 "Add logging…" didn't get "Never print secrets in logs." | "logging" became "logg", "logs" became "log" | The same word forms. The prompt still shares only one word with the note, so it was expected to stay a silent miss under the two-word rule. |
| Tox citation "py312: OK (3.21 seconds)" | The verdict is tox's last line, which has no count | Pass/fail is still read from the verdict. The evidence adds the last line with a count and starts with the command: `tox -q → 14 passed in 0.52s · py312: OK (3.21 seconds)`. |

A second unseen check (`bench/recall-gate/unseen2/`) was written and frozen before the fixes: a Rust project with 10 sessions, 3 notes and 1 MCP save, and 18 prompts (13 answerable, 5 with no answer). The fixes have regression tests in `test/gate3.test.mjs` ("round 3"), including counterexamples that must stay unmatched or silent: theme/them, plane/plan, notes/nothing, and "config file location". Then `npm run verify` ran, then each set ran once.

| Criterion | Main | Unseen 1 | Unseen 2 (first run) |
|---|---|---|---|
| Right, current answer first: delivery | 19/21 | **8/9** | **4/8** |
| Right, current answer first: recall | 12/13 | 3/3 | 3/3 |
| Right, current answer first: search | 24/26 | 11/12 | **8/11** |
| Stale facts shown | 0 | 0 | 0 |
| Shown without a checkable record | 0 | 0 | 0 |
| Commands from another folder shown | 0 | 0 | 0 |
| Delivery tokens, median / max (budget 600) | 91 / 136 | 94 / 118 | 88.5 / 123 |
| Nothing shown on unanswerable prompts: delivery / recall / search | 11/11 each | 5/5 each | 5/5 each |
| Claude Code and Codex get the same delivery | 41/41 | 18/18 | 18/18 |
| Verdict | pass | **fail** | **fail** |

Every remaining miss shows nothing or a less relevant record. No path showed a stale, unsupported or other-folder fact in any of the three sets.

- **Main:**
  - delivery P12 and P14, recall P12: unchanged, accepted misses.
  - search P28 "money representation": silent. It was answered only by the removed fallback.
  - search P30 "floats money": an older session ranks first.
- **Unseen 1:**
  - delivery Q12: silent. It shares one word with the note.
  - search Q05: silent. The config note shares one word of three.
- **Unseen 2:**
  - **delivery R01, R02 and search R01, R02, R09: no test-command note exists.** In `PASSED` (`src/compact/memory.ts`), the `FAILED` alternative is case-insensitive, so the "0 failed" in cargo's passing summary (`test result: ok. 18 passed; 0 failed; …`) counts as a failure. No cargo run is ever saved as the project's test command. Jest-style "Tests: 12 passed, 0 failed" is read the same way. The bug predates this gate; the earlier sets never printed "0 failed".
  - **delivery R07 ("How should errors be handled in new code?") and R12 ("Fix the changelog entry for the retry fix."): silent.** Each shares one word with its note, under the two-word rule.
  - **Not exercised:** the rustfmt trap, a tool reported missing that cargo runs. rustfmt is on this machine's PATH, so no note was saved. The harness doesn't control PATH, so this trap tested the machine, not Snout.

**Status.** Gate 3 does not pass: the main set passes, both unseen sets fail. Two causes remain:

1. `PASSED` misreads "0 failed". This is a correctness bug: a failing check for any runner that prints a zero failure count.
2. The two-word rule leaves single-word matches silent in delivery: Q12, R07, R12. It is the rule that keeps unanswerable prompts silent (21/21 across the sets). Loosening it is a precision-versus-recall choice for the owner, not a bug fix.

Each fix needs another frozen unseen set, written before the fix runs. The harness should also pin PATH so a scripted "missing" tool behaves the same on every machine.

**Reranker test, 2026-10-27: a local answerability reranker for search and recall, calibrated on the 12 seen sets, then one run on unseen 12.**

Owner's terms: focus on passing Gate 3 on the current build; measure whether the right answer is in the top 5, 10 and 20 candidates; compare a small local answerability reranker with today's ranking offline, with an explicit "none fits"; scope, verification, evidence and freshness stay hard filters; no model in a hook; freeze a new set before the final run. Gate 3 passes only at the 90% bar with no new wrong, stale, unsupported or cross-project notes, acceptable latency and a working no-model fallback, with Gate 2 and verify rerun on the same build. No paid Gate 4 sessions without the owner's approval.

**Unseen 12 was frozen first** (`bench/recall-gate/unseen12/`, 2026-10-27 18:31 UTC), before any reranker code, download or calibration. It is a Python tool-lending library API tested with pytest through uv: 16 sessions, 5 notes added by hand, 1 MCP save, 48 prompts (18 delivery, 20 recall, 35 search; 11 with no answer, one of them sharing a word with a session that doesn't answer it). The scorer is unchanged (same hash as every earlier freeze).

**Candidates: is the right record there at all?** (`bench/memory-rerank.mjs`, 12 seen sets, 606 answerable path checks.) After the hard filters, the right record is among the records a path may show in 593 of 606. Where it sits:

| Path | Today's ranking, top 1 / 5 / 10 / 20 | Shared words | Shortlist (today's ranking, then shared words) |
|---|---|---|---|
| Delivery | 139 / 140 / 140 / 140 of 175 | 118 / 121 / 121 / 121 | 155 / 158 / 158 / 158 |
| Recall | 139 / 139 / 139 / 139 of 143 | 137 / 142 / 142 / 142 | 142 / 142 / 142 / 142 |
| Search | 271 / 280 / 280 / 281 of 288 | 238 / 255 / 255 / 255 | 273 / 284 / 285 / 286 |

A 10-record shortlist holds the right record in 585 of 606. Most delivery checks it misses share no word with the right note, or are answered by the left-off text rather than a note.

**Two local cross-encoders, offline.** Both run through the runtime the optional memory model already uses, on this Windows machine's CPU (q8):

| Model | Download | Load | Per question, 10 candidates | Every record (about 40) | Process memory |
|---|---|---|---|---|---|
| ms-marco MiniLM-L6 | 23 MB | 107 ms | 13 ms median | 19 ms median, 30 ms p95 | 258 MB (364 MB scoring every record) |
| bge-reranker-base | 279 MB | 645 ms | 79 ms median | 136 ms median, 259 ms p95 | 952 MB (1,144 MB) |

- **On their own, neither beats today's ranking.** Showing the best-scoring record above a fixed probability, search gets at most 256/288 (MiniLM) and 269/288 (bge) against 271 today, and recall and delivery fall further.
- **Why:** they were trained on whether a passage answers a question. On a task prompt ("Add logging to the payment webhook") the right note (use the project's logger) ranks first among all records, yet scores near zero: related, not an answer. Their order is useful; a fixed probability is not a "none fits" test.
- **What does separate an answer from nothing is the gap to the next record.** With nothing from today's ranking, the best record's lead over the second (in logits) has a median of 4.4 when it is the right answer and is at most 1.1 on 90% of unanswerable prompts (MiniLM).

**The rule, fixed from the seen sets before unseen 12 ran** (`src/memory/rerank.ts`):
1. The shortlist is today's ranking, then records sharing a word with the question: 10 records, all past the hard filters.
2. **Override:** if the reranker gives a record p ≥ 0.9 and a lead of at least 4 over the next record, that record goes first.
3. **Keep:** otherwise today's ranking stands when it found anything.
4. **Fill:** when today's ranking found nothing, a record with a score of at least −4 and a lead of at least 3 is shown alone.
5. **None:** otherwise nothing is shown.
6. The lead is measured against the next record or −10 (an unrelated record's typical score), whichever is higher, so a lone candidate earns no lead by having no rival.

On the 12 seen sets this rule, with MiniLM, turns 13 path checks right and none wrong: delivery 152 → 157 of 175, recall 139 → 141 of 143, search 271 → 277 of 288. No record is shown on any of the 306 unanswerable path checks that wasn't shown before. The result is the same at shortlist sizes 5 to 1,000, and for p 0.9 to 0.99. bge-reranker-base does no better (+15, −0 at its best setting) at 12 times the size and 7 times the time, so MiniLM is the reranker. Delivery stays below 90% on 6 of the 12 sets even offline with the reranker.

**How it ships.**
- Opt-in: `snout memory reranker install` downloads MiniLM (23 MB) beside the optional memory model's runtime. Once installed, `snout recall` and `snout_memory_search` use it, unless `memoryRerank` is false or `SNOUT_MEMORY_RERANK=0`.
- The prompt hooks never load it; delivery is words only, and off by default.
- Without the model (not installed, failed to load), search and recall are exactly today's.

**Limits set before the unseen 12 run.**
- Accuracy: the existing Gate 3 criteria, per path, on unseen 12, unchanged.
- Latency, on this Windows machine: `snout recall` and a search through a new MCP server process (the gate starts one per call, a cold start) at most 2,000 ms at p95 with the reranker. The reranker's own scoring at most 100 ms median for a 10-record shortlist. Delivery is not affected: no model in a hook.
- Fallback: with the reranker switched on but no model present, all outputs equal today's on every set.
- Mac latency is not measured here; it is a stated gap.

**Through the real gate on the 12 seen sets** (bundle `dist/snout.mjs` sha256 `c25ba5ca…`, `results-rr.json` and `results-rr-nomodel.json` in each set, compared with `bench/recall-gate-diff.mjs`):
- **Reranker on:** search 371 → 377 and recall 240 → 242 answered first, of the scored checks across the 12 sets; 0 lost; no stale, unsupported, uncited or other-folder fact; silence unchanged. These are the same 8 search and recall fixes the offline rule predicted. Delivery is unchanged, as it should be: no model in a hook.
- **Model absent** (`SNOUT_MEMORY_RERANK=1` with an empty model folder): 1,258 of 1,260 outputs identical to the release candidate, and the same score on every check. The 2 that differ (unseen 6 Y19, delivery and search) are two equally ranked preferences in the other order; that tie is broken by save time, which varies between runs, and is not the reranker's.
- **A trade-off seen in the outputs:** in 5 searches (unseen 6 Y03, unseen 7 Z31, unseen 8 A05, A06, R04) the reranker put a session record ahead of a verified note that says the same thing. Both are accepted answers and the note is still shown second, but today's ranking puts the verified note first on purpose. Keeping the note first would also undo 2 real fixes (unseen 9 Q12, unseen 11 Q13, where the note on top was the wrong one), and the reranker's scores don't tell the two cases apart, so the rule stayed as fixed above.

**Unseen 12, run once per arm, 2026-10-27** (same bundle; `bench/recall-gate/unseen12/results-rr.json`, `results-rr-nomodel.json`, and offline `rerank-offline.json`):

| Criterion | Reranker | No model (today) |
|---|---|---|
| Delivery, right first | 15/18, fail | 15/18, fail |
| Recall, right first | 19/20 | 19/20 |
| Search, right first | 34/35 | 33/35 |
| Silent on unanswerable prompts | delivery 11/11, recall 10/11, search 11/11 | 11/11 on every path |
| Stale, unsupported, uncited, other-folder facts | none | none |
| Same delivery for Claude Code and Codex | 48/48 | 48/48 |
| Time per call, median / p95 | recall 314 / 343 ms, search 447 / 470 ms, delivery 177 / 184 ms | recall 103 / 109 ms, search 154 / 166 ms, delivery 173 / 183 ms |

- **Delivery fails** on unseen 12 (D12 "Print a barcode label for a new drill", D20 "Refund a member's deposit", D21 "Text the member when their loan is overdue"): each right note shares one word or none with the prompt. Scored offline with the reranker it would be 16/18, still under 90%.
- **The reranker added one wrong record.** On S03, "Set up Dependabot for the Python packages", recall showed the session that moved the tests to uv because the system Python lacked dependencies. Today's recall found nothing; that session was the only one sharing a word ("Python"), and the reranker scored it clearly ahead of nothing, so the fill rule showed it. Silence stays at 10/11, above the frozen criterion, but the owner's condition was no new wrong notes, and this is one.
- **Its gain on unseen 12** is one search (Q12 "postgresql version", which today's search left silent).
- **Missed by both arms:** Q01 "When did the tests switch to uv?" in recall and search. Two-letter words like "uv" are not search words, and the session record that answers it shares only "tests" with the question.

**Verdict: Gate 3 is not passed on this build.** Delivery is under 90% with or without the reranker, and the reranker added a wrong recall result that today's ranking doesn't show. Search and recall meet the bar on unseen 12 in both arms; without the reranker, with nothing new shown.

**Latency, memory and fallback** (this Windows machine, Node 24, CPU):
- Per call, through a new process each time as the gate runs them: recall 311 ms median (336 p95) with the reranker against 106 ms; search 453 ms (484 p95) against 164 ms; over the 12 seen sets. All within the 2,000 ms limit set before the run.
- The reranker's own scoring: 13 ms median for a 10-record shortlist; the model loads in about 110 ms once the runtime is imported.
- Peak memory of one `snout recall`: 150 MB with the reranker, 56 MB without.
- Mac: not measured.
- Without the model, every output is today's (above).

**Gate 2 and verify on this bundle** (`c25ba5ca…`):
- Gate 2: pass, 12 of 12 checks (`bench/fresh-install/results-rerank.json`).
- `npm run verify` from PowerShell exited 0: typecheck clean; build unchanged (same sha256); check:bench 43 entry points; check:claims 0 missing; tests 449 passed, 0 failed; eval 71 cases; bench PASS, plugin overhead 23.9 ms median (limit 75 ms).

**What this supports.** The reranker can pick the answering record from a shortlist where word rules can't (8 more on the seen sets, 1 on unseen 12, none lost). Its fill step can't tell "related" from "answers" when only one record is related, and that is where the new wrong result came from. Delivery's misses are mostly notes that share no word with the task, which a 10-record shortlist built from words cannot reach.

**On-demand gate passed, 2026-10-28: unseen 16 (mixed-language), run once on bundle `46789477…`: found 33/35, silent 11/11, no uncited or out-of-date fact.**

Owner's terms: no new retrieval feature. Make the citation check recognize a verified passing test run for Go and the other runners, from the stored record rather than one text pattern, with passing and failing Go cases. Freeze that rule, then run one new mixed-language set once at the same thresholds. Gate 2 and verify on the exact build. Owner's decision before the set: in a project with several languages, fix test-command capture first.

**Citation rule** (`bench/ondemand-gate.mjs`, `bench/test-verdict.mjs`; frozen 2026-10-28 before unseen 16 was written, earlier freezes kept in `ondemand-freeze.json`). Every line search shows is checked by the gate itself, no longer by Gate 3's per-runner text pattern. A test-command note is traced to its record:
- the stored note says this command;
- the line quotes the stored evidence, with the note's agent and date;
- the command is the run's own, apart from narrowed selections such as `<packages>`;
- in the set's own history, the source session ran that command and printed that result;
- the run passed by the gate's own reader. That reader is written apart from Snout's parser and reads each runner's success and failure lines over the whole output (go, cargo, deno, node, tox, pytest, unittest, rspec, phpunit, mocha, vitest and jest).

The hooks don't record exit status, so the whole output stands in for it. On the 15 seen sets and unseen 15 the rule accepts every test-command citation. Four forged lines are refused, each for its own reason: a wrong quote, another agent, another command, and an id with no record. One gap was found on the seen sets and fixed before the freeze: a result kept from two lines ("14 passed · py312: OK") is checked line by line. Tests: `test/test-verdict.test.mjs` covers a passing Go run, and Go failing on a failed test, a build failure, a panic and a failure above an `ok` line, plus each other runner passing and failing.

**Capture fix: one current test command per folder and toolchain** (`src/memory/distill.ts` `testPlace`, `sameTestPlace`; `facts.ts` `factKey`). A passing test command used to replace the project's one test command, so in a project with several languages `cd api && …pytest` and `cd web && pnpm vitest run` replaced each other. Now a command replaces only one in the same folder and the same toolchain; an unknown runner, such as `make test`, matches any toolchain in its folder. `npm test` → `npx vitest run` and `pytest` → `tox` still replace. Test: `test/gate3.test.mjs`, "mixed-language project". On the 15 seen sets nothing changed (`results-tp.json`: no answer changed on any path; unseen 15 passes).

**Unseen 16** (frozen 2026-10-28 03:41 UTC, written after the rule and the capture fix were settled and before it was run). It is a bike-share monorepo: a Python API (pytest through uv), a TypeScript web app (vitest through pnpm) and a Go dispatcher (`go test`). Three test commands are current at once. It has 48 prompts: 35 searches with an answer and 11 without. Run once (`bench/recall-gate/unseen16/results-od.json`, `ondemand-od.json`):

| Criterion | Result |
|---|---|
| Found, right record among the first five | **33/35 (94%)** |
| Silent on unanswerable searches | **11/11** |
| No stale, unsupported, uncited or other-folder fact | **none** |
| Fetch: every record shown opens, with its source | 25 records |
| Token budget | median 128, max 323 |

The two misses are neither "below fifth" nor "filtered": both link only by meaning. D08 "multiple bikes per account" against "at most one bike", and Q04 "long rides" against "over 45 minutes". Gate 3's older report on the same run still shows its own first-line measure (28/35) and flags the Go note under its "N passed" pattern. Neither is a criterion of this gate.

**Gate 2 and verify on this bundle** (`46789477…`): Gate 2 passes, 12 of 12 (`bench/fresh-install/results-unseen16.json`). `npm run verify` exited 0: tests 463/463, eval 71 cases, bench PASS (24.3 ms overhead). Mac was not run.

**Verdict: the on-demand gate passes on a fresh, mixed-language set.** By the owner's terms, the next step is a small real Claude Code and Codex pilot comparing Snout on and off (`.snout/notes/pilot-proposal-2026-10-28.md`), with its size and cost approved first.

**On-demand gate, second round, 2026-10-28: unseen 15 finds 35/35 and stays silent 11/11, but fails "current" on the frozen citation rule for Go.**

Owner's terms: keep automatic injection off; fix the plural bug; for each remaining miss, say whether the right record was absent from the candidates or ranked below fifth; no broad one-word matching; settle a general rule for equivalent sourced answers before scoring again; regression tests; freeze a new set and run it once; then Gate 2 and verify on the same build, and a pilot proposal. No commit or push.

**Fixes** (all general; `src/memory/retrieve.ts`, `src/memory/tools.ts`):
1. **Word forms.** "-es" after s, x, z, ch or sh now gives both forms: "sizes" meets "size", "cases" "case", "caches" "cache", and "boxes" still meets "box". It changes the forms the local index stores, so its schema went from 2 to 3 and every index rebuilds once.
2. **The successor of an out-of-date note.** A note held back because its file changed since is still never shown. When it matches a search strongly, the newest session that changed that file after it, and shares a word with the search outside its paths, gets the note's score. It ranks as a session, never ahead of a current note. A first version also gave it a note's priority and took any later session that touched the file; on the older sets that put an unrelated session first on unseen 6 Y23 and Y32, and a threshold change above the current PagerDuty note on unseen 11 D09. It was narrowed before unseen 15 was written.
3. **Task tie-break.** At equal score, a session whose own task names a word of the search ranks before one that matched only in its test command, outcome or paths.

**The remaining misses, after the plural fix** (`bench/ondemand-diagnose.mjs`, `bench/recall-gate/ondemand-diagnose-pl.json`; 12 across the 15 earlier sets):
- **Not a candidate, 10:** the right record is showable but shares no word with the search, or one word in a search of three. Each links only by meaning: "limit" and "at most" (unseen 7 Z12, unseen 13 D07, D08), "rental" and "rent" (unseen 14 D08), "permissions" and "access" (unseen 14 Q01), "credentials" (unseen 5 X06), "page on-call" (unseen 11 D21), "config file location" (unseen Q05), "photo metadata" (unseen 7 Z39), "synchronous emails" (unseen 8 R15). Left as they are: matching them needs synonyms or one-word matches, which the owner ruled out.
- **Below fifth, 2:** unseen 14 D19 "plot rent", 9th of 9, and unseen 11 Q01 "all features", 11th of 11. Fixes 2 and 3 bring them to 4th and 2nd.
- **Not captured or filtered:** none.

**"Test permissions" (unseen 14 Q01) reviewed.** The first result is the test-command note, `deno test --allow-env --allow-read`. The question is when, and why, the tests began to need env and file access. The note gives the flags, but neither when nor why; the session that added them ("the config loader needs env and file access") gives both. So the note is not an equivalent answer, and Q01 stays a miss. The earlier report, which said the note "holds the answer", was wrong.

**Equivalent sourced answers** (scorer amended and frozen again on 2026-10-28 02:11 UTC, before unseen 15 was written; the earlier freeze stays on record in `ondemand-freeze.json`). A set may list, for a search, other facts that answer the same question (`searchAlso`), written with the set before any run. Each must answer the question as asked (the same what, when or why), must be a current fact of the set (the scorer refuses any other), and must be shown on a cited line. Sets without it score as before.

**On the 15 earlier sets** (`results-sr2.json`, against the plural fix alone, `results-pl.json`): found in the first five went up by 2 (unseen 11 Q01, unseen 14 D19); silence is unchanged; there are no new bad facts, and fetch and budget pass everywhere. On Gate 3's first-line measure: unseen 10 Q15 is gained, and unseen 14 Q15 lost (the right session is now second, behind one whose task says "rented"). The plural fix alone added unseen 14 D05 and D06.

**Unseen 15** (frozen 2026-10-28 02:38 UTC, written after the code above was settled and before it was run; a Go ferry-ticketing service; 48 prompts, 35 searches with an answer, 11 without; one `searchAlso`). Run once on bundle `0a5f9478…` (`bench/recall-gate/unseen15/results-od.json`, `ondemand-od.json`):

| Criterion | Result |
|---|---|
| Found, right record among the first five | 35/35 |
| Silent on unanswerable searches | 11/11 |
| No stale, unsupported, uncited or other-folder fact | **fail: 5 lines "uncited"** |
| Fetch: every record shown opens, with its source | 24 records |
| Token budget | median 149, max 306 |
| Time per search call | about 160 ms |

All five "uncited" lines are the same note, `Run the tests with: go test -race ./...  (seen in a passing test run: "go test -race ./... → ok ferrylog/internal/fares 0.103s"; codex, 2026-10-28)`. The frozen Gate 3 scorer (`bench/recall-gate.mjs`, `cited`) accepts a test-command note only if its evidence contains a count ("N passed"), and `go test` prints `ok <package> <time>`, never a count. This is the first Go set. The note is backed by a passing run, a command, an agent and a date. Even so, under the rules frozen before the run it is a fail, and it is not re-scored. The `searchAlso` entry (D12) changed nothing: the note that answers it directly came second.

**Gate 2 and verify on this bundle** (`0a5f9478…`): Gate 2 passes, 12 of 12 (`bench/fresh-install/results-unseen15.json`). `npm run verify` exited 0: tests 459/459, eval 71 cases, bench PASS (24.1 ms overhead). Mac was not run.

**Verdict:** found and silence clear the bar on a fresh set, but the gate as frozen fails on citation. Whether a Go pass verdict (`ok <package> <time>`) counts as a citation is the owner's call. If it does, the scorer change needs its own freeze and a new set run once.

**On-demand gate, 2026-10-27: product scope locked, live smoke passed, unseen 14 fails at 30/35.**

Owner's terms: keep automatic injection off; make local, source-backed search and fetch the memory feature; one real Claude Code and one real Codex session with the two tools; fix the five unseen 13 searches that returned nothing relevant without tuning to unseen 13; freeze a new set and test the on-demand gate; the paired pilot only after the gate and the smoke pass, with its size and cost approved first; then the release build.

**Scope, as built:**
- Nothing from memory enters a prompt by default.
- Claude Code (through the plugin's `mcpServers`) and Codex (`snout init codex`) get `snout_memory_search` and `snout_memory_fetch` only.
- `snout mcp` with no `--tools` offers read, search, fetch, save, classify and audit. The whole-memory index is out of the default; save stays, for what a user asks to remember, and the frozen Gate 3 harness depends on it.

**Live smoke** (`bench/memory-smoke.mjs`): the past record is a decision found only in an earlier session's record, kept outside the project folder, so the tools are the only way to it. Search shows the decision's headline; the times are only in the record itself.

| Agent | Result | Memory calls | Cost |
|---|---|---|---|
| Claude Code 2.1.306, Sonnet 5.5 | pass | 2 empty calls before it loaded the tool's schema, then one search and one fetch; it cited the record in its answer | $0.056 |
| Codex 0.163.0, gpt-6.1-sol | pass | one search, one fetch; Codex took the server from `-c` and ran the tools without approval prompts | on plan |

Both returned exactly the agreed times (`bench/ab-results/memory-smoke-claude-1793139399899.json`, `memory-smoke-codex-1793139470323.json`).

**The scorer** (`bench/ondemand-gate.mjs`, frozen 2026-10-27 22:20 UTC before any fix, `bench/recall-gate/ondemand-freeze.json`). Per set:
- **found:** the right record among the first five shown, on at least 90% of searches that have an answer;
- **silent:** nothing shown on at least 90% of searches that have none;
- **current:** no stale, unsupported, uncited or other-folder fact;
- **fetch:** every record shown opens, says where it came from, and states an out-of-date claim only as out of date;
- **budget:** search output at most 250 tokens at the median and 600 at most.

**Unseen 14 was frozen before the fixes** (2026-10-27 22:19 UTC): a Deno community-garden API, 48 prompts, 35 searches with an answer, 11 without.

**Fixes** (`src/memory/tools.ts`), all general:
1. **Fetch** showed a session's task and outcome with an out-of-date claim still in them, flagged only on a separate line. It now leaves the claim out of them, as search does, and names it as out of date. The frozen scorer caught this on 6 of the older sets.
2. **A one- or two-word search also shows a session record that shares one word,** when no other record uses that word and it is in what that session set out to do. Words inside paths don't count. This fixes searches like "redis version" or "cancellation window", where the answer is one session's own topic.

   A looser first version (two records, any field) put records on 8 unanswerable searches and was narrowed before the unseen 14 run.

**On the 14 earlier sets** (`results-od3.json`, against today):
- 5 more right records in the top five, and search answered first went from 455 to 458; no bad or uncited fact; fetch passes on every set.
- Two unanswerable searches now show a related session: unseen 2 R14 "windows installer" and unseen 9 S03 "release workflow". Unseen 2, with 5 such searches, falls to 4 of 5. Unseen 3 fails on V14, which today's build already shows.
- Unseen 13: 33 of 35. The two left (D07, D08) link "limit" to "at most" only by meaning.

**Unseen 14, run once** (bundle `126f8315…`, `bench/recall-gate/unseen14/results-od.json`, `ondemand-od.json`): **fail.**

| Criterion | Result |
|---|---|
| Found, right record among the first five | 30/35, fail |
| Silent on unanswerable searches | 11/11 |
| No stale, unsupported, uncited or other-folder facts | none |
| Fetch: every record shown opens, with its source | 24 records |
| Token budget | median 121, max 325 |
| Time per search call | 173 ms median, 186 ms p95 |

The five misses:
- **D05 "plot size units", D06 "plot size display":** a word-form bug. The plural rule turns "sizes" into "siz", never "size", so the note "Plot sizes are stored in square metres…" shares one word, not two. The same bug splits "cases" from "case" and "prizes" from "prize". It is general, but it was found on unseen 14, so fixing it and rerunning unseen 14 would not count.
- **D08 "rental limit":** "rental" doesn't meet "rent", and "limit" means "at most".
- **D19 "plot rent":** the 45-euro session says "rent" only in its commit subject and a path, and five records sharing both words fill the list.
- **Q01 "test permissions":** the first result is the test-command note with the permission flags themselves; the frozen expectation names only the session.

**Gate 2 and verify on this bundle** (`126f8315…`):
- **Gate 2:** pass, 12 of 12 checks (`bench/fresh-install/results-ondemand.json`).
- **Package:** `npm pack` (`usesnout-0.3.2.tgz`) holds the same `dist/snout.mjs` and `dist/lib.mjs` as the tested tree, and the plugin manifest's two-tool server starts from the unpacked package.
- **Verify:** `npm run verify` exited 0. Tests 456/456, check:bench 46, check:claims 0 missing, eval 71 cases, bench PASS (23.5 ms overhead).
- Two tests were updated because their expected behavior changed: the round 9 fetch test, and a reranker test whose "silent" query is now a topic match.
- Mac was not run.

**Verdict:** the on-demand gate is not passed on a fresh set, so, by the owner's terms, the paired pilot does not start.

**Direction, 2026-10-27 (owner): memory the agent asks for, not notes pushed into prompts.** Snout offers a few current, cited records through local search, and the coding agent decides what helps its task. The automatic choice that kept failing Gate 3 is no longer the product's path: automatic notes stay off by default, and the next question is Gate 4's, whether agents using search solve the same work with fewer total tokens.
- **What a session gets without asking:** nothing from memory. Session start adds no memory text; prompt notes appear only with `memoryNotes` on.
- **What search offers:** at most 5 records (`snout_memory_search`, default limit), only verified notes whose files haven't changed and session records with out-of-date claims removed, each line citing its record (a note's source and date; a session's agent and date). `snout mcp --tools snout_memory_search,snout_memory_fetch` offers only those two tools, with instructions to use what helps and ignore the rest (`test/mcp.test.mjs`).
- **Gate 3 for this design** would score the set search shows, not the first line: the right record among the 5 shown, silence on prompts with no answer, and no stale, unsupported, uncited or other-folder fact. On the 14 sets already run (all seen now, so for reference only, not a pass): right record among the 5 shown in 344 of 358 search checks, first in 332; silent on 123 of 124; no bad or uncited fact. Unseen 13 alone is under 90% (30 of 35): its misses return nothing relevant at all. A pass on this criterion needs the owner's approval of it and a newly frozen set.
- **Study harness:** a `search` arm in `bench/memory-study.mjs` (see `docs/benchmark-protocol.md`, amendment of 2026-10-27). Free stand-in runs for both agents passed on the vite check tasks: the server preflight, hook coverage (12 of 12 tool calls for Claude Code), no notes in either arm, no side calls. The stand-in calls no tools, so whether real agents call search, and whether Codex accepts the server from `-c`, is for the one-session smoke.

**Judge test, 2026-10-27: every eligible note judged for delivery; the reranker's fill rule removed.**

Owner's terms: freeze unseen 13; remove the "fill" rule; test all eligible notes offline with both proposed judges (embedding similarity, and a small local instruction model); report separately whether the right note was available, whether the judge chose it, and whether it chose "none" correctly; test meaning-based candidate generation only if limiting the candidates demonstrably causes misses; lock one design on the older sets; run unseen 13 once, only if that design meets the preset safety and latency criteria; then Gate 2 and verify on the exact bundle. Defaults unchanged; no commit, push or paid sessions.

**Unseen 13 was frozen first** (`bench/recall-gate/unseen13/`, 2026-10-27 20:45 UTC), before any change in this round. It is a TypeScript veterinary-clinic scheduler tested with vitest through pnpm: 16 sessions, 5 notes added by hand, 1 MCP save, 48 prompts (18 scored for delivery, 20 for recall, 35 for search; 11 with no answer, two of which share a word with a session that doesn't answer them). The scorer is unchanged.

**Fill removed** (`src/memory/rerank.ts`). The reranker now acts only when today's ranking shows something, and then only to put first a shortlisted record it is sure of. When today's ranking finds nothing, nothing is shown. This is stricter than dropping the fill step alone: a sure record over an empty result is no longer shown either.

**Preset criteria, written before any judge was run.** The older sets are the 12 earlier sets plus unseen 12 (13 sets). "Today" is the release candidate's ranking, words only.
- **Design under test, delivery:** today's rules stay as they are; the judge reads every eligible note (admitted to this viewer, verified, not held back, not already said by the prompt) and may add a note it accepts. With no accepted note, nothing is added.
- **Safety, all required:**
  1. On no unanswerable path check does the design show a record where today shows nothing.
  2. No path check that today gets right is lost.
  3. No stale, unsupported, uncited or other-folder fact, confirmed through the real gate on the older sets.
  4. With the model absent, every output equals today's.
- **Latency, on this Windows machine, all required:**
  1. Delivery: the judge adds at most 300 ms at p95 to a prompt when its model is warm in `snout serve`, and the prompt falls back to words when it isn't.
  2. Delivery end to end in the gate at most 1,000 ms at p95.
  3. Search and recall at most 2,000 ms at p95 per call, in a new process.
  4. Peak memory of the process holding the judge at most 1,000 MB.
  - Mac is not measurable on this machine; it is reported as unmeasured.
- **Choice among designs that meet both:** most right delivery checks on the older sets; ties go to fewer notes shown.
- **If no design meets them:** unseen 13 is not run, and the result is reported as such.

**Offline, every eligible note, both judges** (`bench/memory-judge.mjs`; 13 older sets; 306 delivery checks, 193 answerable and 113 unanswerable; median 8 eligible notes per prompt). Today: 168/193 right first, 113/113 silent.

| | Embedding judge (bge-small) | Instruction-model judge (Qwen2.5-0.5B-Instruct, q8) |
|---|---|---|
| Right note available (eligible, or today's left-off text answers) | 192/193 | 192/193 |
| Judge alone puts the right note first, at its loosest setting | 173/193 | 41/193 |
| Judge says "none" on every unanswerable prompt | from 0.65 up | at no setting that keeps any answer |
| Best design meeting the safety criteria | 0.65: 174/193 right first (+6), 0 lost, 0 newly shown | none: every setting that gains shows notes on unanswerable prompts |
| Time per prompt, 8 notes | 3 ms median, 5 ms p95 (note vectors cached) | 1,029 ms median, 1,742 ms p95 |
| Process memory | 202 MB | 2,129 MB |

- **Availability is not the problem.** The right note is eligible in 192 of 193; so meaning-based candidate generation was not tested, as the owner set.
- **The embedding judge orders well and separates poorly.** Shown wherever today shows nothing, its best note is right in 188 of 193 answerable checks, but at that setting every unanswerable prompt gets a note too. From 0.65 up no unanswerable prompt gets one; at 0.61, four do. A margin over the second-best note added nothing at any setting.
- **The instruction model fails on accuracy, latency and memory.** It is dropped.
- **Locked design** (`src/memory/facts.ts`, `NOTE_MEANING = 0.65`): delivery keeps today's rules; with `memorySemantic` and the model, when no note fits on its rules and the prompt gets no left-off text, the single verified note closest in meaning is given at a similarity of 0.65 or more. 0.64 also passed offline (+7) but sits on the edge; 0.65 keeps a step from it. Search and recall don't use meaning at all (they did before, with `memorySemantic`); they are today's ranking, with the reranker's override when it is installed and today's ranking shows something. Even so, 7 of the 13 older sets stay under 90% for delivery offline (unseen 10 17/19, unseen 11 15/18, unseen 12 16/18 among them), so a pass on unseen 13 is not expected; the owner's terms run it if the safety and latency criteria hold.
- **Serve with the embedding model** (this Windows machine): 208 MB peak; a prompt and a note embedded in 5 ms median, 24 ms max.

**The locked design through the real gate on the 13 older sets** (bundle `dist/snout.mjs` sha256 `74ab7f18…`; the frozen scorer's semantic arm with notes on, `results-judge.json`; model absent, `results-judge-nomodel.json`; both against today, `results-rr-nomodel.json`):
- **Safety criteria met.** Delivery 281 → 286 and search 415 → 419 answered first, recall unchanged; 0 lost; nothing newly shown on any unanswerable check; no stale, unsupported, uncited or other-folder fact. Model absent: 1,404 of 1,404 outputs the same as today.
- **Latency criteria met.** Delivery 258 to 270 ms median and at most 330 ms at p95 per set, against 183 / 207 ms today: the judge adds about 80 ms at the median and 100 ms at p95. Search and recall at most 550 ms at p95. Peak memory: serve 208 MB, a `snout recall` with the reranker 150 MB.
- **unseen 10 D12** gained offline but not here: its note scores 0.652 in the bench and just under 0.65 through `snout serve`.
- **What the criteria did not cover.** On 10 prompts the gate leaves unscored ("any"), the design now adds a note where today adds none, and about 7 of them don't fit the task. Examples: "How did we fix rotated thumbnails?" got the thumbnail-size decision; "Why did deleted photos show up in albums?" got the S3 storage path. They fit on "Why didn't ngrok start?" (ngrok not installed) and "Check coverage with c8." (the c8 test command). The preset safety criteria counted only scored unanswerable prompts, so this was not a stop condition; it is the same "related, not an answer" failure.

**Unseen 13, run once per arm, 2026-10-27** (same bundle; `bench/recall-gate/unseen13/results-judge.json`, `results-judge-nomodel.json`, offline `judge-offline.json`):

| Criterion | Locked design | Model absent (today) |
|---|---|---|
| Delivery, right first | 16/18, fail | 16/18, fail |
| Recall, right first | 18/20 | 18/20 |
| Search, right first | 29/35, fail | 29/35, fail |
| Silent on unanswerable prompts | 11/11 on every path | 11/11 on every path |
| Stale, unsupported, uncited, other-folder facts | none | none |
| Same delivery for Claude Code and Codex | 48/48 | 48/48 |
| Time per call, median / p95 | delivery 258 / 268 ms, recall 214 / 354 ms, search 458 / 489 ms | delivery 178 / 197 ms, recall 106 / 116 ms, search 160 / 176 ms |

- **The judge changed no scored result on unseen 13.** Its one added note is on an unscored prompt (Q10, the daylight-saving bug, got the UTC note), which is related and plausibly useful.
- **The two delivery misses:** D08 "Let Dr. Okafor take 15 appointments on Saturdays" (the 12-patients note shares no word; its similarity is 0.50, third among the notes) and D12 "Chart a puppy's growth over its first year" (the grams note is closest, at 0.56, under 0.65).
- **The six search misses** (D07 "vet daily limit", D08 "vet appointment limit", D19 "cancellation window", Q01 "forks pool", Q12 "redis version", Q15 "cancellation policy") are word-search misses where today's search shows nothing or the wrong record and the reranker, which now only reorders, has nothing to act on.

**Delivery, broken down as the owner asked** (embedding judge at 0.65):

| | 13 older sets | Unseen 13 |
|---|---|---|
| Right note available | 192/193 | 18/18 |
| The judge ranks the right note first among all eligible notes | 173/193 | 16/18 |
| The judge accepts it (0.65 or more) and puts it first | 125/193 | 11/18 |
| The judge accepts nothing on an unanswerable prompt | 113/113 | 11/11 |

The instruction-model judge ranks the right note first in 41 of 193.

**Gate 2 and verify on this bundle** (`74ab7f18…`): Gate 2 passes 12 of 12 checks (`bench/fresh-install/results-judge.json`); `npm run verify` from PowerShell exited 0 (typecheck clean; build unchanged; check:bench 44 entry points; check:claims 0 missing; tests 452 passed, 0 failed; eval 71 cases; bench PASS, overhead 24.6 ms median). Mac latency and memory: not measured.

**Verdict: Gate 3 is not passed.** On unseen 13, delivery is 16/18 and search 29/35 with and without the judge. The judge is safe on the scored criteria and fast, but on fresh prompts the right note is often not close enough in meaning to clear a threshold that also keeps unanswerable prompts silent, and below that threshold it adds related-but-wrong notes.

**After Gate 3 closed, 2026-10-27: one search design tried and reverted; automatic notes made opt-in.**

The owner stopped the fix-and-new-set cycle with unseen 11's failure as the result. The terms: analyze the existing misses; try one bounded design that keeps automatic notes strict and improves only explicit search; no prompt-specific synonyms or one-word exceptions; the 90% bar stays. If the design can't meet the bar, keep automatic memory off by default and prepare the index and on-demand recall as a narrower release.

**The misses.** 46 across the 12 sets, on the round 11 build. None showed a stale, unsupported, uncited or other-folder fact.

| Path | Nothing shown | Right answer shown, not first | Only a wrong (current) record shown | Spoke with no answer |
|---|---|---|---|---|
| Delivery (automatic) | 20 | 0 | 2 | 0 |
| Recall (asked) | 4 | 0 | 0 | 1 |
| Search (asked) | 4 | 10 | 4 | 1 |

- Delivery misses are almost all silence. The agent loses nothing it had; it just isn't helped.
- Search misses are mostly order: the right record is in the list, but not first.
- The causes: one shared word, a link only by meaning, tie order, the test-command rule taking a query that says "test", and stop-word forms. Each is a case where a record shares words with the question without answering it, or answers it in other words.

**The design: weighing for explicit search.**
1. Each query word is weighted by inverse document frequency over the project's notes and session records.
2. A record scores the share of the question's weight it covers; the test-command rule is credited only with the test words.
3. Ties go first to a record whose own folder, file or program the question names, then note before session, then phrase adjacency, then newest.

A first version also admitted a one-word match when that word was a proper name held by only one record. On the owner's instruction (no one-word exceptions) it was removed before being kept.

**Results** (`results-search1.json`, `results-search2.json`, against round 11):

| Version | Search, answer first, all sets | Fixed | Lost | Silence |
|---|---|---|---|---|
| With the one-source rule | 270/288 → 268/288 | 4 | 6 | broke on unseen 2 R14 |
| Weighing only | 270/288 → 267/288 | unseen 9 Q12, unseen 10 Q15, unseen 11 Q13 | main P04, P05; unseen Q03; unseen 2 R05; unseen 8 A23; unseen 10 D05 | unchanged |

Delivery and recall were unchanged. The design trades one right answer for another, so it was reverted; search is round 11's.

**Automatic notes are opt-in** (`memoryNotes`, `snout memory notes on`, or `SNOUT_MEMORY_NOTES=1`). In enforce mode, a prompt gets notes only with this on. Unchanged:
- notes are still saved and recorded as fitting (`recall.jsonl`);
- `snout_memory_search` and `snout recall` answer when asked;
- the gate measures delivery with `SNOUT_MEMORY_NOTES=1`, and the frozen harness passes the environment through.

**What we can claim, and what we can't.**
- **Can claim:**
  - Snout keeps each project's memory on the machine, in an index that never sits in the repository.
  - Search and recall find saved notes and session records when asked, and the index gives the same answers as reading the files: 10 sets, 972 outputs, identical.
  - At 2,000 sessions, search takes 52 ms instead of 627 ms.
  - Across 12 test sets and 912 scored prompt paths (606 with an answer, 306 without), no stale, unsupported, uncited or other-folder fact was shown, and on prompts with no answer it stayed silent in 304 of 306 (one recall and one search exception, both on early sets: unseen 4 W14 and unseen 3 V14).
- **Can't claim:**
  - that memory picks the right note first reliably: with words alone it is below the 90% bar on fresh sets (unseen 10, unseen 11);
  - that memory helps an agent finish work or saves tokens: that is unmeasured.

**Release candidate check.** These are the bundle's numbers from this point on: round 11's retrieval plus the opt-in switch, `dist/snout.mjs` sha256 `7d84964d61bef141…`.
- **Same answers:** all 12 sets run with `SNOUT_MEMORY_NOTES=1` (`results-rc.json`) give the same 1,260 outputs as round 11b and round 11, once dates and ids are set aside.
- **Gate 2:** pass, 12 of 12 checks (`bench/fresh-install/results-rc.json`). Enforce alone shows no note; with notes on, it shows the test command with its source.
- **Verify:** `npm run verify` from PowerShell exited 0. Each step:
  - typecheck clean;
  - build wrote `dist/snout.mjs` (844.7 KB);
  - check:bench: 40 entry points passed;
  - check:claims: 0 missing;
  - tests: 443, 443 passed, 0 failed;
  - eval: 71 cases ran;
  - bench: PASS, with plugin overhead 26.5 ms median (limit 75 ms).

**Where the misses fail: one diagnostic pass** (`bench/memory-diagnose.mjs --label rc`). It reads each set's replayed store and asks, for every miss, whether the right fact was captured, whether that record may be shown, whether it is in the top 20 candidates by shared words or by the optional local model's meaning, and whether it was chosen.

| Where it failed | Misses |
|---|---|
| Not captured | 0 |
| Captured, but filtered out (proposed, held back, replaced) | 0 |
| May be shown, but not a top-20 candidate | 0 |
| A top-20 candidate, not chosen | 44 (delivery 22, recall 4, search 18) |
| False injection on a prompt with no answer | 2 (unseen 3 V14, unseen 4 W14) |

- **Every answerable miss** was captured, could be shown, and was already a candidate.
- The local model's meaning ranking puts the right record first in 37 of the 44, and shared words do in 32, often with one shared word or none.
- So on these sets the failure is selection: deciding which candidate answers the question, and when none does. It is not capture or retrieval.
- These sets were written so that the facts exist. Capture on real projects is not measured by them.

**Study harness.** Since automatic notes became opt-in, the memory study's memory arm set `memory: true` but not `memoryNotes: true`, so it would have run trimming only under the memory label. Fixed:
- `bench/memory-study.mjs` sets `memoryNotes` by arm, and clears `SNOUT_MEMORY` and `SNOUT_MEMORY_NOTES` from the session environment so the arm's config governs;
- `armProblems` in `bench/study-checks.mjs` refuses a memory arm without notes, or another arm with them, before any session starts (test: `test/study-checks.test.mjs`);
- `bench/realrepo.mjs` sets `memoryNotes: true` beside `memory: true`.

**Final checks on this tree** (bundle `7d84964d…`):
- `npm run verify` exited 0. Each step:
  - typecheck clean;
  - check:bench: 41 entry points passed;
  - check:claims: 0 missing;
  - tests: 444, 444 passed, 0 failed;
  - eval: 71 cases ran;
  - bench: PASS, with plugin overhead 24.6 ms median.
- Gate 2: 12 of 12 checks pass (`bench/fresh-install/results-final.json`).

**Next, as the owner set it:** a local query–record answerability reranker (option A), tested first on explicit search, with delivery also scored offline in the same evaluation.
- It works on a short list of candidates and has an explicit "none answers" outcome.
- Project scope, evidence and freshness stay hard filters before it.
- Measured: answer accuracy, false matches, Windows CPU latency, memory use, and behavior when the model is absent.
- The model's ~280 MB download stays optional.
- It goes into no hook until it improves a fresh frozen set and meets a measured latency limit.
- Jev is only an opt-in offline comparison judge.

**Before a paid pilot (Gate 4):**
1. An answer-focused judge that tells "this record answers the question" from "this record is only related", including saying "none". It must pass a set frozen before it is tuned, at the same bar, with silence and freshness unchanged.
2. Gates 2 and 3 on the build with that judge, on a fresh set.
3. Then Gate 4: the same build users would install, and the owner approves the session count and cost first.

**Round 11, 2026-10-27: a bounded fix round on the SQLite build. Unseen 11, frozen before it, fails. Gate 3 is not passed on this build: the remaining misses are the words-only limits, and the safe behavior is kept.**

Owner's terms: keep the 90% bar; fix the general ranking and weak-match failures; run one newly frozen set; add nothing tailored to unseen 10 and generate no further sets. If the round still fails, report the words-only limitation rather than claim a pass. Gate 4 stays on hold.

Unseen 11 (`bench/recall-gate/unseen11/`, frozen 2026-10-27 15:07 UTC, before any of this round's code) is a Rust weather-station service tested with `cargo test`: 16 sessions, 5 notes added by hand, 1 MCP save, 48 prompts (18 delivery, 20 recall, 35 search, 11 with no answer).

Changes (`src/memory/retrieve.ts`, `tools.ts`, `memory.ts`, `facts.ts`), with regression tests in `test/gate3.test.mjs` ("round 11"):
- **A record's own names, in short questions.** In a question of one or two content words, a word that names one of a record's own folders or files (`src/waitlist/…` → "waitlist", a note's `migrations/` → "migration") or a tool it found missing ("ngrok") is strong evidence (`nameForms`, `namesTopic`). Structural names don't count (src, lib, tests, index), and neither does a word inside a path the question writes out, which the folder-aware path rule judges. Search uses it to admit a record, never to lift its rank.
- **Delivery never uses it.** The first draft also let it lift notes in delivery and in prompts of any length. On the seen sets that broke silence twice, with no stale or uncited facts: unseen 6 Y42 "money-back guarantee banner" got the `money.ts` note, and Y41 "Order the sidebar links" recalled the `orders.ts` session. It also cost search 1 to 2 answers on 7 sets. Results: `results-round11.json`, bundle `dcf25f0a…`. The rule was narrowed to the above.
- **Ranking ties.** Between records of the same kind at equal score, the one with two of the question's words side by side ("lane booking") comes before the newest. As a score bonus, the first draft put session records ahead of notes that answer fully ("Run the tests with: …" has "the" between the words).
- **Contractions.** "didn" and "isn" (what "didn't" and "isn't" leave) are stop words, so "Why didn't ngrok start?" has two content words, not three.
- **An updated assertion.** Round 3 asserted that search stays silent for "money representation" when two sessions changed `src/money.js`. It now answers with the newer of them ("Store money as decimal strings"), since the word names the file both changed. Its negative ("parser speed") is unchanged.

Seen sets on the final build (`results-round11b.json`, bundle `18cf0df3…`), against the same sets before the round: no answer and no silence lost on any path of any set, and 0 stale, unsupported, uncited or other-folder facts. Gained: main P28 search; unseen 10 Q13, Q14, Q15 recall (16/19 → 19/19) and Q16 search (33/36 → 34/36). Delivery is unchanged everywhere, unseen 10 included (16/19).

Unseen 11, run once on that build (`results-round11.json`):

| Criterion | Unseen 11 |
|---|---|
| Right, current answer first: delivery / recall / search | **15/18**, 19/20, **29/35** |
| Stale, unsupported, uncited or other-folder facts shown | 0 |
| Nothing shown on unanswerable prompts, all paths | 11/11 |
| Delivery tokens, median / max (budget 600) | 115 / 243 |
| Time per call, median: delivery / recall / search | 174 / 98 / 155 ms |
| Claude Code and Codex get the same delivery | 48/48 |
| Verdict | **fail** |

The misses, by kind:
- **One shared word, which delivery and search don't count:** delivery D06 "temperature", delivery D09 "alerts", search Q12 "timescaledb version".
- **A link only by meaning:** D21 "Page the on-call engineer…" against the PagerDuty note, in delivery and in search.
- **Tie order** (note before session, then newest): search D11 "station id format" ("id" has two letters, so it isn't a word, and "station" ties two notes); Q01 "all features" (the test-command note's `--all-features` ties the session that made the switch); Q15 "alert threshold" (the PagerDuty note ties the session that changed the threshold).
- **The test-command rule** wins a query that says "test": search Q13 "test reading publish".
- **Stop-word forms:** recall Q08 "Which session added humidity?": "added" counts in the prompt, but "add" is a stop word in the records, so only "humidity" matches.

**Verify.** `npm run verify`, run from PowerShell on 2026-10-27 on this round's tree (uncommitted), exited 0. Each step:
- typecheck clean;
- build wrote `dist/snout.mjs` (843.9 KB, sha256 `18cf0df3d75da2a9…`, the bundle every round-11b run and the unseen 11 run used);
- check:bench: 40 entry points passed;
- check:claims: 0 missing;
- tests: 443, 443 passed, 0 failed;
- eval: 71 cases ran;
- bench: PASS, with plugin overhead 24.5 ms median (limit 75 ms).

**Status: Gate 3 is not passed on the SQLite build.** With words alone, Snout answers at least nine in ten fresh prompts first only on some sets. The rest fail on one shared word, a link only by meaning, or tie order, and loosening those rules is what broke silence in this round's first draft. What holds on every set, seen and fresh: no stale, unsupported, uncited or other-folder fact is shown, and nothing is shown on prompts with no answer. Gate 4 stays on hold.

**SQLite index build, 2026-10-27: same answers as the files on every earlier set; unseen 10, run once, fails on one-word misses.**

The build (branch `claude/sqlite-index`) adds a local SQLite/FTS5 index (`src/memory/sqlite.ts`): one database per project, in the user's config folder. It holds a copy of the notes and session records, built from the JSON files on first read and kept current from them; the JSON files stay the record. Search looks up candidates in FTS5 first; the scorer in `retrieve.ts` is unchanged. Without node:sqlite (Node 20, or 22 before 22.13) or with `SNOUT_INDEX=off`, memory reads the files as before.

- **Verify.** `npm run verify`, run from PowerShell on 2026-10-27 on the tree as committed, exited 0. Each step:
  - typecheck clean;
  - build wrote `dist/snout.mjs` (841.6 KB, sha256 `06a0ce0bc1c1ce2f…`) and `dist/lib.mjs` (303.4 KB);
  - check:bench: 40 entry points passed;
  - check:claims: 5 results files cited, 0 missing;
  - tests: 441, 441 passed, 0 failed;
  - eval: 71 cases ran;
  - bench: PASS, with classification within 1 ms p95 and plugin overhead 24.2 ms median (limit 75 ms).
- **Same answers.** Every earlier set (main and unseen 1 to 9) was run with the index off and on (`results-sqlite-off.json`, `results-sqlite-on.json`). All 972 outputs (10 sets × 3 paths) match once dates, commit hashes and session ids are set aside, and so do the scores and verdicts. Unseen 9 scores as its recorded round-10b run: 18/19, 19/19, 33/35.
- **Cost at 2,000 sessions and 120 notes** (`bench/memory-index-scale.mjs`, Node 24.12, Windows, median). Search, in process: 627 ms without the index, 52 ms with it. A new session's first prompt (it looks for where the last session left off), the hook spawned as Claude Code runs it: 719 ms → 160 ms. A later prompt: 143 ms → 116 ms. The first read after an upgrade builds the index in about 1.1 s; the build commits every 200 files, so a hook stopped at its 5-second limit keeps its progress. Search answers matched both ways.
- **Unseen 10** (`bench/recall-gate/unseen10/`), written and frozen before any run on this build. It's a TypeScript pool-booking app tested with jest through pnpm: 16 sessions, 5 notes added by hand, 1 MCP save, 48 prompts (19 delivery, 19 recall, 36 search, 11 with no answer). Its traps are the usual ones: a test command switch, a run in another checkout, a note whose file then changed, a one-off request said twice, and an instruction repeated across sessions. It was run once with the index on (`results-sqlite.json`) and once with it off to attribute the result (`results-sqlite-off.json`). The two runs are identical (144 of 144 outputs).

| Criterion | Unseen 10 |
|---|---|
| Right, current answer first: delivery / recall / search | **16/19**, **16/19**, 33/36 |
| Stale, unsupported, uncited or other-folder facts shown | 0 |
| Nothing shown on unanswerable prompts, all paths | 11/11 |
| Delivery tokens, median / max (budget 600) | 96 / 279 |
| Time per call, median: delivery / recall / search | 179 / 100 / 158 ms |
| Claude Code and Codex get the same delivery | 48/48 |
| Verdict | **fail** |

The misses, all from retrieval (the index changes no answer):
- **One shared word, or a link only by meaning** (6 of 9): delivery D08 "Raise the lane limit" (only "lane"; "limit" and "at most" are a meaning link), delivery D12 "Write a migration…" (only "migration"), recall Q13 "Why didn't ngrok start?" (only "ngrok"), recall Q14 "Where was the waitlist work left?" (only "waitlist"), recall Q15 "What did we change about reminder emails?" (the session that said "reminder emails" stated the replaced 24-hour claim, so that sentence is masked; the current one shares only "reminders").
- **Meaning against two shared words**: delivery and search D21 "Charge the member's card for a lane booking." The sign-in note shares "member" and "card" and comes first; the Adyen note shares only "card" ("charge" and "payments" link by meaning).
- **A one-word note ahead of nothing better**: search Q15 "reminder emails" shows the sign-in note on "email".
- **Ties go to the newest**: search Q16 "lane booking". The lane-closure session shares both words, as does the lane-booking one, and it is newer.

**Status.** Gate 3 does not pass on this build. Every safety criterion holds; the misses are the known limits listed under round 10, at a rate above the 90% bar on this set. Gate 4 waits: fixing them needs a fix round and then another fresh set, frozen before it runs.

**Round 10, 2026-10-26: Gate 3 passes on a fresh set, in the shipped words-only mode.**

Unseen 9 (`bench/recall-gate/unseen9/`) was frozen before the fixes. It's a Python farm-marketplace API tested with pytest: 16 sessions, 5 notes added by hand, 1 MCP save, and 48 prompts. Of those, 19 are answerable by delivery, 19 by recall and 35 by search; 11 have no answer. Its history has:
- a test command that switches A, B, A, B;
- short names (k6, S3);
- answers that sit in a session's last words;
- a prompt that names a file with uncommitted work while a note fits;
- the usual freshness, scope and silence traps.

Fixes for unseen 8's failures, each with a regression test in `test/gate3.test.mjs` ("round 10"):
- **The test-command loop.** When a replacement's text matches an older, already-replaced note, that note becomes current again (`supersedeObservation`, `src/memory/store.ts`). A store already caught in the loop recovers on the next passing run (`reactivateObservation`, called from `applyDistilled`).
- **Search lines.** A session line shows the sentence of its outcome that shares most with the query, and falls back to it when the request was left out as out of date (`cardSummary`, `src/memory/tools.ts`).
- **Short names.** A letter plus a digit (c8, k6, s3) counts as a word, matched exactly as written, in `terms()` and in search. Two letters ("UI") still don't count.
- **Notes before left-off text.** Unless the prompt asks to continue, a note that fits comes before "where you left off", which still follows (`asksToContinue`, `src/cli.ts`).

Unseen 9, first run, words only (`results-round10.json`):

| Criterion | Result |
|---|---|
| Right, current answer first: delivery / recall / search | 18/19, 19/19, 32/35 |
| Stale, unsupported, uncited or other-folder facts shown | 0 |
| Nothing shown on unanswerable prompts, all paths | 11/11 |
| Delivery tokens, median / max (budget 600) | 87 / 233 |
| Time per call, median: delivery / recall / search | 185 / 99 / 155 ms |
| Claude Code and Codex get the same delivery | 48/48 |
| Verdict | **pass** |

The first run's misses:
- **Delivery D06**, "Upload the banner image to S3.": one shared word with the bucket note.
- **Search D09**, "listing expiry": a session that mentions "expiry" outranks the note that says "expire".
- **Search Q12**, "k6 load test": "test" makes the test-command note fully relevant, so it ties with the k6 note and comes first.
- **Search Q04**, "cdn cache": the session line came back empty. The out-of-date marker ends in "]", which the new sentence split didn't treat as a break, so the session's current sentence was dropped with the marker. This was a bug in this round's own change: it was fixed, with a regression test that uses the real marker. Every set was rerun as a check (`results-round10b.json`); Q04 and unseen 8 R02 now pass, and nothing regressed. The verdict above is the first run's.

Unseen 8 now passes as well (`results-round10.json`). The local model wasn't rerun; round 9 showed it changes no score.

**Gate 3: passed, 2026-10-26.** It passed on a fresh, larger set run once, words only, with the scorer and criteria unchanged since round 1. The smaller early sets still fail on one-word misses, which the larger-set bar (the owner's choice in round 7) was set to absorb. The known limits still stand:
- one shared word, or only a meaning link, in delivery;
- word-form gaps such as "expiry" against "expire";
- the test-command rule winning ties on queries that mention tests.

Next, per the owner's plan: a local SQLite/FTS5 index, with a tested migration and rebuild path, before a production release. Then rerun Gates 2 and 3 on that build, then Gate 4 on the same build users would install. Gate 4 is paid, so the owner decides first.

**Round 9, 2026-10-26: out-of-date claims fixed at the source; unseen 8 fails in both modes for other reasons.**

Unseen 8 (`bench/recall-gate/unseen8/`) was frozen before the fix. It's a Node bookings API tested with `node --test`: 15 sessions, 6 notes added by hand, 1 MCP save, and 51 prompts. Of those, 20 are answerable by delivery, 18 by recall and 34 by search; 11 have no answer. Its freshness traps:
- a saved claim, repeated in the request and last words of the session that saved it, whose file then changes;
- that same session's other, still-true statement ("the mail templates live in templates/email/");
- a replaced decision that an earlier session's words repeat;
- a true statement about a file that later changes for another reason ("src/pricing.ts exports roundPrice");
- a Codex session's unfinished work, picked up from Claude Code.

The fix:
- **Provenance.** A note saved over MCP now records the session it came from: the one the hooks last saw in the project, from `.snout/state.json`. Rule-saved notes already did.
- **Out-of-date claims** (`staleClaims`, `src/memory/facts.ts`): a note replaced by a newer one, or held back because a file it is about changed.
  - Test commands, missing tools and slow tests don't count: a session record's runs are history.
  - A private note that was shared doesn't count: its claim stands in the shared copy.
- **What is shown.** In recall, search and a prompt's "where you left off", each sentence of a session record that states such a claim is replaced by a short marker, and the rest of the session stays (`withoutStaleClaims`, `src/memory/memory.ts`). A sentence states a claim when it contains it, or shares four fifths of its words (three fifths in the session that saved the note, whose provenance already ties them).
- **What isn't touched.** A file edit with no out-of-date note behind it leaves every sentence alone. `snout_memory_fetch` shows the dated record whole, with the claim flagged "Out of date".

Regression tests, in `test/gate3.test.mjs` ("round 9"):
- **The EXIF example, through the real hooks of both agents.** A Claude session saves the claim and repeats it; a Codex session changes `app/exif.py`. Then new Claude and Codex prompts, `snout recall` and three searches get only the current answer, and the session's other fact (where thumbnails are cached) is still found.
- The session the note was saved in is recorded.
- A Codex session's unfinished task still reaches a Claude prompt.
- Another project's stale note doesn't touch this one.
- Sentence-level redaction, the provenance threshold, a file edit alone, a replaced decision, and a shared note.

The earlier sets show no regressions. Unseen 7's two stale recall results are gone. Its delivery is unchanged at 16/18, the one-word limit.

Unseen 8, first run in each mode, on the same code:

| Criterion | Words only (shipped) | Words + local BGE (optional) |
|---|---|---|
| Right, current answer first: delivery / recall / search | **14/20**, 17/18, **29/34** | **14/20**, 17/18, **29/34** |
| Stale claims shown | **0** | **0** |
| Unsupported, uncited, other-folder | 0 | 0 |
| Nothing shown on unanswerable prompts, all paths | 11/11 | 11/11 |
| Delivery tokens, median / max (budget 600) | 86 / 203 | 86 / 203 |
| Time per call, median: delivery / recall / search | 193 / 103 / 165 ms | 278 / 132 / 282 ms |
| Verdict | **fail** | **fail** |

The model added three results and removed none. None was right:
- recall for two "how do I run the tests" questions also lists another checkout's e2e run;
- one search also lists the search-engine decision, after the right answer.

Why both modes fail (the freshness fix held on the fresh set: no stale claim on any path):

- **No active test command (delivery A01, A02, A20; search A01, A02).** This bug predates this work. B1 ran `node --test`; B2's `npx c8 node --test` replaced it; then B5 ran plain `node --test` again. Saving that text found the existing, already-replaced note and returned it without making it active, and marked B2's note replaced by it. Both notes ended up replaced by each other, and B6's later run couldn't recover, because no active note was left to replace. It affects any project whose test command switches back to an earlier one.
- **One shared word, or only a meaning link, in both modes:** delivery A10 ("Add search by venue name.") and A22 ("Translate the checkout page into German.").
- **"Where you left off" comes first (delivery A21):** the prompt names `src/bookings.ts`, which has the last session's uncommitted work, so that block comes before the card-number note. Same class as main P14.
- **Search lines show only a session's request:**
  - R13, "deploy staging", finds the session but not that flyctl was missing.
  - R02, "email templates", finds the session that saved the mail claim, but its request is now the out-of-date marker, and the templates sentence is in its last words, which a search line doesn't show. This interaction comes from this round's fix.
- **Recall R11**, "c8 coverage": "c8" is shorter than the three letters a word needs.
- **Search R15**, "synchronous emails": no record shares two of its words.

**Status.** Gate 3 does not pass in either mode. The freshness gap is closed. The blockers are a replacement bug that loses the test command, search lines that show only a session's request, and the known one-word limit. The local model changed no score.

**Round 8, 2026-10-26: five ranking fixes; unseen 7 fails on a freshness gap; the local model passes delivery.**

Unseen 7 (`bench/recall-gate/unseen7/`) was frozen before the fixes. It's a Python photo-sharing API with a Celery worker: 16 sessions, 8 notes added by hand, 1 MCP save, and 48 prompts. Of those, 18 are answerable by delivery, 20 by recall and 33 by search; 11 have no answer, two of which share one generic word with a note ("edge", "images").

The five fixes from unseen 6, each with a regression test in `test/gate3.test.mjs` ("round 8"):
1. Delivered notes are ordered by how well they fit (a named file or code name, shared words and topics, then a rule's match), and kind order breaks ties.
2. Recall answers a one-word question on that word, as the shared scorer does.
3. Sessions that changed a named file are ordered by what they share with the question, then newest.
4. "migration" no longer marks a question about history; "migrated" still does.
5. In search, one shared stop word ("file") is no evidence for a note.

Rerunning the earlier sets found one regression from fix 1: main P11. "Format the code with just before committing." got the commit-style note before "just is not installed". At equal strength, my first version kept the caller's order instead of kind order. That was fixed, with a test, and the earlier sets were rerun: no other change (`results-round8b.json`).

Unseen 7, first run, words alone (`results-round8.json`; P11's fix doesn't change it):

| Criterion | Result |
|---|---|
| Right, current answer first: delivery / recall / search | **16/18**, 20/20, 30/33 |
| Stale facts shown | **recall 2** |
| Unsupported, uncited, other-folder | 0 |
| Nothing shown on unanswerable prompts | 11/11 on every path |
| Delivery tokens, median / max | 90 / 124 |
| Verdict | **fail** |

Causes:
- **Stale (Z21, Z39 recall):** recall lists the session in which the user asked to save "Uploads have all EXIF metadata stripped in app/exif.py before storage." Its last words repeat the claim, which a later change to `app/exif.py` made out of date. Notes get the changed-file check; session records don't. This is a freshness gap, not a ranking one.
- **Delivery Z08**, "What size are thumbnails?", and **Z11**, "Translate the error messages shown to users.": one shared word, or only a meaning link to the note.
- **Search:**
  - Z41, "upload endpoint": two sessions tie and the newer one is the wrong one.
  - Z12, "upload size limit", and Z39, "photo metadata": the right record shares one word of the query, which isn't enough for a session record.

As the owner directed, the word-rule fixes stopped here, and the optional local model was compared with words alone on unseen 7. Both arms ran on the same final code, with the round-6 thresholds unchanged:

| | Words alone (`results-round8b-words.json`) | Words + local model (`results-round8b-sem.json`) |
|---|---|---|
| Right, current answer first: delivery / recall / search | 16/18, 20/20, 30/33 | **17/18**, 20/20, 30/33 |
| Stale facts shown | recall 2 | recall 2 |
| Nothing shown on unanswerable prompts | 11/11 each | 11/11 each |
| Time per call, median: delivery / recall / search | 167 / 74 / 156 ms | 257 / 101 / 275 ms |
| Verdict | fail | fail (stale only) |

The model added three results and removed none:
- **1 right:** Z08 gets the thumbnail-size decision.
- **2 off topic, on unscored paths, both for Z30** ("How did we fix rotated thumbnails?"): delivery also gets the thumbnail-size decision, and recall lists the dedupe session after the right one.

On this set the model passes the delivery criterion that words alone miss, at about 90 ms more per prompt and 120 ms more per search. It doesn't fix the stale recall result, or the search ranking misses.

**Status.** Gate 3 does not pass. What blocks it:
- **The freshness gap:** session records that repeat a note's claim aren't checked for drift. This is a product decision: hide, mark, or leave such history.
- **On words alone, delivery at 16/18;** the local model reaches 17/18.

**Round 7, 2026-10-26: a larger fresh set; close, not passed.**

The owner chose to judge Gate 3 on a larger fresh set. Each 18-prompt set had only 7 to 9 delivery prompts, so 90% meant every one; with about 20, it allows two misses. Unseen 6 (`bench/recall-gate/unseen6/`) is a TypeScript API with a job worker: 16 sessions, 9 notes added by hand, 1 MCP save, and 46 prompts. Of those, 20 are answerable by delivery, 18 by recall and 33 by search; 11 have no answer, two of which share one generic word with a note. It was frozen before this round's fix. Criteria and scorer are unchanged.

Fix: a search names a hyphenated tool (`sphinx-build`) as one token, and part of its name is not the tool. Regression test in `test/gate3.test.mjs`, "round 7". Unseen 5 search went from 8/11 to 9/11.

Unseen 6, first run, words alone (the default):

| Criterion | Result |
|---|---|
| Right, current answer first: delivery / recall / search | **17/20**, **16/18**, 32/33 |
| Stale, unsupported, uncited or other-folder facts shown | 0 |
| Nothing shown on unanswerable prompts: delivery / recall / search | 11/11, 11/11, 10/11 |
| Delivery tokens, median / max | 94 / 146 |
| Claude Code and Codex get the same delivery | 46/46 |
| Verdict | **fail** (delivery 85%, recall 89%) |

Misses and their causes:

- **The known limit, nothing shown:**
  - Y07, "keep amounts exact": no shared word with the money note.
  - Y14, "Add logging to the payment webhook": one shared word with the logger note.
- **Y20**, "Can I commit my .env file?": both commit notes fit, but delivered notes are listed by kind and date, not by evidence, so the commit-message note comes before the one that also matches ".env".
- **Y11 recall**, "Where does background work go now?": recall still needs two shared words when the question has only one ("background"). The shared scorer asks for one in that case; recall is inconsistent with it.
- **Y23 recall**, "How are order totals computed in src/api/routes/orders.ts now?": sessions that changed a named file come newest first whatever they say, so the later rate-limit change outranks the tax change.
- **Y17 search**, "sql migration": the pattern for a question about history matches the noun "migration" (it was meant for "migrated"), so session records outrank the migrations note.
- **Y46 search**, "logo file": a weak one-word note match on "file", a word recall treats as a stop word.

Five of the seven are defects in how retrieval orders or admits records. None is a wrong fact. Fixing them is the next round, with regression tests and another fresh set frozen first, since unseen 6 has now been seen.

**Round 6, 2026-10-26: the optional local model compared with words alone; no gain on the fresh set.**

Unseen 5 (`bench/recall-gate/unseen5/`, a Python web app tested with pytest) was frozen before any change. Its 18 prompts include:
- one-word cases: "Add a nickname field to the user model." against "Always add a migration when a model changes.";
- a case with no shared word: "credentials" against a password-hashing note;
- a generic one-word negative: "signups per week" against a weekly-jobs decision.

Its replay failed once on a history defect: a session committed without changing a file. That session now edits the file the change touches. This happened before any result of the set existed; the prompts are unchanged, and `freeze.json` records both versions.

Changes:

- **The round-5 regressions are fixed**, with tests:
  - R02: a topic match only adds to shared words.
  - W05: the stop-word-forms rule is reverted.
- **Meaning as evidence, opt-in** (`memorySemantic`, default off; `src/memory/semantic.ts`).
  - The local model (bge-small, `snout memory model install`) gives cosine similarities, served warm by `snout serve` and cached per record text.
  - Hooks wait at most 3 s for vectors, then fall back to words.
  - Verification and the changed-file check apply as before.
- **Thresholds were set from the five seen sets only** (`bench/semantic-calibrate.mjs`; the values and their provenance are in `src/memory/retrieve.ts`). A fixed similarity could not separate right from wrong one-word matches: right ones had a median of 0.61, wrong ones reached 0.76, and the only threshold with no wrong record above it admitted none of 67 right ones. The rule that held on seen data:
  - among records sharing one word, only the clearly closest in meaning counts, at 0.70 or more and 0.10 ahead of the next;
  - with no shared word, 0.67 or more.

| | Words alone | Words + local model |
|---|---|---|
| Main | pass | pass (+ P12 delivery) |
| Unseen 1 | fail (delivery 8/9) | fail (delivery 8/9; + Q05 search) |
| Unseen 2 | fail (delivery 6/8) | fail (delivery 6/8) |
| Unseen 3 | fail (3 criteria) | fail (2 criteria; + V09 recall) |
| Unseen 4 | fail (recall silence 4/5) | fail (recall silence 4/5) |
| **Unseen 5 (fresh)** | **fail** (delivery 6/8, recall 2/3, search 8/11) | **fail, identical scores** |
| Stale / unsupported / other-folder facts shown, all sets | 0 | 0 |
| Time per call, median: delivery / recall / search | 160 / 71 / 150 ms | 238 / 96 / 252 ms |
| Setup | none | 26 s install, 412 MB on disk; model warm-up in `snout serve` about 0.3 s |

What the model added (10 results, none removed):
- **3 right**, all on seen sets: main P12, unseen 1 Q05, unseen 3 V09.
- **7 session records on recall prompts the gate doesn't score**, all from the no-shared-word rule on "how do I run the test suite" questions. At least four of them are other checkouts' test runs, one of them on the fresh set (X02: "Run the smoke tests in my quill-smoke checkout").

On the fresh set it fixed nothing. The one-word delivery misses (Q12, R07, R12, V07, V12, X12) stay missed, because the right note is rarely the clearly closest in meaning.

**Unseen 5's failures, both arms:**
- **X03 search**, "sphinx-build": the missing-tool rule compares the query's words with the tool name, and the hyphen splits it.
- **X06**, "credentials": no shared word, and below the meaning threshold.
- **X12** ("model") and **X09 recall** ("coverage"): one shared word.

**Conclusion.** On these sets, bge-small adds no answers to unseen questions, costs about 80–100 ms per prompt and per search, needs a 412 MB install, and its no-word rule adds misleading session records to recall. It should stay off by default and isn't worth shipping in this form. Gate 3 does not pass. What remains:
- the hyphenated tool name in search, a bug;
- the one-word rule in delivery, a precision choice;
- the recall misses on one word.

**Round 5, 2026-10-26: a shared retrieval scorer; the fourth unseen check fails.**

The owner decided:
- the one-word delivery exception comes out;
- uncertain matches stay available through search, which the agent asks for;
- the three concrete bugs get fixed;
- one shared scorer is tested across the three paths;
- an optional local embedding retriever is compared on a frozen set only if lexical retrieval still misses too much.

Snout may use a local model. The promise is local-first and open source, not model-free. A fourth unseen set (`bench/recall-gate/unseen4/`, a TypeScript monorepo tested with Jest, with two files named `index.ts`) was frozen before the changes.

Changes:

- **The one-word exception (`soleFit`) is removed.**
- **A shared scorer, `src/memory/retrieve.ts`.**
  - It parses a question into words, file paths and code names (`toCents`, `get_item`, `anyhow::Context`, `parse()`; not "TypeScript").
  - It grades a record's evidence as strong (a file it is about named by its path, a code name it contains, or two shared words in any form), weak (one word), or none.
  - Delivery and recall need strong. Search also offers a verified note on weak evidence for a one- or two-word query.
  - Each path keeps its own ordering.
  - A word counts once in whatever form ("user" and "users").
  - A word whose base form is a stop word is a stop word ("running", "added").
- **A path with a folder names only that file** (`cache/users.ts` is not `routes/users.ts`), in recall, search and the left-off check.
- **Recall ranks with word forms**, and a code name the prompt mentions counts as strong.
- **Toolchain tools:**
  - Python: a dependency declared in `pyproject.toml`, `setup.cfg`, `requirements*.txt` or `Pipfile`.
  - Rust: the tools rustup installs with cargo, in a `Cargo.toml` project.

  Either counts as installed.

Regression tests: `test/gate3.test.mjs`, "round 5". The round-4 exception tests were removed with the exception.

| Criterion | Main | Unseen 1 | Unseen 2 | Unseen 3 | Unseen 4 (first run) |
|---|---|---|---|---|---|
| Right, current answer first: delivery | 19/21 | 8/9 | **5/8** | **6/8** | **6/7** |
| Right, current answer first: recall | 12/13 | 3/3 | 3/3 | **2/3** | 4/4 |
| Right, current answer first: search | 24/26 | 11/12 | 11/11 | 11/11 | 11/11 |
| Stale / unsupported / uncited / other-folder shown | 0 | 0 | 0 | 0 | 0 |
| Delivery tokens, median / max | 91 / 136 | 94 / 118 | 114 / 143 | 99 / 122 | 90 / 134 |
| Nothing shown on unanswerable prompts: delivery / recall / search | 11/11 each | 5/5 each | 5/5 each | 5/5, 5/5, **4/5** | 5/5, **4/5**, 5/5 |
| Claude Code and Codex get the same delivery | 41/41 | 18/18 | 18/18 | 18/18 | 18/18 |
| Verdict | pass | fail | fail | fail | **fail** |

For the first time, no set shows a stale, unsupported, uncited or other-folder fact on any path. Pinning PATH and the toolchain fix removed "pytest is not installed" and "rustfmt is not installed".

Wrong outputs:

- **Unseen 2 R02**, "How do I run the test suite here?", shows the error-handling convention first. A regression from this round: a note that mentions tests now counts as strong on the topic alone when the prompt has only one other word ("suite"). Before, the topic only added to shared words.
- **Unseen 3 V14 search**, "header image", offers the X-Trace-Id header note. This is the owner's choice to keep weak note matches in search.
- **Unseen 4 W14 recall**, "Generate a sitemap for the marketing site.", lists the login-redirect session on two generic words: "generate" (as "generated") and "site". This is the limit of word matching.

Misses, with nothing shown or something less relevant:

- **Unseen 4 W05**, "How should the API report errors?". A regression from this round: the stop-word-forms rule drops "errors", because "error" is a stop word. That leaves one word, "API".
- **One shared word, now never delivered:** Q12, R07, R12, V07, V12.
- **Unseen 3 V09 recall:** "running" is a form of the stop word "run", leaving "parallel" alone.
- **Earlier misses:** P12, P14, P28, P30, Q05.

**Status.** Gate 3 does not pass. Word matching has nothing wrong left except one generic two-word recall match (W14) and the search weak match the owner chose (V14). What blocks the accuracy criteria is two regressions from this round (R02, W05) and one-word misses. The next steps are the R02 and W05 fixes, and the owner's step 4: compare an optional local embedding retriever as a candidate source, on a frozen set, under the same evidence and freshness rules.

**Round 4, 2026-10-26: third unseen check fails; the one-word exception adds a wrong output.**

Changes:

- **Harness: PATH is pinned** to git alone. On Windows that is Git's cmd folder. A run refuses to start if a tool the history scripts as missing is on PATH. Every set was re-frozen with its input hashes unchanged (`freeze.json` lists the earlier scorer hashes).
- **A third unseen set** (`bench/recall-gate/unseen3/`, a Deno API, 18 prompts) was written and frozen before the product changes.
- **`PASSED` reads "0 failed" as zero failures** (`src/compact/memory.ts`). Any nonzero count, "FAILED", "failures=N" or "Some tests failed" still fails. Recomputing saved notes was checked and isn't needed. A wrong verdict only left a passing run unsaved: no note was written from it, and a verdict is re-read from the card's result whenever it is used. None of this repository's own cards changed verdict (8 cards, 2 with test results, 0 changed).
- **A narrow one-word exception for delivery** (`soleFit`). When no note fits on two words, one note fits on one if all of these hold:
  - it is the only verified note sharing a word with the prompt (test-command and missing-tool notes excluded);
  - the word appears in at most one other session record;
  - the project has ten or more records.

  Sessions that quote the note (where the user said it) don't count against the word.

Regression tests: `test/gate3.test.mjs`, "round 4". They cover zero and nonzero failure counts for cargo, Deno, Jest, pytest and unittest, and the exception's negatives: a word common in the project's sessions, two notes sharing a word, too few records, and a missing-tool note.

| Criterion | Main | Unseen 1 | Unseen 2 | Unseen 3 (first run) |
|---|---|---|---|---|
| Right, current answer first: delivery | 19/21 | 8/9 | 7/8 | 8/8 |
| Right, current answer first: recall | 12/13 | 3/3 | 3/3 | **1/3** |
| Right, current answer first: search | 24/26 | 11/12 | 11/11 | 11/11 |
| Stale facts shown | 0 | 0 | 0 | 0 |
| Shown without a checkable record | 0 | **1** | **1** | 0 |
| Commands from another folder shown | 0 | 0 | 0 | 0 |
| Delivery tokens, median / max (budget 600) | 91 / 136 | 94 / 130 | 104 / 123 | 97 / 122 |
| Nothing shown on unanswerable prompts: delivery / recall / search | **10/11**, 11/11, 11/11 | 5/5 each | 5/5 each | **4/5**, 5/5, **4/5** |
| Claude Code and Codex get the same delivery | 41/41 | 18/18 | 18/18 | 18/18 |
| Verdict | pass | **fail** | **fail** | **fail** |

Results: `results-round4b.json` in each set's folder. `results-round4.json` is the rerun of the first three sets before the source-session change.

Wrong outputs and their causes:

- **The exception fires on generic words.** Original P41 "Write a haiku about ledgers." gets the commit-message preference on "write". Unseen 3 V14 "Add a header image to the landing page." gets the X-Trace-Id header decision on "header". Search shows that decision too, through the round-1 rule that lets a verified note answer a two-word query on one word. Rarity in a small project's records is not evidence that a word is specific. Without knowing what words mean, one shared word can't tell "log request bodies" from "write a haiku", so the exception should come out.
- **A missing tool the project's toolchain provides.** Exposed by the pinned PATH: "pytest is not installed" (unseen 1, tox env) and "rustfmt is not installed" (unseen 2, run by `cargo fmt`). `installedFor` knows only Node (`node_modules/.bin`, package.json).
- **Recall matches a named file by its base name** (unseen 3 V08). `cache/users.ts` also matched a session that changed `routes/users.ts`, and newest-first put that one ahead.
- **Recall doesn't use word forms** (unseen 3 V09). "running" doesn't meet "run", so "When did the tests start running in parallel?" shares one word with the right session.

Silent misses, with nothing wrong shown: original P12, P14, P28, P30; unseen 1 Q05; unseen 2 R12.

**Status.** Gate 3 does not pass. The exception was the recommended narrow form, and it still shows unrelated notes on single generic words. The other failures are separate, specific bugs in recall and in missing-tool detection.

**Status after round 2.** Gate 3 did not pass yet: the main set passed, but the unseen check failed on search fallback noise, stemming, and one citation. The unseen set has now been seen, so after the next fixes, passing needs a new unseen set, written and frozen before they run. This gate is a scripted, free memory test. It says nothing about cost per solved task; that is Gate 4's question, and the paid pilot waits for the owner's go.

**Product direction** (2026-10-26). Observe stays "records only". Remembered notes are turned on separately from trimming, as a clearly named memory-only setting, and that setting is offered only after Gate 3 passes. Automatic recall is not the default while the failures above remain.

## Cross-agent handoff check (2026-10-28)

**Question.** Before the pilot is frozen: does a record one agent leaves reach the other agent in a fresh session through Snout's search, and does the receiver use it? Claude Code to Codex and Codex to Claude Code, on two small projects written for the check (`bench/handoff/`), none of the pilot's tasks. Each receiver runs twice from the same snapshot, Snout on (search and fetch over the giver's store) and Snout off, with the same prompt. Tasks, prompts, expected facts and scoring were frozen before each run (`bench/handoff/spec*.json`, `freeze*.json`; harness `bench/handoff-check.mjs`). What a receiver was shown is read from the MCP server's own traffic.

**Run 1: the fact in the record and in the code** (`results-2026-10-28.json`, 6 sessions, $0.19 API). Both givers solved their task and left a record holding the fact. Neither receiver called search, though both were offered it, and all four receivers solved their task with or without Snout: the giver's code showed the fact. The frozen scorer marked one off-arm session invalid for its own workspace path written as Git Bash writes it (`/c/Users/...`); the scorer was fixed and the session rescored valid.

**Why the receivers didn't search.** Snout's guidance did not reach either model in a usable form. Claude Code put the MCP server's instructions in context, but deferred both tools behind ToolSearch: the model saw only their names, not their descriptions. Codex left the server's instructions out entirely, and its MCP tools sit behind a lookup in its code tool. Neither receiver had any sign that a record existed for its task. Snout now adds one line at session start, in enforce mode, when other sessions are on record: how many, the latest's date and agent, and how to search them, with nothing from the records (`memoryHint`, on by default). A live Codex session showed the line arriving as a developer message.

**Run 2: the decision only in the record** (`results-2026-10-28-record.json`, 6 sessions, $0.21 API). The user gave the giver a decision for later work (finance's fuel-portal format; payroll's new weekly rule) and asked it to do something else first. The receiver's prompt refers to that decision without stating it.

| Direction | Snout on | Snout off |
|---|---|---|
| Claude Code → Codex | hint delivered; 1 search, 1 fetch; found the record, current and cited; used the format; solved | copied the invoice format (semicolons); not solved |
| Codex → Claude Code | hint delivered; 1 search, 1 fetch; found the record, current and cited; used the rule; solved | found no rule, asked which one; not solved |

Both handoffs succeeded. The frozen check flagged the Codex → Claude Code snapshot as holding the decision, because a test name the giver wrote contains the word "payroll"; that test pins the old rule, so the decision itself was only in the record. One pair per direction says nothing about cost.

**Scorer fix, after run 2.** The "decision in the project" patterns matched topic words ("payroll", "supplier's portal"), which the receivers' prompts also contain. They now match only the decision. The check reports each matching line, not just the file. `--grade-check` fails a pattern that matches the receiver's prompt or misses the giver's. It also fails one that finds the decision in the giver's reference or misses it in the receiver's. Rescored on run 2's saved snapshots, neither direction holds the decision outside the record. The results file keeps the frozen verdict, and `spec-record.json` was re-frozen.

## Gate 4: small real-agent pilot

**Question.** With that history in place, do Claude Code and Codex, with Snout, solve new coding tasks at lower total tokens and cost per solved task than without it?

**Design** (frozen 2026-10-28; full text in the protocol's [memory study](benchmark-protocol.md#memory-study) section, under "Amendment, 2026-10-28"; design file `bench/memory-pilot.json`):

- **Tasks:** the five oldest held-out tasks of each study list, Hugo and vite: 10 per agent. hugo-15171 was excluded as flaky on this machine before any session, and hugo-15245 took its place. Within each repository, earlier sessions on older tasks produce the history. No script writes it.
- **Arms:** 3, the same tasks in each. `plain` is no Snout. `trim` is trimming only. `search` is trimming plus memory as it ships: search and fetch tools, and the session-start hint. Arms are interleaved by task.
- **Sessions:** 30 per agent, 60 in all. Claude Code runs on the API, capped at $6 for the pilot: Hugo first with $3, then vite with what is left. A task's three sessions start only if they fit the cap, so every group that runs is complete. Codex runs on the plan.
- **Labels** (added 2026-10-29, before any paid session): each task is a `candidate` when an earlier task in its repository changed files in a related folder, otherwise a `control`. Hugo has one candidate (15208), vite four. Each `search` session's path is recorded: hint, search, labeled record shown, opened, acted on, result.

**Go/no-go for the full study,** per agent:

- **Memory adds value:** `search` solves at least as many tasks as `trim`, at a lower cost per solved task.
- **The complete workflow pays:** `search` against `plain`, judged the same way.
- **No verdict:** a chain is invalid, or the hint missed a session that had records.
- **No-go:** if memory fails for both agents, it is fixed or removed before any larger run.
- **What to work on next** (reported): agents never searched → fix discovery; searched but no labeled record helped → improve what memory captures, or the tasks; used but cost rose → reduce retrieval overhead. No code changes mid-run, and no rescoring after a mixed result.
- **Also reported:**
  - tokens per solved task;
  - whether agents used memory: searched, opened a record, then acted on it;
  - wrong recalls: a record acted on in a task `search` failed and `trim` solved.

This pilot is too small to estimate a saving. It decides only whether the full study is worth running.

### Result (2026-10-29): no-go for memory as it shipped, for both agents

All 60 sessions ran on the frozen build (commit 4836014, bundle 51d7156a). Claude Code used claude-sonnet-5-5 on the API, $1.52 in all. Codex used gpt-6.1-sol at low effort on the plan; its dollars below are the list-price equivalent of its tokens. Every chain scored was valid, with no network use and no Snout side calls. Cost is per solved task.

| Agent | Arm | Solved | Cost | Tokens |
| --- | --- | --- | --- | --- |
| Claude Code | plain | 4/10 | $0.128 | 338,910 |
| Claude Code | trim | 4/10 | $0.120 | 356,295 |
| Claude Code | search | 4/10 | $0.133 | 372,924 |
| Codex | plain | 3/10 | $0.289 | 977,670 |
| Codex | trim | 5/10 | $0.179 | 518,498 |
| Codex | search | 2/10 | $0.492 | 1,319,715 |

- **Memory adds value:** no for either agent. **The complete workflow pays:** no for either agent. Under the rule above, memory as it shipped is fixed or removed before any larger run.
- **Trimming** (reported, not a gate): trim's cost per solved task was below plain's for both agents. Ten tasks per agent is too few to support a claim.
- **How memory was used:**
  - Claude Code got the hint in all 8 sessions that had earlier records, and never searched.
  - Codex searched and opened a record in all 8 of its hinted sessions, and acted on none. Four of its searches found nothing.
  - On Hugo, Codex's search returned the newest record rather than the related one.
  - On vite, Codex opened the session the hint named as unfinished: in all four candidates, the previous task's record, which was a labeled earlier task. The path table counts a labeled record only when a search showed it, so those rows read "searched, no labeled record shown". The verdict is the same either way, because none was acted on.
- **Wrong recalls:** none.
- **What to work on next, under the rule fixed before the run:**
  - Claude Code: discovery. It is told about the records and does not look.
  - Codex: capture. It looks, and a session record is not what it needs.
- **Runs:**
  - Claude Code: `bench/ab-results/memory-study-claude-hugo-1793300059910.json` and `...-claude-vite-1793300708380.json`.
  - Codex: `...-codex-hugo-1793308748476.json` and `...-codex-vite-1793311928657.json`, run from the operator's terminal.
  - An earlier Codex Hugo chain stopped after 14 of 15 sessions, when Claude Code's low-memory reaper killed the job. It is kept as `...-codex-hugo-1793301387426.json` and not scored. `...-codex-hugo-1793308552650.json` stopped before its first session, and two Codex files from 14:16 failed before any session because `CODEX_CLI_JS` was unset.

**What changed after it** (not measured yet): reviewed lessons ([lessons](memory-lessons.md)). An agent proposes a short lesson only from a test that passed, a decision you gave or a correction you made. Snout checks the session's record for that evidence, and you approve or reject it. A search shows approved lessons first. One short skill tells both agents when to search and when to skip. Both changes answer the diagnoses above: the lesson targets capture, and the skill targets discovery. Whether either helps is the next test ([plan](memory-lessons.md#next-the-billing-handoff-live)).

## Write rules, lessons in prompts and search order (2026-10-30): no regression on the 17 Gate 3 sets

Owner's terms: in three phases, tighten what gets written, deliver high-confidence memory without a search (opt-in, Claude Code and Codex), and make search more selective. Measure each phase on the frozen sets.

**What changed.**
1. **Writes** (`src/memory/quality.ts`).
   - An agent's `snout_memory_save` is kept only when the user asked for it. Anything else goes through a lesson.
   - Nothing is saved that `CLAUDE.md` or `AGENTS.md` already says: a test command the file writes out, or a note one of its paragraphs nearly states (80% of its words).
   - Nothing is saved that nearly repeats a note or lesson on record (80% of words, same numbers, same negation), a rejected lesson included. A correction is not a repeat.
   - Decay, at session start: proposals unreviewed for 30 days and rule-saved notes unused for 90 days (no row in `recall.jsonl`) are archived, tagged `unused`. `snout memory restore` brings one back, and so does its rule seeing it again. The user's own notes, accepted notes and approved lessons don't decay.
   - `snout memory list` and fetch name what verified each note.
2. **Delivery** (opt-in `memoryNotes`, off by default).
   - A prompt also gets approved lessons that fit on strong evidence over the lesson, where it applies and its files. Lessons come first, and a lesson resting on a verified fix comes ahead of one resting on a decision.
   - A prompt gets 3 notes at most.
   - The session-start line names approved lessons by id and where they apply (3 at most), never their text.
   - The same hooks run for Claude Code and Codex.
3. **Search.**
   - Among several test-command notes, the one sharing more of the query's words goes first.
   - "-ied" words meet their "-y" form (retried, retry). The local index schema goes to 4, so it rebuilds once.
   - The planned past-fix prior for session records was tried and dropped. It put a session that had only found a tool missing ahead of the newer session that answered (unseen 8 A20, R11) and gained nothing. It stays only for approved lessons.

**Not done, and why.**
- No raised abstention threshold for the reranker. On these sets, search shows something on only 3 of 157 unanswerable prompts. Of 38 answerable misses, 32 show a record but the wrong one first, and in 26 of those the right record is ranked 2 to 4. That is ordering, not abstention. The reranker test (above) already found that a fixed probability doesn't separate "related" from "answers".
- No lexical expansion beyond word forms. Delivery's misses share no word with the right note, and a hand list of synonyms fitted to these sets would not carry over.
- No AGENTS.md snippet. Codex gets the session-start line and the skill, and in Gate 4 it searched in all 8 hinted sessions.

**Results.** All 17 sets, run through the real hooks, CLI and MCP server, scorer unchanged. Counts are summed over the sets. "Notes on" is `SNOUT_MEMORY_NOTES=1`.

| Build | Delivery, right first | Delivery silent | Recall, right first | Recall silent | Search, right first | Search silent | Stale, wrong-scope, unsupported |
|---|---|---|---|---|---|---|---|
| Before, notes off (`p0`) | off | 157/157 | 230/243 | 151/157 | 425/463 | 154/157 | 0 |
| Before, notes on (`p0n`) | 228/265 | 155/157 | 230/243 | 151/157 | 425/463 | 154/157 | 0 |
| Writes and delivery, notes off (`p12`) | off | 157/157 | 230/243 | 151/157 | 425/463 | 154/157 | 0 |
| Writes and delivery, notes on (`p12n`) | 228/265 | 155/157 | 230/243 | 151/157 | 425/463 | 154/157 | 0 |
| All three, notes off (`p3b`) | off | 157/157 | 230/243 | 151/157 | **428/463** | 154/157 | 0 |

- Writes and delivery with notes off: 1,980 of 1,980 outputs identical to before (`bench/recall-gate-diff.mjs p0 p12`).
- All three phases: 1,976 of 1,980 identical. The 4 that differ are unseen 16 searches. D01 "api tests", D02 "web tests" and D18 "uv pytest" are now right first. Q01 still misses. No answer was lost and no new record was shown on an unanswerable prompt.
- These sets have all been seen before, so the +3 is in-sample. A fresh frozen set is needed before claiming it carries over.
- The gate sets hold no lessons, so they can't show the lesson delivery. Tests cover it (`test/inject.test.mjs`):
  - an approved lesson reaches the prompt for both agents, cited;
  - nothing is added for an unrelated prompt, a one-word overlap, notes off, observe mode or an unapproved proposal;
  - a prompt gets three notes at most, the lesson first;
  - the session-start line is bounded.
- Latency, median of each set's median per call (a new process each time; the notes-on runs overlapped): delivery 151 → 156 ms with notes off, 155 → 164 ms with notes on; search 136 → 140 ms; recall 84 → 85 ms.
- Results files: `results-p0`, `-p12`, `-p3b` in each set's folder. The notes-on runs (`p0n`, `p12n`) ran from frozen copies of those builds and are kept with this session's working files, not in the repository.

**Also on this build.**
- Stand-in billing handoff (`bench/lesson-handoff.mjs`): PASS in both directions.
- Chargeline handoff dry run (`bench/ab-results/handoff-dryrun-1793377846880.json`): lesson handed off both ways: approved, shown, opened, solved. `bench/handoff/freeze-lesson.json` was frozen again for the new bundle; the live run hasn't been made.
- `npm run verify` from PowerShell exited 0, with 513 of 513 tests passing.
