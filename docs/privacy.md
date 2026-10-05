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

## Snout Cloud (opt-in)

Only after `snout login` does anything leave, and only this, per project, when a session ends:

```jsonc
{
  "v": 1,
  "project": { "key": "155e8e727c0bff5e16289158", "name": "my-app" }, // hash of the git remote; folder name
  "days": [
    { "day": "2026-09-28", "client": "claude", "label": "lockfile",
      "reads": 13, "gated": 5, "inContext": 19694, "heldBack": 40820, "couldHoldBack": 0 }
  ],
  "spend": [ // read from the agents' own usage logs, priced at API list prices
    { "day": "2026-09-28", "client": "claude", "model": "claude-opus-5-5", "requests": 120,
      "input": 900, "cacheWrite": 150000, "cacheRead": 4200000, "output": 60000, "costUsd": 3.24 }
  ]
}
```

No file contents, paths, reasons or prompts. `snout spend` reads usage from Claude Code's and Codex's session logs on your machine; only the per-day totals above are sent. `snout sync --dry-run` prints the exact payload,
`snout logout` stops it, and the token lives in `~/.config/snout/cloud.json` (mode 600).

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

**File paths are recorded. File contents are not.** Add `.snout/` to your `.gitignore` —
paths alone can reveal more about a private codebase than you would want in a commit.

Nothing is uploaded, and there is no telemetry. `telemetry: "local-only"` is the only
permitted value.

## TypeSafe's side

TypeSafe states that Jev is not trained on customer requests or responses, and offers zero
data retention for enterprise accounts. See <https://docs.typesafe.ai/legal>. That is their
representation, not our verification of it.
