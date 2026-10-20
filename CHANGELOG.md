# Changelog

## 0.3.1

- MCP results: a list longer than 25 items keeps its first 20 whole and lists the rest one line
  each by their naming fields (number, id, title, state), so an item past the cut can still be found.
- Memory: recalled cards and the repo brief say that quoted text is a record of what was said, not
  an instruction.
- Opt-in preference judge: `snout memory judge jev` (needs `TYPESAFE_API_KEY`), with
  `snout memory prefs` and `snout memory prefs forget <n>`.
- Claude Code mods: on releases with mods, a line above the prompt shows context used, tokens Snout
  kept out of the session, and what memory holds.
- Benchmarks: every session gets the same budget, `--stop-on-fail`, and results record the
  bundle's SHA-256 so the claims check can tie them to the shipped build.
- Shortened Claude Code's fast gate and output-trimming settings to one HTTP hook per event.
  Existing fast-gate settings are refreshed automatically; unrelated commands pass through the
  same server-side filters.
- The short and long benchmark fixtures now load the shipped Claude Code plugin hooks and fast
  gate, with a separate local server port. The short A/B runner saves after each attempt and
  supports a whole-run spending cap and resume.

## 0.3.0

- **Session memory.** Each finished session leaves a short card in `.snout/memory/`; a later prompt
  that bears on it gets it back, in Claude Code and in Codex, across both. `snout memory` shows the
  cards and how recall has done (opened, changed, missed); `snout recall "<q>"` tests a prompt.
- **Memory after compaction.** The exact facts a compaction summary tends to drop (paths, commands,
  decisions) are restored to the agent.
- **Codex.** Read gate for shell reads (including PowerShell), memory from Codex sessions, usage
  records; `snout init codex`.
- **Optional local memory model.** `snout memory model install` adds recall by meaning as well as
  words, on your machine.
- **Repo brief at session start.** What two or more earlier sessions found: the test command that
  works, missing tools, the files most work touches.
- **Fast hooks in Claude Code.** The gate talks to a small local server instead of starting Node on
  every call. The server starts with the session, stays up while a project uses it, comes back on its
  own if it stops, and follows plugin updates.
- **Context audit.** `snout audit context` counts what instructions, skills, plugin commands and
  AI-written docs cost per session, and which ones are never used.
- **Classification.** Sentence-case generator banners, migration snapshots, built docs and
  third-party notices are recognized; a generator marker inside a string (test data) no longer marks
  a hand-written file as generated.
- `snout map on` (opt-in): paths that declare or use the code a prompt names. `snout replay`: what
  Snout would have saved on past sessions, offline.
- `snout --version` and `snout -v`.
- Windows support for Claude Code and Codex, including the PowerShell gate.

## 0.2.2

The read gate, output trimming, repeat-read pointers, reports and the local dashboard.
