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
  "output": "normal",             // "concise" adds one short output-style instruction (opt-in)
  "repoMap": false,               // true: suggest the files linked to names in each prompt (opt-in)
  "memory": true,                 // a record per session in .snout/memory; agents search it on demand
  "memoryHint": true,             // one line at session start saying earlier sessions are on record
  "memoryNotes": false,           // true: add a saved note to the prompt it fits (opt-in)
  "memoryBudget": 600             // tokens of automatic notes per prompt, when memoryNotes is on
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

`repoMap` (opt-in, default off; `snout map on|off`): Snout keeps a local index of which files
declare or use each name in the project (hand-written files only; it reuses entries for unchanged
files, so a rebuild after an edit takes well under a second). When a prompt names code the index
knows, the agent gets up to 8 candidate file paths with the names that link them, about 300 tokens
and never any file contents. A file the request names by path comes first, and names that appear
only in pasted program output (log lines, version banners) count for little. Prompts that name
nothing get nothing. A request like "fix #123" names
nothing, so when the agent then reads the issue through an MCP tool (GitHub, Linear, Jira and the
like: `get_issue`, `issue_read`), the candidates for the issue's own text are added to that result,
(0.3.2, unreleased, Claude Code only). `snout map "<request>"` shows
what a prompt would get. Offline, on 1,788 SWE-bench issues it had never been scored on, a file the real fix edited was
in the top 10 for 66% of issues, against 44% for full-text BM25 search and 28% for grep
(`bench/mapeval.mjs --confirm`).
Whether that lowers agent spend is not measured yet, which is why it is off by default.

`memory` (default on; `snout memory on|off`, or `SNOUT_MEMORY=0|1`): at the end of each turn Snout
writes one record per session to `.snout/memory/<session>.json` from the session's own transcript,
with no model call. The record holds:

- the task as the user first stated it, and the latest request;
- how the session ended, in the agent's own last words;
- the files it changed, and its commits (`git commit`s it ran, with subject and files);
- the last test command and its result, and a failure it got past before a test run passed;
- an error left unresolved, its open to-dos, standing instructions the user gave, and the branch.

Agents read the records through `snout_memory_search` and `snout_memory_fetch` (`snout mcp`), which
leave out a claim that no longer holds and mark it as out of date. `snout memory` lists the records and how agents used them, `snout memory forget <session>`
drops one, and `snout recall "<request>" [--as-of <date>]` shows what a search for a request finds.
There is one file per record, so committing `.snout/memory/` shares it with a team without merge
conflicts: `snout memory share` changes a `.snout/` line in `.gitignore` to `.snout/*` plus
`!.snout/memory/`, and stages nothing. Records hold the start of your prompts, so read them before
you commit them. Whether memory lowers spend per task is not measured yet ([memory](memory.md)).

`memoryHint` (default on; `SNOUT_MEMORY_HINT=0|1`): in enforce mode, when this project has records
of other sessions, a new session (not a resumed or compacted one) starts with one line. It says how
many records there are, the latest one's date and agent, and to search them with
`snout_memory_search` if the task may build on earlier work. When the newest session with changes
left them unfinished here (uncommitted changes, open to-dos, a failing test or an error on this
branch), the line gives that session's id so the agent can fetch it. Nothing from the records is in
it. It exists because the MCP
server's own guidance doesn't reach every model: Codex leaves server instructions out, and Claude
Code defers MCP tools behind ToolSearch, so in a live check neither agent searched a record it was
never told about (docs/memory-gates.md, "Cross-agent handoff check").

`memoryNotes` (default off; `snout memory notes on|off`, or `SNOUT_MEMORY_NOTES=0|1`): in enforce mode,
add the saved notes that fit a prompt to it, each with where it came from, once per session. It is off
because choosing a note for a prompt that didn't ask for one was not accurate enough on fresh test
sets ([memory gates](memory-gates.md)).

