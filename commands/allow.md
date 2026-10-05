---
description: Stop Snout from ever flagging a file or glob
argument-hint: "<path-or-glob>"
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs" allow $ARGUMENTS`

Confirm in one line. Entries added here outrank every built-in rule, including the size
cap, so if the user passes a broad glob (anything with `**` covering much of the repo),
say so plainly rather than silently accepting it.
