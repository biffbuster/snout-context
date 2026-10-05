# Quickstart

## Install

```bash
claude plugin marketplace add biffbuster/snout-context
claude plugin install snout@snout-context
```

Restart Claude Code, or run `/reload-plugins`.

No API key. No configuration. No network calls.

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

## Start acting on it

The default mode records but never blocks, and costs your session nothing: the plugin
ships only non-blocking hooks. Move up when you trust the numbers:

```
/snout:mode advise     # ask before a low-value read
/snout:mode enforce    # deny a low-value read outright
```

Either of those installs a `PreToolUse` hook into your project's `.claude/settings.json` —
Claude will do it and show you the change. That hook is what makes blocking possible, and
it is also what costs latency: a short-lived Node process per gated read, 50 ms on a fast
machine and around 150 ms on an older laptop.

`/snout:mode observe` removes it again. `/snout:doctor` tells you whether it is installed and
whether that matches your mode.

## When it gets something wrong

```
/snout:explain path/to/file      # why was this classified that way?
/snout:allow  path/to/file       # never flag this again
```

An override is our false positive, and `/snout:report` lists them. If that list is long,
the classifier is not ready for `enforce` on your repository — that is what the list is
for.
