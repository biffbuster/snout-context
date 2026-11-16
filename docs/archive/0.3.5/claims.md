# Snout 0.3.5 claims (archived)

These results were measured on the clean Snout 0.3.5 bundle and do not describe later releases. Raw rows stay in `bench/ab-results/`. The current release's claims are in [../../claims.md](../../claims.md). Older: [0.3.4](../0.3.4/claims.md), [0.3.3](../0.3.3/claims.md), [0.3.2](../0.3.2/claims.md), [0.3.1](../0.3.1/claims.md), [before 0.3.1](../pre-0.3.1/README.md).

## Measured on 0.3.5: fresh install (no model, no network)

Snout is installed the way the README says, into an empty home and config folder: as the Claude Code plugin, and with `npm install -g` and `snout init codex` for Codex. Each agent's hooks then run on stand-in sessions in a new project. All 12 checks pass:

- Installing writes nothing to the home or config folder.
- Observe is the default. In observe the agent gets the session-start line saying an earlier session is on record, and no automatic note.
- Enforce alone adds no note. With notes turned on, the agent gets the test command and where it came from.
- No hook fails or writes to stderr.
- The local index is in the config folder, one per project, never in the project.

Rows: `fresh-install-1794693917959.json`. This checks that the install works as documented. It is not a cost or quality result.

## Measured on 0.3.5: picking up where the last session left off

A benchmark of 20 handoffs and 4 controls, written for Snout. Its spec was committed before any session ran (`bench/handoff/spec-benchmark-035.json` for Claude Code, `spec-benchmark-035-codex.json` for Codex). In each handoff, a Claude Code session fixes a small bug in a small JavaScript or Python project and is told to stop for the day. Its prompt also names the next step and two decisions for it. A new session is then asked to continue. It counts as solved only if hidden tests show the next step done with both decisions. In a control, the new session is asked for an unrelated small change and must leave the next step alone. Each new session ran twice in each of three setups:

| New session | Claude Code solved | Codex solved |
| --- | --- | --- |
| Snout 0.3.5, defaults in enforce mode (the left-off note is on) | 38 of 40 | 36 of 40 |
| Snout's trimming only, memory off | 0 of 40 | 0 of 40 |
| No Snout | 0 of 40 | 0 of 40 |

- Without the note, no new session did the next step (0 of 80 for each agent). With it, every new session did (40 of 40 for each agent). Every miss came from two tasks whose wording allows two readings (which total the 50% applies to; whether an alarm stays on). They are counted as misses.
- Per handoff, the setup with the note was ahead of no Snout in 19 and tied in 1 with Claude Code (sign test p = 0.0000038), and ahead in 18 and tied in 2 with Codex (p = 0.0000076). It was never behind.
- Controls: in every setup the new session did the asked change and left the next step alone, 24 of 24 for each agent.
- Claude Code 2.1.306 with Sonnet 5.5, API billed: $4.54 for all 168 sessions. Its own memory was on in every setup and saved nothing after any of the 20 first sessions. Codex 0.163.0 with GPT-6.1 Sol at low effort continued from the same Claude Code first sessions: 144 sessions, $7.24 at list price, billed to a ChatGPT plan.
- Limits: small projects written for this benchmark, one first session per handoff, and the next step existed only in that session's prompt. The same tasks ran once before, on the build before 0.3.5 (Claude Code 39 of 40 with the note, 0 of 40 without); this is a rerun on the release, not a new held-out set. It is not a cost or token result.

Rows: `handoff-live-1794801209802.json`, `handoff-live-1794801485676.json` (Claude Code); `handoff-live-1794803663586.json`, `handoff-live-1794804221393.json` (Codex). Local paths and session ids are replaced in these copies (`bench/publish-results.mjs`).
