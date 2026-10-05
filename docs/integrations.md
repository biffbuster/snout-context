# Using Snout with other agents

Snout's rules are the same for every agent. What differs is how much each agent's hooks let
it do.

| Agent | How Snout connects | What it can do | Status |
| --- | --- | --- | --- |
| Claude Code | Plugin hooks | Trims bulk reads, attaches an outline | Tested live |
| Gemini CLI | `BeforeTool` / `AfterTool` hooks | Trims bulk reads by rewriting offset and limit | Tested against the documented hook format |
| Codex CLI | `PreToolUse` / `PostToolUse` hooks | Denies whole-file prints of bulk files with a search hint | Tested live; A/B: −23% on bulk-file tasks, 30/30 passing |
| Cursor | `beforeReadFile` / `beforeShellExecution` hooks | Denies bulk reads (Cursor hooks can't trim) | Tested against the documented hook format |
| Copilot, Windsurf, Cline, Zed and other MCP clients | MCP server | Offers `snout_read`, which returns bulk files as head plus outline | Tested with a scripted MCP session |

All of them record to `.snout/` in the project, so `snout report` works the same way.

## Install the CLI

```bash
npm install -g usesnout
```

`snout init` writes hook commands that point at the installed bundle, so a global install
keeps them valid. Every agent starts in observe mode; `snout mode enforce` turns the gate on.

## Gemini CLI

```bash
cd your-project
snout init gemini        # writes .gemini/settings.json
```

## Codex CLI

```bash
cd your-project
snout init codex         # writes .codex/hooks.json
```

Codex loads project hooks only in a trusted folder, and runs a new hook only after you
approve it. Open Codex in the project once, trust the folder, and approve Snout's hooks with
`/hooks`. Until then the hooks are skipped without any error.

Codex reads files through shell commands, so Snout gates whole-file prints such as
`cat package-lock.json` and points the agent to a `grep` instead. In a live run, Codex
followed the hint and answered from one matching line: 3,382 tokens with Snout, 14,026
without. Codex already truncates long command output, so Snout's report overstates the
tokens withheld on Codex; use the agent's own token count for savings.

## Cursor

```bash
cd your-project
snout init cursor        # writes .cursor/hooks.json
```

Cursor's read hook can allow or deny but not shorten a file, so a read Snout would trim in
Claude Code is denied here. Shell prints get a search hint the agent can act on.

## MCP clients

Add Snout as an MCP server. It runs `snout mcp` in the project directory.

VS Code (Copilot agent mode), `.vscode/mcp.json`:

```json
{ "servers": { "snout": { "command": "snout", "args": ["mcp"] } } }
```

Cursor, Windsurf, Cline and Claude Desktop use the `mcpServers` key:

```json
{ "mcpServers": { "snout": { "command": "snout", "args": ["mcp"] } } }
```

The server offers two tools. `snout_read` reads a file inside the project: source comes back
whole; generated, vendored, minified and build files come back as the first lines,
an outline and a search command. `snout_classify` says what kind of file a path is and what a
whole read would cost. Agents pick tools by their description, so an MCP client uses
`snout_read` when it decides to, not on every read. Where the agent has read hooks, use them.

## The MCP servers your agent connects to

In Claude Code, every MCP server's results pass through Snout, whatever the server: an issue
tracker, a wiki, a browser, a database. Large results come back as their structure and first
items (the full result is saved under `.snout/squeeze/`), and a result identical to one the agent
already received comes back as a pointer to it. Savings are tracked per server:

```bash
snout audit             # each server: calls, tokens that reached context, tokens saved;
                        # plus servers that are configured but never used
```

The dashboard (`snout dashboard`) and Snout Cloud show the same per-server table.

