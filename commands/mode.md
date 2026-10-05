---
description: Show or change the Snout mode (observe records only; enforce trims low-value reads)
argument-hint: "[observe|enforce]"
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs" mode $ARGUMENTS`

Snout installs or removes its blocking hook itself (in `.claude/settings.local.json`), so there
is nothing to edit. Tell the user what the output says, in one or two sentences: new sessions
pick up the change, a running one after `/reload-plugins`. The same switch is on the live
dashboard.
