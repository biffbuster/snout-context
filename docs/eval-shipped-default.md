# Later evaluation: Snout as it ships, and two capability tests

Draft, 2026-10-24. Not frozen and not approved to run. It starts only after the [memory study](benchmark-protocol.md#memory-study) is scored and its decision rules have removed whatever failed, because those results decide what ships.

## Why it is separate from the memory study

The memory study isolates components under a controlled setup: command hooks, enforce mode, and every model-backed or networked option off by name. A user who installs Snout gets something different:

- **Claude Code:** the plugin from the marketplace, with its blocking hooks sent to the shared `snout serve` process (`fastHooks`, on by default).
- **Codex:** `snout init codex`.
- **Defaults:** observe mode (`src/defaults.ts`), memory on, local prompt tips on, repeat-read and long-doc handling on, the repo map, preference judge and lessons off.
- **MCP:** Snout's MCP server, when `snout init` registered it.

Observe mode trims nothing and shows no notes: it records which notes would fit (`recall.jsonl`, `injected: false`) and adds nothing to the session (`src/cli.ts`, `promptNotes`). So today's default records but does not change what the agent sees, and memory works only after `snout mode enforce`. Whether that default stays is decided before this evaluation ([memory gates](memory-gates.md), gate 2). A claim about installing Snout needs whatever ships measured on its own, with every charge and delay it adds.

## Evaluation A: shipped default vs plain

**Question.** Installed the way the README says, with nothing configured, does the release under test lower cost per solved task against the plain agent? Snout's own charges count, and solved tasks must not drop. Claude Code and Codex are measured separately.

**Arms.**

- `plain`: no Snout.
- `shipped`: the release, installed as a new user installs it, with its defaults. If the owner changes the default before the run (the open decision on enforce by default), the run uses the new default. This evaluation measures whatever ships; it does not pick a configuration.
- Optional arms, each run only if its gate below says it could lower net cost per solved task. Gates are checked on data that exists before the arm's sessions run, and a skipped arm is reported with the reason.
  - `shipped+embed`: the local embedding model installed (`snout memory model install`). It makes no API call, but it costs a download, disk space, memory and load time. Since 0.3.2, notes are chosen by rules and the model only ranks searches the agent asks for (`snout_memory_search`, `snout recall`), so it can matter only in sessions that search. **Gate:** in the `shipped` arm's sessions, the agent searches past sessions in at least 10% of sessions, and an offline replay of those searches with the model returns a different top result for at least a quarter of them.
  - `shipped+jev`: the prompt coach and the preference judge set to TypeSafe's Jev. The coach's tips go to the user as a system message, never to the model, so in an unattended run they cannot change what the agent does. A coach arm would measure only Jev's charge and delay. The judge saves sentences a user states as lasting preferences, but the prompts here are fixed issue texts. **Gate:** an offline Jev pass over the `shipped` arm's actual prompts (its cost approved separately) saves at least one preference that a later task's prompt fits. If it saves none, the arm is skipped as unable to help.

**Tasks.** Same task rule, contamination rule, validation, prompt, workspaces, web-off rules and grading as the memory study. None of the study's 39 tasks or 4 check tasks is reused, since their results shaped what ships. Sources:

- Hugo and vite issues merged after the study's freeze (2026-10-24);
- the next repositories under the study's TypeScript rule, `vuejs/core` (16 candidates in the study's window) and `honojs/hono` (14).

The draw is frozen before any session. The target is at least 56 validated tasks per agent, the count the 10-point margin needs at 80% power. The run waits until that many exist, or is reported as able to reveal large losses only.

**What is counted.**