Notes (0.3.2, unreleased, not measured): short observations, such as a convention, a gotcha or the
test command, that agents find with `snout_memory_search`, in Claude Code and Codex alike. `snout memory add
"<note>" [--kind gotcha] [--shared]` saves one, `snout memory list [--all]` shows the notes you may
see, and `snout memory share <id>`, `archive`, `drop`, `supersede` and `accept` manage them. A note is
private (your user config folder, only your sessions) unless you share it into `.snout/memory/obs/`.
At the end of a session Snout also writes private notes by fixed rules: the test command that passed,
missing tools (archived once the tool is on PATH), commands too slow for the tool limit, and standing
instructions. An instruction tied to the task at hand ("don't push yet", "as part of this step") is
never saved; any other is kept once a second session repeats it. A note an agent saves on its own
(`snout_memory_save`) is a proposal, shown to no agent until you accept it. A failed Python import is
not recorded as a missing tool unless the command runs that module. `memoryBudget` (default 600, at
most 4000) caps the tokens of automatic notes per prompt when `memoryNotes` is on; observe mode
records what it would add and adds nothing. See [privacy](privacy.md#notes-032-unreleased).

Paused while the memory pilot runs, and unchanged: the reranker, the embedding model and the
preference judge stay opt-in.

`snout memory reranker install` (optional) adds a local cross-encoder, ms-marco MiniLM-L6 (q8, about 23 MB,
with the same npm runtime as the memory model). `snout recall` and `snout_memory_search` then score their
shortlist (today's ranking, then records sharing a word, ten at most, all past the usual filters) and put
first the record it is sure answers. When the words find nothing, it adds nothing (`src/memory/rerank.ts`;
the thresholds and their test are in
[memory gates](memory-gates.md)). The prompt hooks never load it. `memoryRerank: false` or
`SNOUT_MEMORY_RERANK=0` turns it off; `snout memory reranker remove` deletes it.

`snout memory model install` (optional) adds a local embedding model, bge-small-en-v1.5 (q8, about
34 MB), so recall matches by meaning as well as words. It installs `@huggingface/transformers` with
npm (its ONNX runtime takes a few hundred MB) and the model files from Hugging Face into the per-user
config folder; nothing downloads unless you run it, and `snout memory model remove` deletes it. The
model stays loaded in `snout serve`, which starts with the session; each prompt asks it for a vector
(about 125 ms in all on a laptop) and falls back to words when it doesn't answer. A card is then
offered only when both the word ranking and the meaning ranking put it near the top, and the repo
map agrees. On 485 SWE-bench Verified tasks with commit history as memory, briefs that met that bar
named a file the fix needed 87% of the time, against 75% for words with the map's agreement
(`bench/recalleval.mjs --embed`); with real agent sessions on earlier issues as memory, 61% against
52% (`bench/sessioneval.mjs --embed`). Card vectors are kept in `.snout/memory-vectors.json`, not in the
shared `memory/` folder, and are recomputed when a card changes.

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
| `snout init <agent>` | Hook setup for Codex, Cursor or Gemini CLI in this project |
| `snout mcp` | MCP server (`snout_read`, `snout_classify`) for agents without read hooks |
| `snout reset` | Clear this project's local records |
| `snout audit context [--days N] [--map] [--json] [--archive <paths>] [--restore [id]]` | Instruction files, skills, commands, subagents and AI-written docs for every agent: tokens each adds per session (including files a CLAUDE.md pulls in with `@path`, `.claude/rules` and a gitignored `CLAUDE.local.md`), last use, who wrote it, and flags for unused, duplicate, stale and oversized ones. `--map` is a compact list for an agent to judge; `--archive` moves files to `.snout/archive/` after you confirm, and `--restore` brings them back |
| `snout audit [--measure] [--days N]` | MCP servers your agents load, how often each was used, and the unused ones that still add their tool list to every request (with how to turn them off). `--measure` starts each local server once to count its tool-list tokens. Claude Code sends only tool names until a tool is used (tool search, on by default), so its servers show both numbers |
| `snout map on\|off` · `snout map "<request>"` | Opt-in repo map: candidate file paths for each prompt that names code in the repo. Off by default |
| `snout output concise\|normal` | Opt-in concise output: one short instruction at session start to skip recaps and restated code. Off by default |

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
| `SNOUT_DIR` | Where Snout keeps its records instead of the project's `.snout/` (for sandboxes and CI runs that must leave the project untouched). |
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

## Compaction

Compaction is the agent's own. Snout adds nothing to the context after one; Claude Code's or Codex's
summary carries the session on. What Snout keeps across sessions is memory: a record per session,
which a later session finds by searching ([memory](memory.md)).

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

```text
/snout:mode observe            # stop blocking, keep reporting
export SNOUT_DISABLE=1         # force observe for a session
claude plugin uninstall snout@snout-context
```

Uninstalling leaves `.snout/` in place. Delete the directory to remove your history.
