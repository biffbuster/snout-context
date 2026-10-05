---
description: Per-label distribution for a folder — what each label would cost and which threshold band it falls in
argument-hint: "[dir] [--deny 0.9] [--ask 0.5] [--top 10] [--json]"
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs" scan $ARGUMENTS`

Show the output verbatim. It is a static scan: the same rules the hooks run, applied to
every file under the folder, with nothing recorded. The token column is exposure (every
file read whole), not what a session spent — `/snout:report` has that. `--deny` and `--ask`
preview other thresholds without changing any setting.
