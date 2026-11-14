# Snout 0.3.4 claims (archived)

These results were measured on the clean Snout 0.3.4 bundle and do not describe later releases. Raw rows stay in `bench/ab-results/`. The current release's claims are in [../../claims.md](../../claims.md). Older: [0.3.3](../0.3.3/claims.md), [0.3.2](../0.3.2/claims.md), [0.3.1](../0.3.1/claims.md), [before 0.3.1](../pre-0.3.1/README.md).

## Measured on 0.3.4: fresh install (no model, no network)

Snout is installed the way the README says, into an empty home and config folder: as the Claude Code plugin, and with `npm install -g` and `snout init codex` for Codex. Each agent's hooks then run on stand-in sessions in a new project. All 12 checks pass:

- Installing writes nothing to the home or config folder.
- Observe is the default. In observe the agent gets the session-start line saying an earlier session is on record, and no automatic note.
- Enforce alone adds no note. With notes turned on, the agent gets the test command and where it came from.
- No hook fails or writes to stderr.
- The local index is in the config folder, one per project, never in the project.

Rows: `fresh-install-1794489740543.json`. This checks that the install works as documented. It is not a cost or quality result.
