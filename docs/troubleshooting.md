# Troubleshooting

## `/snout:report` says no decisions after I have read files

Run `/snout:doctor` and read the `HOOKS SEEN` block. It answers the question that "0
decisions" cannot: did a hook run at all?

| `HOOKS SEEN` says | What it means |
| --- | --- |
| `none` | The plugin is not registered in this session. Follow the steps below. |
| `post-tool never`, `stop never` (or older than `session-start`) | The session is new and has probably not used the Read tool yet. Read one file and run doctor again. |
| `post-tool never`, `stop` recent | A turn has finished and no read reached the classifier. The matcher covers Read, NotebookRead, Bash, Grep, Glob, web and MCP tools, so this usually means the running plugin is an older copy — check `bundle`, reinstall and restart. |
| all recent | It is working and has genuinely flagged nothing yet. |

Also check `bundle`. `installed copy` means the running plugin is the snapshot under
`~/.claude/plugins/cache/`, not your checkout — edits to `src/` do nothing until you
reinstall the plugin and restart.

If `HOOKS SEEN` is `none`, the hooks are not firing:

1. `/plugin` — is Snout listed and enabled?
2. Restart Claude Code or run `/reload-plugins`. Plugin hooks load at session start.
3. `/snout:doctor` — it prints the project directory it resolved. If that is not your
   project, the hook payload is not reaching us.
4. `node --version` — must be 20 or newer. The hook is `node "…/dist/snout.mjs"`, so `node`
   has to be on the PATH of the shell Claude Code spawns. A Node managed by `nvm` or
   `fnm` in an interactive-shell-only setup is the usual cause.
5. Check `.snout/errors.jsonl`.

## Nothing is blocked even though rules are matching

That is `observe` mode, which is the default and is working as designed. `/snout:report`
shows what it *would* have saved. `/snout:mode advise` when you want it to act.

## It blocked a file I needed

`/snout:allow <path>` — it will never be flagged again. Then tell us: a file the agent
genuinely needed is the failure mode that matters most, and the rule that caught it is
probably too broad.

`/snout:mode observe` turns off all blocking immediately. `export SNOUT_DISABLE=1` is the
harder kill switch.

## `/snout:mode enforce` says it worked but nothing is blocked

Run `/snout:doctor`. If it says `blocking hook: not installed`, the `PreToolUse` entry never
made it into `.claude/settings.json`. Run `/snout:mode enforce` again — installing that hook
is part of the command, not part of the plugin.

## A read feels slower

Only gated reads are slow, and only when the blocking hook is installed. Each one spawns a
short-lived Node process:

| | measured |
| --- | --- |
| our classification work | 0.007–0.065 ms |
| bare `node -e 0` on a 2020 Intel i5 | ~125 ms |
| whole hook process | 50 ms (fast machine) to ~380 ms (that i5, via a shell) |

Almost all of it is Node start-up, which no change inside the plugin can remove.

`/snout:mode observe` removes the blocking hook and keeps the reporting, at zero added
latency. Removing the process per decision entirely needs a long-running HTTP-hook sidecar,
which is planned.

## `.snout/` appeared somewhere unexpected

It should only ever be created in the project directory the hook payload names. If you find
one elsewhere, that is a bug worth reporting — include `.snout/errors.jsonl`.

## Development: my changes to the plugin are not taking effect

Plugin updates are version-gated. `claude plugin update` is a no-op when `version` in
`.claude-plugin/plugin.json` has not changed, so during development:

```bash
npm run build
claude plugin uninstall snout@snout-context
claude plugin install   snout@snout-context
```

Then restart Claude Code. Forgetting `npm run build` is the other half of this problem:
hooks run `dist/`, never `src/`.
