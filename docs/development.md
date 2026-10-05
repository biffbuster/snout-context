# Development

For contributors: how the repo is laid out, how accuracy is gated, and what Snout doesn't do yet.

## Layout

| Path | What's there |
| --- | --- |
| `src/gate/` | The classifier: rules, scores, trim-and-outline, Bash read detection |
| `src/ledger/` | Local records (`.snout/*.jsonl`), token estimates, reports |
| `src/spend/` | Measured spend from Claude Code and Codex logs, list prices per model |
| `src/dashboard/` | `snout dashboard`: local server and page |
| `src/cloud/` | `snout login` / `sync`: device login and the daily-totals payload |
| `src/agents/`, `src/mcp.ts` | Codex, Gemini and Cursor adapters; the MCP server |
| `src/cli.ts` | Every hook event and command |
| `.claude-plugin/`, `hooks/`, `commands/`, `skills/` | The Claude Code plugin |
| `eval/` | Hand-labelled accuracy gate (runs in CI) |
| `bench/` | A/B benchmark on real agent sessions, and the 500-file labelling run |
| `dist/` | The bundled CLI, committed so the plugin works on install |
| `cloud/` | Snout Cloud: the hosted team dashboard (Node, Postgres, GitHub sign-in), deployed on Railway. Its own package; see [cloud/README.md](../cloud/README.md) |

The npm package ships only `dist/` and the plugin files; `cloud/` is never published.

## Eval

Accuracy is gated in CI: false-deny at most 2%, flag precision at least 95%. A release check runs
3 tasks on Haiku with Snout off and on, and fails if Snout breaks any task that passes without it.

```bash
npm run eval                                              # accuracy gate
node bench/ab.mjs --tasks cart,orders,deps --model haiku  # agent A/B
```

## Limits

The saving appears on tasks that meet bulk files or produce medium-sized command output; ordinary
tasks cost about the same with or without Snout. The A/B runs cover Sonnet and Haiku on Claude Code
and Codex's default model, on one synthetic repo; real heavy repos are next. Squeeze handles only
commands that succeed (Claude Code can't replace a failed command's output) and stays out of
output over ~30k characters, which Claude Code already saves to a file. Gemini and Cursor adapters
follow each agent's documented hook format and still need live runs. In enforce mode, each gated
read waits about 0.1 s for Node to start.

## Development

```bash
npm install
npm run verify     # typecheck, build, tests, eval, latency benchmark
```

MIT licensed.
