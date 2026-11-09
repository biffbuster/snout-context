# Current release claims

Every result below was measured on the clean Snout 0.3.3 bundle. `node scripts/check-claims.mjs --strict` fails if any cited file was measured on a different build. Results from older builds are archived and do not describe 0.3.3: [0.3.2](archive/0.3.2/claims.md), [0.3.1](archive/0.3.1/claims.md) and [before 0.3.1](archive/pre-0.3.1/README.md).

## Measured on 0.3.3: fresh install (no model, no network)

Snout is installed the way the README says, into an empty home and config folder: as the Claude Code plugin, and with `npm install -g` and `snout init codex` for Codex. Each agent's hooks then run on stand-in sessions in a new project. All 12 checks pass:

- Installing writes nothing to the home or config folder.
- Observe is the default, and in observe the agent gets no memory text.
- Enforce alone adds no note. With notes turned on, the agent gets the test command and where it came from.
- No hook fails or writes to stderr.
- The local index is in the config folder, one per project, never in the project.

Rows: `fresh-install-1794240029327.json`. This checks that the install works as documented. It is not a cost or quality result.

## Not measured on 0.3.3

No cost, token or success-rate result has been measured on 0.3.3, for either agent. The last paired agent result is from 0.3.1: 140 Claude Code sessions on Sonnet over 14 tasks written alongside Snout, −25.5% cost per solved task (95% interval −39.1% to −7.6%). It measured trimming, and it has not been rerun since. Setup, limits, raw rows and reports are in [the 0.3.1 archive](archive/0.3.1/claims.md). Codex has no matched off/on cost run.

These have no measurement yet:

- Memory as it works now: a record of each session, one line at session start saying earlier sessions exist, and search and fetch tools the agent calls when it needs them. Nothing here says memory saves tokens or money, or that it improves on its own ([memory](memory.md)).
- `snout import`: commits, PRs, failed CI runs and past sessions in memory search.
- Since 0.3.2: Snout no longer restores facts after a compaction, and trimmed MCP results are saved as plain text at an absolute path.

Each needs its own measurement on a clean bundle before it is claimed anywhere.
