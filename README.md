# Snout

[![npm](https://img.shields.io/npm/v/usesnout)](https://www.npmjs.com/package/usesnout)
[![CI](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml/badge.svg)](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Better context for coding agents, carried across sessions. Snout keeps lockfiles, generated code,
long logs, bulky MCP results and repeat reads out of Claude Code's and Codex's context. It records
what each session did, so the next session, in either agent, can look it up. It also shows what
each session spent.

Runs locally, no account. On our 14-task benchmark, Snout 0.3.3 cut Claude Code's cost per solved
task by 25.0% ([details](docs/claims.md)). That result is for trimming. Memory is not measured yet.

## Install

Claude Code:

```bash
claude plugin marketplace add biffbuster/snout-context
claude plugin install snout@snout-context
```

Codex, Cursor or Gemini CLI:

```bash
npm install -g usesnout
snout init codex        # or cursor, gemini
```

Snout starts in observe mode: it records what it would do and changes nothing, apart from a short
tip when a prompt doesn't say which file or what should happen (`snout coach off` stops it). Turn it
on with `snout mode enforce`, or `/snout:mode enforce` in Claude Code.

**Memory is something the agent asks for.** On this machine, Snout records each session: what was
asked (decisions included), what changed, the test command and its result, a failure it got past,
and what it left unfinished. It also keeps the notes you save. `snout import` adds the project's
history from before Snout was installed: six months of commits and earlier Claude Code and Codex
sessions, plus PRs and failed CI runs once you run `snout import github on`. Each record keeps its
date and a link to its source. An agent can propose a one-line lesson after a test passed, or from
a decision or correction you gave. It is shown to no session until you approve it with
`snout memory review` ([lessons](docs/memory-lessons.md)).

In enforce mode, a new session starts with one line saying that earlier sessions are on record and
how to search them. The agent then has `snout_memory_search`, `snout_memory_fetch` and
`snout_memory_propose`, plus a short skill that says when to search and when to skip. The Claude
Code plugin adds them, and `snout init codex` adds them for Codex. A search returns up to five
current records, approved lessons first, each with where it came from, and the agent uses what
helps.

Nothing from memory is added to a prompt on its own. `snout memory notes on` does that, and it stays
off by default because choosing a note for a prompt that didn't ask for one wasn't reliable enough.
Whether memory lowers cost per task is not measured yet: in a 10-task pilot per agent, an earlier
version did not ([memory](docs/memory.md)).

Add `.snout/` to your `.gitignore`. It holds this project's session records, including the start of
your requests ([what is stored](docs/privacy.md)).

## Snout in Claude Code

![Snout, the pixel anteater](art/snout-preview.gif)

With Claude Code 2.1.287 or later, the plugin switches to the Snout Pink theme once (Snout Pink
(light) if your theme is light). Snout sits above the prompt until your first message of each
session. In a repo where Snout records, a dim line beside Snout shows how much context is used, the
tokens Snout kept out and what memory holds for the repo. While Claude works, a tongue flicks after
the spinner word.

- `/snout` opens Snout in a pane.
- `/snout off` hides Snout and the tongue. `/snout on` brings them back.
- `/snout pink off` puts back the theme you had before. `/snout pink on` turns pink on again.

Both switches are also in `/config`, as "Show Snout" and "Snout Pink theme". The Desktop app and
VS Code show Snout as colored text. If your organization turns mods off, both themes are still in
`/theme`. Codex has no themes or mods, so none of this applies there.

## Examples

```bash
npx usesnout scan       # what in this repo would crowd an agent's context (no install)
snout report            # what each session read, kept out and spent
snout audit             # MCP servers: which are used and what their results cost
snout audit context     # instructions, skills and docs loaded every session but never used
snout import            # past commits and sessions into memory (PRs and CI runs with gh)
snout memory            # session records, and whether agents searched them
snout explain <file>    # why a file was trimmed; `snout allow <file>` keeps it whole
snout dashboard         # the same numbers, live in your browser
```

Your own code, config and instruction files always come through in full. If Snout is unsure or
hits an error, the read goes through unchanged.

## Uninstall

```bash
snout mode observe
claude plugin uninstall snout@snout-context   # Claude Code
snout init codex --remove                     # Codex, Cursor, Gemini CLI
npm uninstall -g usesnout
```

Records live in `.snout/` in each project; delete the folder to remove them. In Claude Code, run
`/snout pink off` before you uninstall to get your earlier theme back.

## Docs

[Quickstart](docs/quickstart.md) · [Memory](docs/memory.md) · [Integrations](docs/integrations.md) ·
[Configuration](docs/configuration.md) · [Benchmark](docs/claims.md) ·
[Privacy](docs/privacy.md) · [Troubleshooting](docs/troubleshooting.md) ·
[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

MIT licensed.
