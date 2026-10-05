# Security

Snout sits between a coding agent and your files, so it has to be trustworthy by construction,
not by promise. This page says what it touches, what it never does, and how to check.

## What Snout reads, stores and sends

| | What | Where it goes |
| --- | --- | --- |
| **Reads** | A file's path, size and first 2 KB, when your agent is about to read it | Nowhere: classified in memory, on your machine |
| **Reads** | The output of test, install and build commands your agent already ran (Squeeze) | Nowhere; the full output is saved to `.snout/squeeze/` in your project |
| **Reads** | Your agents' own usage logs (tokens and model per request), for `snout spend` | Nowhere |
| **Stores** | One line per decision: path, label, token estimates, time | `.snout/` in your project, plain JSON Lines you can open or delete |
| **Sends** | Nothing, unless you run `snout login` | |
| **Sends, after `snout login`** | Per-day totals: read counts, tokens and spend by coding agent, model and file type; a hash of the project's git remote; the folder name | Snout Cloud. Never file contents, paths, prompts or reasons. `snout sync --dry-run` prints the exact payload. |
| **Sends, with `snout coach jev` only** | The text of prompts that look like tasks | TypeSafe's API, to score them. Off by default. |

## What Snout never does

- Never sends file contents or code anywhere.
- Never edits your source files. The only files it writes are `.snout/`, its own config, and, when
  you choose enforce mode, its hook entry in `.claude/settings.local.json`.
- Never blocks a read when something goes wrong: every error path lets the read through.
- Never changes a command before it runs, so your permission rules apply exactly as written.
  Squeeze only slims the output of commands that already succeeded, and leaves failures whole.
- Never reads `.env` or key files without asking you first, in every mode.

## How to verify

- **The code you run is readable.** `dist/snout.mjs` is not minified; CI checks it matches `src/`.
- **Packages are built in public.** Releases are published to npm from GitHub Actions with
  [provenance](https://docs.npmjs.com/generating-provenance-statements), so npm shows the exact
  commit and workflow that built each version.
- **Watch it first.** Snout starts in observe mode: it records what it would do and changes
  nothing until you run `snout mode enforce`.
- **See what would leave.** `snout sync --dry-run` prints the full cloud payload.
- **No runtime dependencies.** The CLI is one bundled file with nothing pulled from npm at run time.

## Snout Cloud

Sign-in is through GitHub; sessions are signed, HttpOnly, SameSite cookies over HTTPS. CLI and
agent keys are stored as SHA-256 hashes and shown once. Webhooks from Stripe are verified by
signature. Payments are handled entirely by Stripe; Snout never sees card details. Totals are
kept per team, and people only see teams they belong to.

## Reporting a vulnerability

Please report privately through GitHub:
[Security advisories](https://github.com/biffbuster/snout-context/security/advisories/new).
Include steps to reproduce if you can. We aim to reply within 3 business days and to fix
confirmed issues before disclosing them.
