# Configuration

Everything is optional. `.snout/config.json` is created only when you change something, and
stores only the keys you set, so upgrades can move the defaults under you.

```jsonc
{
  "mode": "observe",              // observe | advise | enforce
  "sizeCapBytes": 200000,
  "alwaysAllow": ["README.md", "CLAUDE.md", "AGENTS.md"],
  "alwaysDeny":  ["**/*.lock"],
  "redact":      ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "..."],
  "redactExempt": ["**/.env.example", "**/.env.sample", "..."],
  "repeatReads": true,            // what the agent already has, unchanged, is not sent again
  "longDocs": true,               // long docs: opening + section map; long logs: the tail
  "output": "normal"              // "concise" adds one short output-style instruction (opt-in)
}
```

`repeatReads` (enforce mode, default on): what an agent already has is not sent again. A read
of lines it already read (or of a file it read whole), a `cat` of a file it already read, and an
MCP or command result identical to one it already received come back as a short pointer to the
copy in its context. Claude Code already skips exact repeats of a Read itself, so for Claude Code
Snout handles the cases it misses; for other agents it handles all of them. Each agent and
subagent is tracked separately, and any edit, size or mtime change, or compaction gets the full text.

`longDocs` (enforce mode, default on): a whole-file read of a long markdown doc, spec or changelog
(over ~8k tokens) returns its opening and a map of its sections with line numbers; a long log
returns its last lines and the line numbers of earlier errors. Any ranged read comes back as
asked, and instruction files (CLAUDE.md, AGENTS.md, README, anything under `.claude/` and
similar) are always read whole.

That is every key the shipped code reads. Keys for later phases — a model name, a tier-2
budget, context-injection limits — are deliberately **absent** rather than present and
inert: a configuration key that silently does nothing is worse than a missing one, because
you believe you have turned something on. An earlier version shipped six of them.

## Advanced commands

| Command | What it does |
| --- | --- |
| `snout spend [--all] [--days N]` | Spend per model from the agents' own usage logs; `--all` totals every project on this machine |
| `snout coach "<prompt>"` / `snout coach off\|tip\|jev` | Prompt coach: a tip (to you only) when a task prompt doesn't say which file, what should happen or how to check it |
| `snout apply` | Suggested changes from your own history, previewed, applied with `--yes`, undoable with `--undo` |
| `snout statusline` | A one-line counter for your terminal status bar |
| `snout doctor` | Checks that Snout is installed and its hooks are firing |
| `snout sync [--dry-run]` / `snout logout` | Sync to Snout Cloud now, or print exactly what would be sent / stop syncing |
| `snout init <agent>` | Hook setup for Codex, Cursor or Gemini CLI in this project |
| `snout mcp` | MCP server (`snout_read`, `snout_classify`) for agents without read hooks |
| `snout reset` | Clear this project's local records |
| `snout audit [--measure] [--days N]` | MCP servers your agents load, how often each was used, and the unused ones that still add their tool list to every request (with how to turn them off). `--measure` starts each local server once to count its tool-list tokens |
| `snout output concise\|normal` | Opt-in concise output: one short instruction at session start to skip recaps and restated code. Off by default |

Cloud agents use `SNOUT_TOKEN` (a workspace key from the team dashboard) instead of `snout login`.

## User defaults and precedence

`~/.snout/config.json` (or `$SNOUT_HOME/config.json`) holds defaults every project inherits —
the same keys as the project file. Resolution, last wins, key by key: built-in defaults →
user file → project `.snout/config.json` → environment. A list key set in the project
replaces the user's list for that key rather than merging with it. `/snout:doctor` shows
which files exist and where the current mode comes from.

Commands write one key in one file and leave everything else as written: an environment
override is never persisted, and user defaults are never copied into a project.

## Suggested changes: `snout apply`

`snout apply` lists changes derived from your own ledger, each with the evidence, the exact
change and the expected effect. `snout apply <n>` previews one; nothing is written until
you run `snout apply <n> --yes`. Config tips accept `--user` to write to `~/.snout` instead.
`snout apply --undo` reverts the most recent change, and `snout apply` later shows what each
change measurably did (low-value tokens per session, before vs after).

## Environment variables

| Variable | Effect |
| --- | --- |
| `SNOUT_MODE` | Overrides `mode` for one session. |
| `SNOUT_DISABLE` | Any value forces `observe`. The kill switch. |
| `SNOUT_DEBUG` | Diagnostics to stderr. |
| `TYPESAFE_API_KEY` | Lets `snout coach jev` score prompts with TypeSafe's Jev. Optional. |

## The three lists

They are evaluated in this order, and the order is the policy:

0. **`redactExempt`** — checked before everything. `.env.example` is committed on purpose,
   read constantly and holds nothing; treating it as a secret is pure friction.
1. **`redact`** — credential patterns. Highest authority. These files are never sent to any
   API and never silently allowed, in any mode. A `redact` match outranks `alwaysAllow`:
   you cannot allow-list your way into leaking a key.

   These name credential **file shapes**, not files that mention credentials. Two substring
   patterns (`secret` and `credential` anywhere in a path) used to be defaults and were
   wrong: they matched `src/secrets-manager.ts` and `docs/secret-handling.md`, ordinary
   source and docs you then got prompted about on every read — and because this rule ignores
   mode, there was no way to switch it off. A substring cannot tell a key from an essay
   about keys.
2. **`alwaysAllow`** — outranks every built-in rule, including the size cap. A broad
   pattern here silently un-classifies large parts of your repository, so keep it short.
   `/snout:allow <path>` appends to it.
3. **`alwaysDeny`** — for things the built-in rules do not already cover. Adding something
   the rules handle is how two policies end up disagreeing, since the list runs first and
   overrides the rule's more nuanced verdict.

## Ignore files

`.snoutignore` in the project root is read and appended to the deny list: one glob per line,
`#` starts a comment, 500 patterns maximum.

`.gitignore` is **not** read. An earlier version of this page said it was, which was false.
Implementing gitignore semantics properly — negation, directory-only suffixes, nested
files — is a project of its own, and approximating them would put a second, disagreeing
policy in front of the rules.

## Glob support, and its limits

`**`, `*`, `?` and `[abc]` classes, matched against a forward-slash path relative to the
project root. A bare directory name (`node_modules`) also matches everything beneath it.

This is **not** full gitignore syntax. Negation (`!pattern`), directory-only markers
(`build/`) and nested ignore files are not implemented. If you need exact behaviour, list
paths explicitly rather than relying on a clever pattern.

## Turning it off

```
/snout:mode observe            # stop blocking, keep reporting
export SNOUT_DISABLE=1         # force observe for a session
claude plugin uninstall snout@snout-context
```

Uninstalling leaves `.snout/` in place. Delete the directory to remove your history.
