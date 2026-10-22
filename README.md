# Snout

[![npm](https://img.shields.io/npm/v/usesnout)](https://www.npmjs.com/package/usesnout)
[![CI](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml/badge.svg)](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The context layer for Claude Code and Codex. Snout keeps lockfiles, generated code, long logs,
bulky MCP results and repeat reads out of your agent's context, remembers what earlier sessions
learned, and shows what each session spent.

Runs locally, no account. On our 14-task benchmark, Snout 0.3.1 cut Claude Code's cost per solved
task by 25.5% ([details](docs/claims.md)). Changes made since 0.3.1, including shared notes, are not
measured yet.

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

Snout starts in observe mode: it records what it would do and changes nothing. Turn it on with
`snout mode enforce`, or `/snout:mode enforce` in Claude Code.

## Examples

```bash
npx usesnout scan       # what in this repo would crowd an agent's context (no install)
snout report            # what each session read, kept out and spent
snout audit             # MCP servers: which are used and what their results cost
snout audit context     # instructions, skills and docs loaded every session but never used
snout memory            # what earlier sessions left for the next one
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

Records live in `.snout/` in each project; delete the folder to remove them.

## Docs

[Quickstart](docs/quickstart.md) · [Integrations](docs/integrations.md) ·
[Configuration](docs/configuration.md) · [Benchmark](docs/claims.md) ·
[Privacy](docs/privacy.md) · [Troubleshooting](docs/troubleshooting.md) ·
[Development](docs/development.md)

MIT licensed.
