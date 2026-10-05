---
description: Show what Snout classified this session and what it cost in context
argument-hint: "[--all] [--by-agent]"
---

Run the Snout report and show the user its output verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs" report $ARGUMENTS`

Present the table as-is. Do not re-summarise the numbers or recompute them. If the report
says no reads were recorded, tell the user the plugin is installed and watching, and
that reading a few files will populate it. `--all` covers every session in the ledger.
`--by-agent` adds a BY AGENT table: low-value reads per subagent in an orchestration. When
subagents read files, a REDUNDANCY section shows reads that repeated another agent's read.
