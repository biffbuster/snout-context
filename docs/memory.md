# Memory

Snout gives coding agents better context, carried across sessions. This page covers what Snout keeps
for a project, how Claude Code and Codex get it, how to see whether they use it, and what has been
measured so far.

Everything here stays on your machine. Nothing is sent anywhere, and no model is called to write it.

## What Snout keeps

**A record of each session** (`.snout/memory/<session>.json`). Snout writes it at the end of each
turn, from the session's own transcript:

- what you asked, in your own words, including decisions you gave ("from November a shift counts in
  the week it ends");
- how the session ended, in the agent's last message;
- the files it changed and the commits it made;
- the last test command it ran and the result;
- a failure it got past before a test run passed;
- what it left unfinished: open to-dos, an error it didn't resolve and, checked when the next session
  starts, its changes that are still uncommitted.

Each record names its session, its agent and its date. It records what happened in that session.
It is not a verified fact, and both agents are told so when they open one.

Snout doesn't pull decisions out of a conversation into notes on its own. A decision stays in the
record of the session where you gave it, with that session as its source, and an agent finds it by
searching. An agent can propose it as a lesson, which you review (below).

**Lessons:** one line each, proposed by an agent and approved by you ([lessons](memory-lessons.md)).
An agent proposes one only after a test passed, or when you gave a decision or made a correction,
and quotes your words. Snout checks the session's record for that evidence before you see it in
`snout memory review`. Nothing but `snout memory approve` makes a lesson visible to a search.

**Notes:** short observations, private to you unless you share one.

- Snout writes some by fixed rules when the session shows the evidence: a test command that passed,
  a tool that isn't installed, a command too slow for the agent's tool time limit.
- You write others (`snout memory add "<note>"`), or accept one.
- An agent's `snout_memory_save` is kept only when you asked it, in your own words, to remember
  something. Anything else it wants to keep goes through a lesson, with its evidence, for you to
  review. A standing instruction seen in only one session waits as a proposal until a second session
  repeats it.
- Nothing is saved that `CLAUDE.md` or `AGENTS.md` already says (agents load those files themselves),
  and nothing that nearly repeats a note or lesson on record. A lesson you rejected isn't proposed
  again in other words. A correction ("now", "instead of") replaces the note it corrects.
- A note about a file that has changed since is held back as out of date.
- At session start, Snout archives proposals nobody reviewed in 30 days, and notes a rule saved that
  no session was shown, fitted or opened in 90 days. They stay on disk: `snout memory list --all`
  shows them and `snout memory restore <id>` brings one back. The rule that saved a note brings it
  back when it sees the same thing again. Your own notes, ones you accepted, and approved lessons
  never decay.
- `snout memory list` and a fetch show what verified each note: a passing test run, a
  command-not-found error, your own words, or your approval.

## How agents get it

1. **One line at session start.** When the project has other sessions on record, a new session
   is told how many there are, the latest one's date and agent, and how to search them. If the
   newest work is still unfinished here, the line also gives that session's id. It includes nothing
   from the records. It is shown in enforce mode, and `memoryHint: false` turns it off. The line exists because neither agent
   passes Snout's own tool guidance on in a usable form: Codex leaves MCP server instructions out,
   and Claude Code lists Snout's tools by name only until they are loaded. In a live check, neither
   agent searched a record it wasn't told about.
2. **Tools, on demand:** `snout_memory_search`, `snout_memory_fetch` and `snout_memory_propose`. A
   search returns up to five current, cited records, approved lessons first (three at most), and a
   fetch opens one in full, a lesson with its evidence. The agent decides whether to look and what
   helps. A short skill (`snout-memory`) tells it when to search and when to skip memory.
3. **Automatic notes are off.** With `snout memory notes on`, in enforce mode, a prompt gets up to
   three verified notes and approved lessons that fit it on strong evidence (a file or code name it
   names, or two shared words), lessons first, each cited. When nothing clears that bar it gets
   nothing. The session-start line then also names each approved lesson by its id and where it
   applies (three at most), never what it says. This works the same in Claude Code and Codex (their
   `UserPromptSubmit` and `SessionStart` hooks). It stays off by default because on fresh test sets,
   choosing a note for a prompt that didn't ask for one was not accurate enough; the 2026-10-30
   frozen lesson delivery preflight showed four wrong injections in 20 negative prompts per agent
   ([memory gates](memory-gates.md)).

Claude Code gets the hooks, the tools and the skill from the plugin. Codex gets them from
`snout init codex`, which writes the skill to `.agents/skills/snout-memory/`. Each agent can search
the other's records and lessons.

## Is it used?

`snout memory` shows the session records, then the last 30 days:

- how many session-start lines were shown;
- how many searches ran, and how many found nothing;
- how many records were opened, and how many lessons were proposed;
- how many lessons are approved, and how many wait for your review;
- how many agent-written notes are waiting for you.

The dashboard's Analytics page shows the same counts. A session's workflow shows the session-start
line, each search with what it found, and each record opened. Snout's MCP server logs each search
and fetch in `.snout/recall.jsonl`, with the query (up to 120 characters) and the ids it showed
([privacy](privacy.md)).

## What has been measured

- **Handing off a decision** (2026-10-28; one agent hands off to the other, both ways, one pair
  each). The decision needed was held only in the earlier session's record. Both receivers with
  Snout searched, found the cited record and solved the task. Both receivers without Snout failed.
  That shows the path works. With one pair per direction, it says nothing about cost.
  [Details](memory-gates.md#cross-agent-handoff-check-2026-10-28).
- **The Gate 4 pilot** (2026-10-29; no Snout, trimming only, and trimming plus memory as it
  shipped, on the same 10 real tasks per agent). Memory added no value for either agent. Claude
  Code never searched. Codex searched and opened records but acted on none. Memory as it shipped
  does not go to a larger run. Reviewed lessons and the skill are the changes made in response, and
  they have not been measured ([result](memory-gates.md#result-2026-10-29-no-go-for-memory-as-it-shipped-for-both-agents),
  [next test](memory-lessons.md#next-the-billing-handoff-live)).
- **What Snout doesn't claim yet:** that memory saves tokens or money, or that it gets better on its
  own. It won't claim either until results support it. The 0.3.1 cost result in
  [claims](claims.md) measures trimming, not memory.

## Paused

These aren't being developed until memory passes a real-agent test:

- new models: the embedding model, the reranker and the preference judge stay opt-in and unchanged;
- new agent integrations beyond Claude Code and Codex;
- cloud memory: Snout Cloud is off.

## Later: team and cloud sharing

These are designed as extensions of the same local project memory, not as a separate store. Work
starts only after the pilot shows memory is worth having for one person.

- **Same records, same rules.** A shared record is a record from this memory. It keeps the same
  citation, the same out-of-date check and the same proposal rule. Nothing reaches another person
  unless someone shares it.
- **Team sharing through git first.** `snout memory share <id>` already writes a note into
  `.snout/memory/obs/`, where it travels with the repository. `snout memory share` lets you commit
  the session records. Each person's private notes stay in their own user folder.
- **Access is checked on every read.** Snout checks who may see a record each time it is read
  (`admit` in `src/memory/store.ts`), so a shared store cannot widen what anyone sees.
- **Cloud later.** It would sync only the shared layer, it would be opt-in, and the server would
  check access itself, never trusting a flag from the client. By default no record leaves the
  machine.
