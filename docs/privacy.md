# Privacy

## By default, nothing leaves your machine

Out of the box Snout makes no network calls. Classification is deterministic rules running
locally: filename patterns, directory names, and at most the first 2 KB of a file, read to
look for a generator's marker. Nothing leaves your machine.

## Prompt coach

By default the coach scores prompts with local rules; nothing leaves the machine. It records
only the result (a score and which of target, behavior and verify were present) to
`.snout/prompts.jsonl`, never the prompt text. With `snout coach jev`, prompts that look like
tasks are sent to `api.typesafe.ai` so TypeSafe's Jev model can judge them; `snout coach tip`
turns that off.

## Memory preference judge

Off by default. With `snout memory judge jev` and `TYPESAFE_API_KEY` set, up to six sentences
from each finished session's requests are sent to `api.typesafe.ai` to ask whether each states a
lasting preference. Those rated 0.8 or higher are saved to `.snout/memory/preferences.json` and
shown at the start of later sessions. `snout memory judge off` turns it off;
`snout memory prefs forget <n>` removes one.

## Notes (0.3.2, unreleased)

Notes are written on your machine, by fixed rules with no model call. Who may see a note is stored
with it as hashes of your git email and of the repository, never the email or path itself.

- **Private notes** are kept in your user config folder (`%APPDATA%\snout\memory\` on Windows,
  `~/.config/snout/memory/` elsewhere), never in the repository. They reach only your own sessions,
  in Claude Code and Codex alike. Notes Snout writes on its own are private.
- **Shared notes** exist only when you ask for one (`snout memory add --shared`, or
  `snout memory share <id>`). They are kept in `.snout/memory/obs/` and reach anyone with the
  repository once you commit them.
- CI and token-only sessions get shared notes only.

The MCP memory tools (`snout mcp`) read and write the same notes under the same rules. A note an
agent saves without being asked stays a proposal, never recalled, until you run
`snout memory accept <id>`.

## Snout Cloud (opt-in, private beta)

Nothing is sent unless you run `snout login` (or set `SNOUT_TOKEN`). Signing in sends a label for
this machine, its hostname cut to 40 characters, so the team dashboard can tell machines apart.
After that, `snout sync` sends per-day totals for each agent and label: read counts, tokens that
reached context and tokens held back, and token usage and list-price cost per model from the
agents' own logs. It also sends a hash of the project's git remote (or folder), the project's folder
name, and a hash of the agent session. It never sends file contents, file paths, prompts, notes or
command output. `snout sync --dry-run` prints the exact payload without sending it.
`snout logout` deletes the saved credentials and disconnects the machine.

## Planned: semantic classification

A planned opt-in tier will call `api.typesafe.ai`. What goes in the request is a **digest**, not the
file:

```jsonc
{
  "request": "the text of your prompt for this turn",
  "file": {
    "path": "src/generated/api-client.ts",
    "bytes": 412883,
    "language": "typescript",
    "head": "first ~1200 characters",
    "symbols": ["getUser", "createUser", "…"]
  }
}
```

Three reasons it is a digest: the whole file is the cost we are trying to avoid paying, it
has to fit the model's 32 KB state budget on any input, and your source should stay on your
machine wherever a summary will do.

Your prompt text **is** sent, because relevance cannot be judged without knowing the task.

## What is never sent

Anything matching a `redact` pattern: `.env` and its variants, private keys (`*.pem`,
`id_rsa*`, `*.p12`), `.npmrc`, `.netrc`, `.pgpass`, `credentials.json`, service-account
JSON, and everything under `.ssh/`, `.aws/` and `.gnupg/`. These are not classified at all —
they short-circuit at the first rule, and the verdict is always `ask`, in every mode. You
cannot allow-list your way past this.

`redactExempt` carves out the documented sample files (`.env.example`, `.env.sample`) which
are committed on purpose and hold nothing.

Note what is deliberately **not** on that list: a substring match on "secret" or
"credential". Those were defaults once and they matched ordinary source and documentation,
which meant constant prompts about files that held nothing — and because this rule ignores
mode, no way to stop them. Precision here is a usability property, not just a security one.

If you have secrets in paths our patterns miss, add them to `redact` before enabling any
semantic tier.

## What is stored, and where

`.snout/` in your project, as plain JSONL:

| File | Contents |
| --- | --- |
| `ledger.jsonl` | One row per decision: path, rule, verdict, byte count, estimated tokens, latency. |
| `turns.jsonl` | One row per turn. |
| `config.json` | Only what you changed. |
| `state.json` | Turn counter and a hash of the current prompt. |
| `errors.jsonl` | Anything that went wrong. |
| `memory/<session>.json` | One card per session: the start of your first and last request, the agent's last message, files changed, commits (sha, subject, files), test command, last error, instructions you gave, branch and git user name. `snout memory off` stops it. |
| `recall.jsonl` | Which cards were recalled into which prompt, and their size. No prompt text. |
| `memory-vectors.json` | Only with `snout memory model install`: a vector per card, computed on this machine. Not shared. |
| `memory/obs/` | Shared notes, only those you shared. Private notes are in your user config folder, not here. |

**File paths are recorded. File contents are not**, except the request text a memory card keeps.
Add `.snout/` to your `.gitignore` — paths alone can reveal more about a private codebase than you
would want in a commit. To share memory with a team, commit only `.snout/memory/`, after reading it.

Nothing is uploaded unless you sign in to Snout Cloud (above), and there is no telemetry.
`telemetry: "local-only"` is the only permitted value. `snout memory model install` is the one command that downloads (the library from
npm, the model from Hugging Face), and only when you run it.

## TypeSafe's side

TypeSafe states that Jev is not trained on customer requests or responses, and offers zero
data retention for enterprise accounts. See <https://docs.typesafe.ai/legal>. That is their
representation, not our verification of it.
