# Current release claims

Every result below was measured on the clean Snout 0.3.7 bundle. `node scripts/check-claims.mjs --strict` fails if any cited file was measured on a different build. Results from older builds are archived and do not describe 0.3.7: [0.3.6](archive/0.3.6/claims.md), [0.3.5](archive/0.3.5/claims.md), [0.3.4](archive/0.3.4/claims.md), [0.3.3](archive/0.3.3/claims.md), [0.3.2](archive/0.3.2/claims.md), [0.3.1](archive/0.3.1/claims.md) and [before 0.3.1](archive/pre-0.3.1/README.md).

## Measured on 0.3.7: fresh install (no model, no network)

Snout is installed the way the README says, into an empty home and config folder: as the Claude Code plugin, and with `npm install -g` and `snout init codex` for Codex. Each agent's hooks then run on stand-in sessions in a new project. All 12 checks pass:

- Installing writes nothing to the home or config folder.
- Observe is the default. In observe the agent gets the session-start line saying an earlier session is on record, and no automatic note.
- Enforce alone adds no note. With notes turned on, the agent gets the test command and where it came from.
- No hook fails or writes to stderr.
- The local index is in the config folder, one per project, never in the project.

Rows: `fresh-install-1795019965996.json`. This checks that the install works as documented. It is not a cost or quality result.

## Not measured on 0.3.7

No agent result has been measured on the 0.3.7 bundle, for either agent.

- **Picking up where the last session left off.** Measured on 0.3.5: with the left-off note, 38 of 40 new Claude Code sessions and 36 of 40 new Codex sessions did the next step with both decisions; with trimming only, or without Snout, none did. Setup, limits and rows are in [the 0.3.5 archive](archive/0.3.5/claims.md#measured-on-035-picking-up-where-the-last-session-left-off). 0.3.6 did not change the note. 0.3.7 changes which session it describes: a session cut off before it finished (Esc, a crash, a closed terminal) is now recorded when the next one starts, and files a session changed through the shell count as its changes. It has not been rerun on 0.3.6 or 0.3.7.

- **Trimming.** The last paired agent result is from 0.3.3: 140 Claude Code sessions on Sonnet over 14 tasks written alongside Snout, −25.0% cost per solved task (95% interval −38.2% to −9.5%). It measured trimming. 0.3.4 changes one trimming rule: a command whose output Claude Code saved to a file no longer counts as reading the files it printed. Setup, limits, raw rows and reports are in [the 0.3.3 archive](archive/0.3.3/claims.md). Codex has no matched off/on cost run.
- **Where you left off, in everyday work.** Those handoffs were built to need the earlier session. Nothing here says how often the note helps in everyday work, or what it saves.

These have no measurement yet:

- The rest of memory: a record of each session, one line at session start saying earlier sessions exist, and search and fetch tools the agent calls when it needs them. Nothing here says memory saves tokens or money on everyday work, or that it improves on its own ([memory](memory.md)).
- `snout import`: commits, PRs, failed CI runs and past sessions in memory search.
- Since 0.3.2: Snout no longer restores facts after a compaction, and trimmed MCP results are saved as plain text at an absolute path.

Each needs its own measurement on a clean bundle before it is claimed anywhere.
