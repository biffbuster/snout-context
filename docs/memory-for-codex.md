# Codex: project memory after compaction

Task for an agent bringing Snout's post-compaction memory to Codex CLI. Read `README.md`,
`docs/integrations.md`, `src/agents/adapt.ts` and `src/compact/memory.ts` first.

## What exists (Claude Code)

When Claude Code compacts a conversation, its summary paraphrases and can drop exact facts. In the
long-session benchmark (`bench/swelong.mjs`, `docs/benchmark-protocol.md`) agents forgot how a
project's tests run right after a compaction and got stuck. Snout now restores a few exact facts
right after every compaction, with no model and no search:

- `sessionFacts(transcriptPath, projectDir)` reads the session transcript across compactions and
  takes, by fixed rules: the test command that ran (a test runner whose output has a count or a
  verdict), tools the environment lacks (`No module named X`, `command not found`), commands that
  outlived the tool time limit, files changed, the current request, open to-dos.
- `readPins(projectDir, snoutDir)` reads `.snout/pins.md` (user-written; `[re-read N]` inlines the
  first N lines from disk, never for files matching the `redact` patterns).
- `memoryText(facts, pins, projectDir, cfg)` renders them, capped at 4,000 characters.
- `src/cli.ts` `onSessionStart`: when `source === "compact"` and Snout is not in observe mode, the
  text goes back to the agent as `hookSpecificOutput.additionalContext`.
- Tests: `test/memory.test.mjs`.

## What Codex needs

1. **Find Codex's post-compaction moment.** Check the current Codex CLI hooks: does `SessionStart`
   fire after compaction with a `source`/reason field, or is there a `PostCompact`-style event, and
   can its hook return context? `CODEX_EVENTS` in `src/agents/adapt.ts` already maps `SessionStart`
   and `PreCompact`. If Codex has no such event, report that; do not invent one.
2. **Read Codex's transcript.** `sessionFacts` parses Claude Code's JSONL (`tool_use` /
   `tool_result` blocks, `compact_boundary`). Codex stores sessions in its own rollout format. Add a
   Codex reader that yields the same `SessionFacts` (keep the rules in one place; factor the
   per-format parsing out of `sessionFacts` rather than copying the rules).
3. **Wire it** through the Codex adapter so the same `memoryText` reaches the agent after a Codex
   compaction. Keep the cap and the observe-mode rule.
4. **Tests** from Codex payloads and a small Codex rollout fixture (no network, no API keys):
   the test command and "pytest is not installed" survive verbatim; observe mode adds nothing; a
   pinned credential file is never inlined.

## Rules

- Model-free and local: no extraction model, no embeddings, no network on the restore path.
- No new user-facing commands or settings.
- Commit in small focused commits with plain messages, no AI attribution lines. Never push or merge;
  the user does. Anything that runs a real agent or model asks the user first, with session count
  and rough cost.
