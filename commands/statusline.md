---
description: Put Snout's live token counter in the terminal status line
---

The user wants the live counter on screen. The status line is a user setting rather than
something a plugin can install on its own, so do this:

1. Read their `~/.claude/settings.json` (create it as `{}` if it does not exist).
2. Add or update the `statusLine` key:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs\" statusline"
  }
}
```

3. If they already have a `statusLine` command, do NOT overwrite it. Show them what they
   have, and offer to wrap both — theirs first, then ` · ` and the Snout output.

Tell them it takes effect on the next session or after `/reload-plugins`, and that the
counter reads `flagged` in observe mode and `saved` once they enable enforcement.
