# Changelog

## Unreleased

Not measured yet. Nothing below is covered by [docs/claims.md](docs/claims.md).

- Removed: Snout Cloud. The server (`cloud/`), `snout login`, `snout sync` and `snout logout`,
  the sync after each turn, and the dashboard's Cloud preview and hosted pages are gone. Nothing in
  Snout sends data anywhere now. Credentials saved by an earlier `snout login` are no longer read;
  delete `cloud.json` in Snout's config folder to remove them.
- Removed: the optional reranker (`snout memory reranker`, `memoryRerank`). It did not pass its
  recall test, so search and `snout recall` keep their own ranking.
- Snout in Claude Code: the plugin switches to a Snout Pink theme once (light and dark) and draws an
  animated pixel Snout above the prompt until the first message of each session, with the status
  line beside it. `/snout` opens Snout in a pane. `/snout off` and `/snout pink off` turn the
  character and the theme off (the earlier theme comes back), and both switches are in `/config`.
  The art source is `art/snout.frames.txt`; `python art/build-sprite.py` rebuilds `hooks/sprite.ts`.

- Lessons you review ([docs/memory-lessons.md](docs/memory-lessons.md)). An agent proposes a
  one-line lesson with `snout_memory_propose`, only after a test passed or when you gave a decision
  or made a correction (your words quoted). Each lesson keeps its source session, evidence, date,
  project and where it applies. At the session's Stop, Snout checks the session's record for that
  evidence. `snout memory review` lists proposals, and `approve`, `reject`, `edit` and `replace`
  decide them. Nothing else approves one. A search shows up to three approved lessons first, cited,
  and leaves out proposed, rejected, replaced, stale, weak and other projects' lessons;
  `snout_memory_fetch` opens a lesson's evidence. Lessons are never added to a prompt on their own.
  The opt-in lesson step (`snout memory lessons on`) now saves proposals too.
- A short memory skill, `snout-memory`, says when to search memory and when to skip it. It ships
  in the plugin, and `snout init codex` writes it to `.agents/skills/`. `snout memory promote <id>
  --name <skill>` turns approved lessons into a project skill: it prints a preview and writes only
  when run again with that preview's code.
- Repeat reads cover shell ranges and images. Lines printed with `sed -n '40,80p'`, `head -n 40` or
  PowerShell's `Get-Content -TotalCount` (and `| Select-Object -Skip -First`) count as in context.
  Printing or reading them again while the file is unchanged gets "unchanged since turn N" and a
  pointer to the earlier copy. This includes a Read of lines a shell printed, which Claude Code's
  own repeat check doesn't know about. An image read again is answered the same way.
  `bench/resend.mjs` measures, from this machine's session logs, which context gets re-sent most.
- Stricter writes to memory. An agent's `snout_memory_save` is kept only when you asked it to
  remember something; anything else goes through a lesson for you to review. Nothing is saved that
  `CLAUDE.md` or `AGENTS.md` already says, or that nearly repeats a note or lesson on record (a
  rejected lesson included). Proposals nobody reviewed in 30 days, and rule-saved notes unused for
  90, are archived at session start (`snout memory restore <id>` brings one back). Your own notes
  and approved lessons never decay. `snout memory list` and a fetch say what verified each note.
- With automatic notes on (`snout memory notes on`, still off by default), a prompt also gets the
  approved lessons that fit it on strong evidence, three notes at most, and the session-start line
  names approved lessons by where they apply. The same in Claude Code and Codex.
- Search: among several test commands (a project in several languages), the one sharing the
  question's words comes first, and "retried", "applied" and the like now match "retry" and
  "apply". The local index rebuilds once for the new word forms.
- How memory works now ([docs/memory.md](docs/memory.md)). Each session leaves a record. A new
  session, in enforce mode, gets one line saying earlier sessions are on record and how to search
  them (`memoryHint`). When the newest work is still unfinished here, that line also gives the
  session's id. The agent searches and opens records with `snout_memory_search` and
  `snout_memory_fetch`. Automatic notes on prompts are off (`snout memory notes on` turns them on), so
  the bullets below about notes shown on a prompt apply only with them on.
- A fetched session record now shows the to-dos it left open, and a failure it got past before a
  test run passed. A search leaves out the calling session's own record.
- Snout's MCP server logs each memory search and fetch in `.snout/recall.jsonl`. `snout memory` and
  the dashboard show how many session-start lines, searches and opened records there were, and how
  many agent-written notes are waiting for you. The dashboard's memory tiles and workflow nodes now
  show these in place of recalls and repo briefs.

- A new session no longer starts with a block of saved notes. A note is shown on the prompt it fits,
  once per session, with where it came from ("seen in a passing test run; claude, 2026-10-23"), and
  only if it is verified: a rule saw the evidence (a passing test run, a command-not-found), or you
  wrote or accepted it. A test command fits a task that involves tests; a missing tool fits a task
  that names it or whose test scripts call it; any other note fits a prompt that shares two of its
  words. Where the last session left off is shown on a new session's first prompt only when that
  prompt continues the work. The repo brief at session start is gone; `snout memory brief` still
  prints it. Agent-written lessons are never shown this way.
