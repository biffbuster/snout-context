# Using Snout with other agents

Snout's rules are the same for every agent. What differs is how much each agent's hooks let
it do.

| Agent | How Snout connects | What it can do | Status |
| --- | --- | --- | --- |
| Claude Code | Plugin hooks | Trims bulk reads, attaches an outline | Tested live |
| Gemini CLI | `BeforeTool` / `AfterTool` hooks | Trims bulk reads by rewriting offset and limit | Tested against the documented hook format |
| Codex CLI | `PreToolUse` / `PostToolUse` / `SessionStart` hooks | Denies ambiguous bulk prints; trims a single literal PowerShell generated/vendored read; restores bounded context after compaction | Windows deny/recovery, 60-line trim, and manual compaction tested live; a three-pair forced-read task passed quality checks, with a three-repo held-out pilot recorded but its merge gate still open |
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

`snout init codex` installs PreToolUse, PostToolUse, and SessionStart. It removes older
Snout-owned UserPromptSubmit and Stop entries if re-run, while preserving other tools' hooks.
Codex loads project hooks only in a trusted folder, and runs a new hook only after you
approve it. Open Codex in the project once, trust the folder, and approve these three Snout
hooks with `/hooks`. Until then the hooks are skipped without any error.

Codex reads files through shell commands, so Snout gates whole-file prints such as
`cat package-lock.json` and points the agent to a targeted search. On Windows, a single
literal `Get-Content -LiteralPath` of a generated or vendored file can instead be
rewritten to a 60-line read; a live Codex session received only those lines. Compound
commands and credentials remain on the deny path. Codex output Squeeze is still off:
the local CLI's only live-proven replacement response reported a tool error. Codex can
truncate command output on its own, so use the agent's reported usage rather than
Snout's file-size estimate for savings. A three-pair forced-read Windows pilot passed
its task checks with a 25.3% lower effective-token proxy on the bulk task and 5.3%
higher proxy on the control. The older Codex A/B in [the benchmark](benchmark.md)
does not score this new trim. See [its validation record](harness-validation-codex.md).

## Using the merged checkout on a Mac

After the reviewed branch is merged and pulled on the Mac, start from that checkout and confirm the pulled `dist/snout.mjs` is the intended version. Run `node dist/snout.mjs init codex` in each Mac project where Codex should use Snout; the ignored `.codex/hooks.json` is machine-local and cannot be copied from Windows. Open that project in Codex, trust it, and approve the three generated hooks. The commands should point at the Mac's own `dist/snout.mjs`, not a Windows path. Start in observe mode, check `snout doctor` and a bounded/whole-read gate, then enable enforce only after the local hook check. A Git pull does not update a Claude Code plugin already copied into Claude's cache; refresh that installed plugin from the merged version and restart its session, then confirm its hooks and normal task tests. Shared Snout policy can run on both agents, but Codex output Squeeze and cloud/automatic-compaction parity remain separate validation items.

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

