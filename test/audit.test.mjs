// MCP tool-list audit and the opt-in concise output mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = new URL("../dist/snout.mjs", import.meta.url).pathname;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "snout-audit-home-"));
  const project = mkdtempSync(join(tmpdir(), "snout-audit-proj-"));
  mkdirSync(join(project, ".snout"), { recursive: true });
  // A tiny stdio MCP server with two tools, for --measure.
  const server = join(home, "fake-mcp.mjs");
  writeFileSync(server, `import { createInterface } from "node:readline";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l);
  if (m.method === "initialize") send(m.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (m.method === "tools/list") send(m.id, { tools: [{ name: "query", description: "Run a SQL query against the warehouse. ".repeat(20), inputSchema: { type: "object", properties: { sql: { type: "string" } } } }, { name: "tables", description: "List tables", inputSchema: { type: "object" } }] });
});`);
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { issues: { command: process.execPath, args: ["x.mjs"] }, warehouse: { command: process.execPath, args: [server] } } }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { type: "http", url: "https://example.invalid/mcp" } }, projects: { [resolve(project)]: { mcpServers: {} } } }));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { figma: { command: "npx", args: ["figma-mcp"] } } }));
  // Session history: issues used twice, a Claude account connector once; warehouse and github never.
  const slug = resolve(project).replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, ".claude", "projects", slug), { recursive: true });
  const call = (name) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name, input: {} }] } });
  writeFileSync(join(home, ".claude", "projects", slug, "s1.jsonl"), [call("mcp__issues__list_issues"), call("mcp__issues__get_issue"), call("mcp__claude_ai_Gmail__search"), call("Read")].join("\n") + "\n");
  return { home, project };
}

const run = (args, home, cwd, input = "") => spawnSync(process.execPath, [CLI, ...args], {
  cwd, input, encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: join(home, ".codex") },
});

test("audit lists configured servers with their usage and how to turn off the unused ones", () => {
  const { home, project } = setup();
  const r = run(["audit", project], home, project);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /issues\s+2 calls\s+project \.mcp\.json/);
  assert.match(r.stdout, /warehouse\s+never used/);
  assert.match(r.stdout, /github\s+never used\s+Claude Code \(user\)/);
  assert.match(r.stdout, /figma\s+usage not tracked\s+Cursor \(user\)/);
  assert.match(r.stdout, /claude_ai_Gmail\s+1 call\s+Claude account connector/);
  assert.match(r.stdout, /github: claude mcp remove github -s user/);
  assert.match(r.stdout, /warehouse: disable it in Claude Code's \/mcp menu/);
  assert.doesNotMatch(r.stdout, /issues: /, "a used server is not flagged");
});

test("--measure starts local servers once and counts what their tool list costs", () => {
  const { home, project } = setup();
  const r = run(["audit", "--measure", project], home, project);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /warehouse.*2 tools, ~\d+ tokens per request/);
  assert.match(r.stdout, /github.*remote server: not measured/);
  assert.match(r.stdout, /tokens each time/, "the unused total is stated");
});

test("concise output is opt-in: off adds nothing, on adds one short instruction at session start", () => {
  const { home, project } = setup();
  const start = () => run(["session-start"], home, project, JSON.stringify({ session_id: "c1", cwd: project }));
  const off = JSON.parse(start().stdout || "{}");
  assert.equal(off.hookSpecificOutput, undefined, "nothing enters context by default");

  const set = run(["output", "concise", project], home, project);
  assert.match(set.stdout, /Concise output on/);
  assert.equal(JSON.parse(readFileSync(join(project, ".snout/config.json"), "utf8")).output, "concise");
  const on = JSON.parse(start().stdout);
  assert.equal(on.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(on.hookSpecificOutput.additionalContext, /be concise/);
  assert.ok(on.hookSpecificOutput.additionalContext.length < 400, "a few dozen tokens, not more");
  assert.match(on.systemMessage, /concise output on/);

  run(["output", "normal", project], home, project);
  assert.equal(JSON.parse(start().stdout || "{}").hookSpecificOutput, undefined);
});
