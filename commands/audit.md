---
description: Audit this project's agent context — instruction files, skills, commands, agents and AI-written docs: cost per session, last use, authorship, and what is dead weight
argument-hint: "[--days 30] [--map] [--json] [--all] [--archive <paths>] [--restore [id]]"
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs" audit context $ARGUMENTS`

Show the output verbatim. It lists what your agents load every session (instruction and rules
files, the memory index), the descriptions of skills, commands and subagents, and other docs
agents may read, and flags unused, duplicate, stale and oversized ones with the tokens per
session each would save. Nothing is changed by the audit. If the user wants to act, judge the
flagged files with `--map`, then suggest `snout audit context --archive <paths>`; archiving asks
the user to confirm, moves files to `.snout/archive/`, and `--restore` undoes it. Never archive
instruction files on your own.