- Earlier sessions' summaries are no longer added to prompts or issue reads on their own: they are a
  record of what a session did, not verified facts. `snout recall "<request>"` and the
  `snout_memory_search` MCP tool find them on request, labeled as a record. The local memory model is
  no longer run on each prompt.
- Notes: an instruction tied to the task at hand ("don't push yet", "as part of this step") is never saved,
  and any other is kept only once a second session repeats it; instructions saved earlier are
  cleaned up the same way at the next session start. `go test` runs count as test runs, and cmd.exe
  and PowerShell "not recognized" errors as missing tools. A test command is saved in the form the
  next task can use: the runner, its flags and environment stay, and the tests one task picked
  (`-run TestX`, `-k name`, file and package paths) become `<tests>` or `<packages>`. A project's
  own test script counts as a test run when it prints a runner's results (`node scripts/test.mjs`,
  `./run-tests.sh`, `make test`, `manage.py test`).
- Lessons (opt-in, `snout memory lessons on`): when a session got past a failure (a command failed,
  then the tests passed), the agent is asked once, as it finishes, for a one-line lesson: the exact
  command, file or setting and why. It is kept as a private note, and your next session in Claude
  Code or Codex can see it in `snout memory list`; it is not shown to sessions as a verified note. Sessions
  with no failure are asked nothing. Off by default and not on the roadmap.
- Where the last session left off: a new session that continues the work gets what the last working session was
  asked, its changes not committed yet, the to-dos it hadn't finished, a failing test and an error
  it left unresolved, so the agent doesn't reread the diff to find its place. Only when that work is
  unfinished (uncommitted changes here, or open to-dos, a failing test or an error on the same
  branch) and under a week old. Works across agents: Codex picks up where Claude Code stopped, and
  the reverse.
- When the agent reads an issue through an MCP tool, with `snout map on`, Snout adds the files the
  repo map ranks for it (Claude Code). The whole issue is ranked, up to 50,000 characters.
- Repo map: a file the request names by path (`src/cart.ts`, `pkg/db/query.py:41`) ranks first.
  Names that appear only in pasted program output (log lines, version banners, `text` or console
  blocks) count a quarter and no longer fire the map on their own; tracebacks still count in full.
- An MCP result that reaches the hook as one string, as GitHub's server's do, is now trimmed and
  gets issue hints like any other; before, it passed through untouched.

## 0.3.2 (2026-10-25)

Agent cost is not measured on 0.3.2 yet. [docs/claims.md](docs/claims.md) has the offline recall
numbers measured on this release; the 0.3.1 cost result is archived and does not describe these
changes.

- Notes that carry across sessions and agents. A private note is kept in your user config folder and
  reaches only your own Claude Code and Codex sessions. A shared note is kept in `.snout/memory/obs/`
  and reaches anyone with the repository once committed. Who may see a note is checked when it is
  recalled. CI and token-only sessions get shared notes only. New commands: `snout memory add`,
  `list`, `share <id>`, `archive`, `drop`, `supersede` and `accept`. `memoryBudget` (default 600
  tokens) caps what a new session starts with.
- Notes written automatically at the end of a session, by fixed rules with no model call: the test
  command that passed, tools that were missing, commands too slow for the tool limit, and standing
  instructions. They are private. A "not installed" note is archived once that tool is on PATH.
- Memory over MCP: `snout mcp` adds `snout_memory_index`, `search`, `fetch` and `save`. A note an
  agent saves on its own is only a proposal until you accept it. `snout init codex` registers the
  server; `snout init claude --mcp` adds it for Claude Code.
- MCP results that Snout trims are saved in full as plain text at an absolute path, so the agent can
  search the saved file instead of calling the tool again. Saved command output uses absolute paths
  too.
- Snout Cloud sign-in, in private beta and off unless you use it: `snout login`, `snout sync`
  (`--dry-run` prints what would be sent) and `snout logout`. Sync sends daily totals, never code,
  paths or prompts. See [docs/privacy.md](docs/privacy.md).
- Removed the context Snout added after a compaction. Compaction is left to the agent: the restore
  added up to about 1.5K tokens after each one, with no measured saving and no shown effect on
  solved tasks. `.snout/pins.md` is no longer read. Memory cards, recall on later prompts and the
  repo brief are unchanged.
- Dashboard: compaction counts are labeled as the agent's; the restore tiles and trace nodes are gone.
- Dashboard: Snout, the anteater from the site, greets you in the corner on first open and walks
  you through Overview, Sessions and Settings (Overview, Agents and Integrations in the Cloud
  preview). The ? button in the top bar starts the tour again.

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
