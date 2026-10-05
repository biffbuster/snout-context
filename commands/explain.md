---
description: Explain why Snout classified a file the way it did
argument-hint: "<path> [--json]"
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs" explain $ARGUMENTS`

Show the output verbatim. This is the plugin's accountability surface: every classification
must be inspectable, so do not paraphrase the reason, the confidence, the band or the
per-label scores. Scores are independent per label; a near miss is shown but never acted on.
