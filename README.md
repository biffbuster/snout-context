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

Free. Runs on your machine. No account needed. Nothing is sent anywhere unless you turn on an
opt-in feature that says so.

On 0.3.1, across 140 Claude Code sessions on Sonnet, Snout cut cost per solved task by 25.5%
(95% interval −39.1% to −7.6%), and all 70 attempts passed in each arm. The 14 tasks were written
alongside Snout, so this is a regression benchmark, not a promise for every repo. Setup, raw rows
and limits: [docs/claims.md](docs/claims.md).

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

Opt-in: `snout memory judge jev` sends up to six of your sentences per turn to TypeSafe's Jev model
(needs `TYPESAFE_API_KEY`). Those it rates as lasting preferences are saved to
`.snout/memory/preferences.json` and shown at the start of later sessions. `snout memory prefs`
lists them; `snout memory prefs forget <n>` removes one.

## Results

Claude Code, Sonnet, 14 tasks × 5 repeats with Snout off and on, 140 sessions on 0.3.1:

| Tasks | Solved, off → on | Cost per solved task | 95% interval |
| --- | --- | --- | --- |
| All 14 | 70/70 → 70/70 | −25.5% | −39.1% to −7.6% |
| 10 with bulk to read | 50/50 → 50/50 | −30.9% | −44.6% to −10.2% |
| 4 controls | 20/20 → 20/20 | −0.3% | −10.6% to +6.7% |

The tasks were written alongside Snout, so read this as a release regression result. 14 tasks are
too few to claim no quality loss, and one task (`deps`) cost 20% more with Snout on. Codex has no
matched 0.3.1 run yet. Anyone can rebuild the report from the raw rows without a key:
`node bench/report.mjs bench/ab-results/run-sonnet-1792440413748.json --margin 5`.
More: [claim ledger](docs/claims.md), [benchmark status](docs/benchmark.md),
[historical results](docs/archive/pre-0.3.1/README.md).

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
you turn on an optional feature that needs one: the prompt coach, the memory preference judge, or
the one-time download of the local memory model. Releases are built and published from GitHub Actions with npm provenance.
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
