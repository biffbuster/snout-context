# Snout

[![npm](https://img.shields.io/npm/v/usesnout)](https://www.npmjs.com/package/usesnout)
[![CI](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml/badge.svg)](https://github.com/biffbuster/snout-context/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Context gating and token optimization for coding agents.** Everything your agent reads stays in
its context and is paid for again on every message: long markdown docs, logs, command output, MCP
results, files it already read. Snout gates what goes in, so the agent gets what it needs, sessions
last longer and every task costs less. Your own code always comes through in full.

```bash
npm install -g usesnout
snout scan              # how much of this repo would crowd your agent's context
```

Free and local: no account, and your code never leaves your machine. Works with Claude Code, Codex,
Cursor, Gemini CLI and any MCP agent.

## Install

```bash
# Claude Code
claude plugin marketplace add biffbuster/snout-context
claude plugin install snout@snout-context

# Codex, Cursor, Gemini CLI
npm install -g usesnout
snout init codex        # or cursor, gemini
```

Snout starts in **observe** mode and only records. After your first session it tells you what it
would have saved; `snout mode enforce` turns it on.

## How it works

Before your agent reads a file or sees a tool's output, Snout checks what it is, locally. The check
itself takes under a millisecond; each hook call is a short Node process, so it adds a fraction of a
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
| Your request names code in the repo (opt-in: `snout map on`) | Up to four paths that declare or use it, so the agent opens them instead of searching; never file contents |

When no rule is sure, the file is read in full, and every error lets the read through. Any ranged
read (a specific set of lines) comes back exactly as asked.

## Results

Real headless agent sessions on test projects we built, Snout off vs. on, each task graded by its
own test. Spend is the agent's reported cost at API list prices. Raw rows for every line are in
[`bench/ab-results/`](bench/ab-results); [method and caveats](docs/benchmark.md).

| | Result |
| --- | --- |
| Long multi-step sessions with docs, logs and MCP connectors (Haiku, 11 tasks, 66 runs) | **−22%** input tokens, **−19%** spend (95% CI −37% to +6%), 33/33 passing; **−52%** on a codebase-wide rename, **−43%** on a task answered from a long handbook |
| Spend on tasks that meet bulk files, everything on (Haiku, 12 tasks, 48 runs) | **−33%**, 24/24 passing |
| Bulk-file tasks, read gate alone | spend **−24%** Haiku (90 runs) · **−23%** Sonnet (36 runs) · tokens **−23%** Codex (60 runs) |
| Single examples: a lockfile read · a passing test run's output · a 60-issue MCP result | tokens **−90%** · lines **−87%** · characters **−74%** |
| Tasks with nothing to trim | within noise (−5% to +1% across runs) |

These projects were built to contain the bulk Snout trims, so the numbers show what it saves when
that bulk is on the agent's path, not the average saving on any repo. Single runs of the same task
vary by 20–40%.

## CLI

```bash
snout                   # status: what's been kept out, and what it saved
snout scan              # what in this repo would crowd your agent's context
snout audit             # MCP servers: which are used, what each one's results cost and saved
snout audit context     # instructions, skills and AI-written docs: per-session cost, last use, dead weight
snout map on            # opt-in: suggest the files your prompt names (paths only)
snout report            # what was read, kept out and saved, with spend
snout dashboard         # live savings in your browser
snout mode enforce      # start trimming (observe = record only)
snout explain <file>    # why a file was trimmed; `snout allow <file>` keeps it whole
snout login             # connect to Snout Cloud
```

In Claude Code: `/snout:report`, `/snout:mode`, `/snout:explain`. More commands: [docs/configuration.md](docs/configuration.md).

## Snout Cloud

One dashboard for your team's agents: savings and real spend by person, project, coding agent and
model. Cloud agents (CI, Claude Code on the web, Codex cloud) connect with a workspace key set as
`SNOUT_TOKEN`. Only per-day totals are sent, never code; `snout sync --dry-run` shows exactly what.

| Plan | Price | Includes |
| --- | --- | --- |
| **Free** | $0 | Everything local, unlimited. Cloud dashboard for you or a team of up to 10: all projects, 90 days of history, 3 cloud-agent keys, 500 agent runs a day |
| **Team** | $8 per developer / month, billed yearly ($10 monthly) | For larger teams: unlimited people, a year of history, unlimited keys, 5,000 agent runs a month included, then $5 per 10,000 |
| **Enterprise** | Contact us | SSO, audit log, self-hosting |

Creating a team is invite-only while in beta. Sign in at [app.usesnout.xyz](https://app.usesnout.xyz).

## Privacy

Snout reads a file's path, size and first 2 KB to classify it, in memory, and records its decisions
to `.snout/` in your project as plain files you can read or delete. It makes no network calls unless
you run `snout login`. Releases are built and published from GitHub Actions with npm provenance.
Details: [SECURITY.md](SECURITY.md) · [docs/privacy.md](docs/privacy.md).

## Docs

| | |
| --- | --- |
| [Quickstart](docs/quickstart.md) | First session, step by step |
| [Integrations](docs/integrations.md) | Setup for each agent and MCP |
| [Configuration](docs/configuration.md) | Modes, allow lists, advanced commands |
| [Teams](docs/teams.md) | Snout Cloud, organizations, cloud agents |
| [Benchmark](docs/benchmark.md) | How the results were measured |
| [Troubleshooting](docs/troubleshooting.md) | When something doesn't look right |
| [Development](docs/development.md) | Repo layout, evals, limits, contributing |

## Uninstall

```bash
snout mode observe && snout logout
claude plugin uninstall snout@snout-context
npm uninstall -g usesnout
rm -rf .snout ~/.config/snout
```

MIT licensed.
