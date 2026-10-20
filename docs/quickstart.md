# Quickstart

## Install

```bash
claude plugin marketplace add biffbuster/snout-context
claude plugin install snout@snout-context
```

Restart Claude Code, or run `/reload-plugins`.

No account or API key is needed. After installation, Snout's default features run locally;
the optional prompt coach and local memory-model download use the network only when enabled.

## Check it is working

```
/snout:doctor
```

`decisions` climbs as the agent reads files. If it stays at 0 after several reads, see
[troubleshooting.md](troubleshooting.md).

## See what it found

```
/snout:report
```

Read a handful of files first — the report has nothing to say about a session that has not
read anything.

## Put the counter on screen

```
/snout:statusline
```

This edits your `~/.claude/settings.json`, because the status line is a user setting rather
than something a plugin can claim on its own. If you already have one, you will be asked
before anything is changed.

## Turn it on

The default mode, observe, records but never changes what the agent sees. After your first session
Snout tells you what it would have kept out. When you trust the numbers:

```
/snout:mode enforce    # trim low-value reads and results; your code still comes through whole
```

Snout installs its gate hook itself, in your project's `.claude/settings.local.json`; there is
nothing to edit. New sessions pick it up, a running one after `/reload-plugins`. By default,
gated calls go to Snout's local server on `127.0.0.1`, started with the session. If the server
is unavailable, the agent continues without gating. If you also installed the CLI,
`snout fast off` switches to command hooks, which start Node for each gated call.

`/snout:mode observe` removes the hook again. `/snout:doctor` tells you whether it is installed and
whether that matches your mode.

## Memory between sessions

Nothing to set up. Each finished session leaves a card in `.snout/memory/`, and a later prompt that
bears on one gets it. `snout memory` lists the cards; `snout recall "<prompt>"` shows what a prompt
would get. Using Codex in the same project too? `snout init codex` gives it the same memory.

## When it gets something wrong

```
/snout:explain path/to/file      # why was this classified that way?
/snout:allow  path/to/file       # never flag this again
```

An override is our false positive, and `/snout:report` lists them. If that list is long,
the classifier is not ready for `enforce` on your repository — that is what the list is
for.