- **Agent cost:** priced as in the study (Claude Code dollars at list prices; Codex tokens at list-price equivalents).
- **Snout-side charges:** every model or API call any Snout process makes, recorded by the side-call watch (`bench/snout-guard.cjs`). That covers Jev calls (count, tokens, and TypeSafe's list price on the run date, confirmed before the run), any cloud call, and any download. A Snout-side call the arm does not declare (for example, a cloud call when no login exists) invalidates the chain, as in the study.
- **Cost per solved task:** agent cost plus Snout-side charges, divided by tasks solved.
- **One-time setup** (installing the plugin, downloading the embedding model) is reported separately with its size and time, not spread over tasks.

**Latency.** Reported for every arm, with guardrails fixed before the run (the values below are proposals for the owner to set):

- **Added time per hook event:** p50, p95 and maximum, for each event type, measured from each Snout process's start and exit in the watch's log and, for the shared server, from Snout's request timing.
  - Proposed guardrail: Snout's own work stays within the budget `test/bench.mjs` already enforces offline, 75 ms median over an identically started bare Node process (measured 2026-10-24: 23 ms median for the shipped hook form), now checked on real sessions, with p95 reported.
- **Cold start:** the first hook of each session (the shared server starting, the embedding model loading).
- **Session wall time against `plain`:** proposed guardrail, median no more than 10% above.

**Analysis.** As in the study: paired by task, a bootstrap over tasks and then repeats, cost per solved task as a ratio with a 95% interval, and the solved-fraction difference against the 10-point non-inferiority margin. Every task `shipped` fails that `plain` solves is listed by name.

**Claim it could support:** "Installed as shipped, Snout <version> changed cost per solved task by R (95% interval) in Claude Code [in Codex] on N held-out tasks from repositories we did not write, counting Snout's own charges; solved-rate difference D, lower bound L; added latency p95 X ms per tool call." With N of 56 or more and a lower bound above −10, it adds "no loss of solved tasks larger than 10 points". This is the product claim; the memory study's results cannot be relabeled as it.

**Sessions and cost** (56 tasks, 2 repeats, per agent):

| Arm set | Sessions per agent | Claude Code expected | Claude Code ceiling |
|---|---|---|---|
| `plain` + `shipped` | 224 | ~$67 at ~$0.30 a session | $100 |
| `shipped+embed`, if its gate passes | +112 | ~$34 | $50 |
| `shipped+jev`, if its gate passes | +112 | ~$34 plus Jev charges | $60 (Jev included) |

Codex runs on the owner's plan, with list-price equivalents reported. A free stand-in dry run and a real harness check (12 sessions per agent, ceiling $8 for Claude Code) come first, each approved separately.

## Capability test B: cross-machine team sync

Team sync is off the roadmap (2026-10-23), and Snout Cloud is off. This test exists so that no claim about sharing is made without it, and it runs only if sharing is shipped and marketed. It tests whatever mechanism ships: today, `snout memory share`, which keeps project memory in git; Snout Cloud, if it returns. Cloud also needs its server-side authorization tests to pass first, with no admin, role or plan check that trusts the client.

**Claim it could support:** "A verified note saved on one machine reaches a teammate's session on another machine, on the prompt it fits, once, with its source; private records never cross." This is a pass or fail capability claim, not a cost claim.

**Design.** Two machines, or this machine plus WSL2 or a Mac, each with its own clone and Snout config folder. Scripted scenarios run with the stand-in agent and Snout's real hooks:

1. A note saved on machine A, shared and pulled on B, is shown on B's fitting prompt, once, cited.
2. A prompt on B that the note does not fit gets nothing.
3. Private records on A never reach B: preferences, user-level notes, lessons, session summaries, and anything matching the redaction patterns.
4. Both machines save notes and merge: both are kept, and neither is shown twice.
5. A note retired on A (its fact changed) stops showing on B after the next pull.

**Measured:** delivery rate, false deliveries, leaks (must be zero), and time from save to availability. Then a small real-agent confirmation of scenarios 1 to 3.

**Sessions and cost:** about 60 stand-in sessions (free), then 10 Claude Code and 10 Codex sessions. Expected ~$3 on Claude Code, ceiling $6.

## Capability test C: Claude Code and Codex handoffs

**Claim it could support:** "Work started in one agent continues in the other. On the first prompt, the second agent gets the left-off note and the verified facts the first established (the test command, a missing tool), cited, and repeats less discovery work." Pass rates are the claim. Cost and solved-task differences are exploratory at this size.

**Design.**

- **Tasks:** 16 per direction (Claude Code to Codex, and Codex to Claude Code), from the evaluation A draw's repositories but not its tasks.
- **First session:** stopped unfinished by a turn cap.
- **Second session:** in the other agent, in the same workspace, with the prompt "Continue the work in progress on this issue".
- **Arms:** with Snout, both agents sharing the project's Snout folder; and without Snout, where only the working tree carries over.

**Measured:**

- whether the left-off note appeared on the first prompt;
- facts carried, scored against a checklist taken from the first session's records;
- false or stale facts shown;
- discovery commands the second session repeated;
- the second session's cost, and whether the task was solved.

**Sessions and cost:** 16 tasks × 2 directions × 2 arms × 2 sessions = 128 sessions, 64 in each agent. Expected ~$15 on Claude Code (first sessions are capped short), ceiling $25. A free stand-in run of the handoff path comes first.
