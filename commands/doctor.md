---
description: Check that Snout is installed and working
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs" doctor`

Show the output. Read the `HOOKS SEEN` block first — it is the only part that distinguishes
a plugin that is not wired in from one that simply had nothing to flag:

- **none** — the plugin is not registered in this session. `/plugin` should list it as
  enabled, and Claude Code must then be restarted: hooks are registered at session start.
- **post-tool never, stop never** (or older than session-start) — the session is new and
  has probably not used the Read tool yet. Read one file and run doctor again.
- **post-tool never, stop recent** — a turn has finished and no read reached the
  classifier. The matcher covers Read, NotebookRead, Bash, Grep, Glob, web and MCP tools, so this
  usually means the running plugin is an older copy: check `bundle`, reinstall, restart.
- **all recent, `decisions` 0** — it is working and has genuinely flagged nothing yet.

`bundle` names the copy that is running. `installed copy` means edits to a local checkout
have no effect until the plugin is reinstalled. See `docs/troubleshooting.md`.
