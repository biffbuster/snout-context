# Snout

[![npm](https://img.shields.io/npm/v/usesnout)](https://www.npmjs.com/package/usesnout)
[![CI](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml/badge.svg)](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**The context layer for Claude Code and Codex.** Everything your agent reads stays in its context
and is paid for again on every message: lockfiles, generated code, long docs, logs, command output,
MCP results, files it already read. Snout does three things about it:

- **Reads less.** Clutter is kept out and repeat reads become pointers. Your own code always comes
  through in full.
- **Remembers.** Each session leaves a short card; a later prompt that bears on it gets it back, in
  Claude Code or Codex, and the exact facts a compaction summary drops are restored.
- **Shows the bill.** What each session read, kept out and spent, and which instructions, skills and
  MCP servers cost you tokens without being used.

Free. Runs on your machine. Your code never leaves it. No account needed.

| Measured | Result |
| --- | --- |
| Everything on, 12 tasks, 48 headless runs | **−26%** spend (95% CI −38% to −12%), every task still passing |
| Read gate alone, bulk-file tasks, Codex | **−23%** tokens (95% CI −34% to −14%), every task still passing |
| Memory recall on 485 SWE-bench Verified tasks, memory built from past commits | speaks on 58% of tasks and then names a file the fix needed **75%** of the time; with the optional local model, **87%** on the 36% where it speaks |

Each row rebuilds from a results file in this repo, without an API key: [docs/claims.md](docs/claims.md).

Works with Claude Code and Codex, plus Cursor, Gemini CLI and any MCP agent. What Snout can do
depends on each agent's hooks: Claude Code can shorten tool output, while Codex gates shell reads and
records usage. See [agent capabilities](docs/integrations.md).

## Install

Claude Code, in a minute:

```bash
claude plugin marketplace add biffbuster/snout-context
claude plugin install snout@snout-context
```

Then, inside Claude Code:

```
/snout:report           # what it saw and what it would have saved
/snout:mode enforce     # turn trimming on
```

Codex, Cursor, Gemini CLI:

```bash
npm install -g usesnout
snout init codex        # or cursor, gemini
```

Not sure yet? See what in your repo would crowd an agent's context, without installing anything:

```bash
npx usesnout scan
```

## What you'll see

Snout starts in **observe** mode: it records and changes nothing. After your first session it tells
you what it would have kept out and what that would have saved. From then on:

- `/snout:report` or `snout report`: what was read, kept out and saved, with spend
- `snout dashboard`: the same, live in your browser
- `/snout:statusline`: a token counter on screen
- `snout memory`: what earlier sessions left for the next one

## How it works

Before your agent reads a file or sees a tool's output, Snout checks what it is, locally. The check
itself takes under a millisecond. In Claude Code the gate talks to a small local Snout server on
127.0.0.1 that starts with your session and stops when no project uses it; if it is ever down, the
agent carries on ungated. Elsewhere each hook call is a short Node process, which adds a fraction of a
second, mostly Node's startup.

| What enters context | What the agent gets |
| --- | --- |
| Your code, config and instruction files (CLAUDE.md, AGENTS.md, skills) | Everything, in full |
| Long markdown docs, specs and changelogs | The opening and a map of its sections with line numbers; any section is one read away |
| Long logs | The last lines and where earlier errors are |
| Something it already read, unchanged (a file, a `cat`, an identical MCP or command result) | A pointer to the copy already in its context |
| Results from any MCP server (issue lists, wiki pages, browser snapshots, query rows) | The structure and first items, per server; the full result is saved |
| Output of a passing test, install, build or search | The problems and the summary, grouped by file; the full log is saved |
| Generated, vendored and built files | The first lines, an outline, and a search hint |
| `.env` and key files | Snout asks you first |
| A new session starts | A short repo brief: what earlier sessions keep finding (the test command that works, missing tools, the files most work touches, what you have said more than once). Nothing until a fact shows up twice |
| Your request bears on an earlier session in this repo | A short brief: what that session was asked, the files it changed, its commits, the test command that worked, what the user told it. Nothing when nothing matches |
| Your request names code in the repo (opt-in: `snout map on`) | Up to four paths that declare or use it, so the agent opens them instead of searching; never file contents |

When no rule is sure, the file is read in full, and every error lets the read through. Any ranged
read (a specific set of lines) comes back exactly as asked.

## Memory between sessions

Each finished session leaves a short card in `.snout/memory/`: what was asked, the files it changed,
its commits, the test command that worked and what you told it. When a later prompt bears on one,
in Claude Code or in Codex, the agent gets that card. A session started in Codex can pick up from
one finished in Claude Code, and the reverse. After a compaction, Snout restores the exact facts the
summary tends to lose. Recall stays silent when nothing matches.

## Results

Real headless agent sessions on test projects we built, Snout off vs. on, each task graded by its
own test. Spend is the agent's reported cost at API list prices. Raw rows for every line are in
[`bench/ab-results/`](bench/ab-results); [method and caveats](docs/benchmark.md).

| | Result |
| --- | --- |
| Long multi-step sessions with docs, logs and MCP connectors (Haiku, 11 tasks, 66 runs) | **−22%** input tokens, **−19%** spend (95% CI −36% to +4%), 33/33 passing; **−52%** on a codebase-wide rename, **−43%** on a task answered from a long handbook |
| Everything on (Haiku, 12 tasks, 48 runs) | **−26%** spend (95% CI −38% to −12%), 24/24 passing; **−33%** on the 8 tasks that meet bulk files (CI −45% to −18%) |
| Bulk-file tasks, read gate alone (5 tasks) | spend **−24%** Haiku (50 runs, CI −45% to +3%) · **−23%** Sonnet (20 runs, CI −47% to +7%) · tokens **−23%** Codex (30 runs, CI −34% to −14%) |
| Single examples: a lockfile read · a passing test run's output · a 60-issue MCP result | tokens **−90%** · lines **−87%** · characters **−74%** |
| Tasks with nothing to trim | within noise (−5% to +1% across runs) |

These projects were built to contain the bulk Snout trims, so the numbers show what it saves when
that bulk is on the agent's path, not the average saving on any repo. Single runs of the same task
vary by 20–40%, and an interval that crosses zero means the saving is likely but not proven. Every
spend row above rebuilds from its results file, without an API key: [docs/claims.md](docs/claims.md);
the single examples and the token breakdowns are in [docs/benchmark.md](docs/benchmark.md).

## CLI

```bash
snout                   # status: what's been kept out, and what it saved
snout scan              # what in this repo would crowd your agent's context
snout audit             # MCP servers: which are used, what each one's results cost and saved
snout audit context     # instructions, skills and AI-written docs: per-session cost, last use, dead weight
snout memory            # what earlier sessions left: task, files, commits (`snout recall "<q>"` to test a prompt)
snout memory model install  # optional local model: recall by meaning as well as words
snout map on            # opt-in: suggest the files your prompt names (paths only)
snout report            # what was read, kept out and saved, with spend
snout dashboard         # live savings in your browser
snout mode enforce      # start trimming (observe = record only)
snout explain <file>    # why a file was trimmed; `snout allow <file>` keeps it whole
```

In Claude Code: `/snout:report`, `/snout:mode`, `/snout:explain`. More commands: [docs/configuration.md](docs/configuration.md).

## Uninstall

```bash
# Claude Code
snout mode observe                          # removes the gate from .claude/settings.local.json
claude plugin uninstall snout@snout-context

# Codex, Cursor, Gemini CLI: removes only Snout's hooks from that agent's config in this project
snout init codex --remove                   # or cursor, gemini

npm uninstall -g usesnout
```

Snout's records live in `.snout/` in each project; delete the folder to remove them. Settings and the
optional local model live in `~/.config/snout` (`%APPDATA%\snout` on Windows).

## Access

Everything above is free and local: trimming, session memory, memory after compaction, spend
tracking, project audits and the local dashboard. For teams, or to try what comes next, reach out for
access at [usesnout.xyz](https://usesnout.xyz).

## Privacy

Snout reads a file's path, size and first 2 KB to classify it, in memory, and records its decisions
and a short card per session (`.snout/memory/`) to `.snout/` in your project as plain files you can read or delete. It makes no network calls unless
you turn on an optional feature that needs one: the prompt coach, or the one-time download of the
local memory model. Releases are built and published from GitHub Actions with npm provenance.
Details: [SECURITY.md](SECURITY.md) · [docs/privacy.md](docs/privacy.md).

## Docs

| | |
| --- | --- |
| [Quickstart](docs/quickstart.md) | First session, step by step |
| [Integrations](docs/integrations.md) | Setup for each agent and MCP |
| [Configuration](docs/configuration.md) | Modes, allow lists, advanced commands |
| [Benchmark](docs/benchmark.md) | How the results were measured |
| [Troubleshooting](docs/troubleshooting.md) | When something doesn't look right |
| [Development](docs/development.md) | Repo layout, evals, limits, contributing |

MIT licensed.
