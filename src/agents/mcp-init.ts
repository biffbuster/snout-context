/**
 * Registers `snout mcp` with an MCP client, in that client's own project config, so its agent gets
 * Snout's read tool and shared memory (memory/tools.ts) with no hand-editing:
 *
 *   cursor   .cursor/mcp.json         { "mcpServers": { "snout": { "type": "stdio", ... } } }
 *   vscode   .vscode/mcp.json         { "servers": { "snout": { "type": "stdio", ... } } }
 *   gemini   .gemini/settings.json    { "mcpServers": { "snout": { ... } } }  (next to its hooks)
 *   claude   .mcp.json                { "mcpServers": { "snout": { ... } } }
 *   codex    .codex/config.toml       [mcp_servers.snout]  (Codex reads it in a trusted folder)
 *
 * Formats as each client documents them (2026-10-21). Merges into an existing file, replaces only
 * Snout's own entry, and leaves every other server alone. The command is this bundle's absolute
 * path, like the hooks `snout init` writes, so the file is per machine.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "../util/atomic.js";

export const MCP_CLIENTS = ["cursor", "vscode", "gemini", "claude", "codex"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];
export const isMcpClient = (c: string | undefined): c is McpClient => (MCP_CLIENTS as readonly string[]).includes(c ?? "");

type Json = Record<string, any>;
const NAME = "snout";

/** This bundle's absolute path: what the client runs with node. */
export function selfScript(): string {
  const script = process.argv[1] ?? "snout";
  try {
    return realpathSync(script);
  } catch {
    return script;
  }
}

export function mcpConfigFile(client: McpClient, projectDir: string): string {
  switch (client) {
    case "cursor": return join(projectDir, ".cursor", "mcp.json");
    case "vscode": return join(projectDir, ".vscode", "mcp.json");
    case "gemini": return join(projectDir, ".gemini", "settings.json");
    case "claude": return join(projectDir, ".mcp.json");
    case "codex": return join(projectDir, ".codex", "config.toml");
  }
}

const serverKey = (client: McpClient) => (client === "vscode" ? "servers" : "mcpServers");

function entry(client: McpClient, script: string, projectDir: string): Json {
  const base = { command: "node", args: [script, "mcp", projectDir] };
  return client === "cursor" || client === "vscode" ? { type: "stdio", ...base } : base;
}

/** Writes Snout's server into the client's config and returns the file. */
export function addMcp(client: McpClient, projectDir: string, script = selfScript()): string {
  const file = mcpConfigFile(client, projectDir);
  if (client === "codex") {
    writeText(file, withTomlServer(readText(file), tomlBlock(script, projectDir)));
    return file;
  }
  const cfg = loadJson(file);
  const key = serverKey(client);
  if (cfg[key] !== undefined && (typeof cfg[key] !== "object" || Array.isArray(cfg[key]))) throw new Error(`${file}: "${key}" is not an object`);
  cfg[key] = { ...(cfg[key] ?? {}), [NAME]: entry(client, script, projectDir) };
  writeText(file, JSON.stringify(cfg, null, 2) + "\n");
  return file;
}

/** Takes Snout's server out of the client's config; true if there was one. */
export function removeMcp(client: McpClient, projectDir: string): { file: string; removed: boolean } {
  const file = mcpConfigFile(client, projectDir);
  if (!existsSync(file)) return { file, removed: false };
  if (client === "codex") {
    const text = readText(file);
    const next = withTomlServer(text, "");
    if (next === text) return { file, removed: false };
    writeText(file, next);
    return { file, removed: true };
  }
  const cfg = loadJson(file);
  const key = serverKey(client);
  if (!cfg[key] || typeof cfg[key] !== "object" || !(NAME in cfg[key])) return { file, removed: false };
  delete cfg[key][NAME];
  if (!Object.keys(cfg[key]).length) delete cfg[key];
  writeText(file, JSON.stringify(cfg, null, 2) + "\n");
  return { file, removed: true };
}

// ---------------------------------------------------------------- TOML, just enough

/** A TOML string: literal ('...') when it can be, so Windows backslashes stay as they are. */
const tomlString = (s: string) => (/['\n\r]/.test(s) ? JSON.stringify(s) : `'${s}'`);

function tomlBlock(script: string, projectDir: string): string {
  return `[mcp_servers.${NAME}]\ncommand = 'node'\nargs = [${[script, "mcp", projectDir].map(tomlString).join(", ")}]\n`;
}

/**
 * The file with Snout's `[mcp_servers.snout]` table (and any `[mcp_servers.snout.*]` subtables)
 * replaced by `block`, or removed when `block` is empty. Every other line is kept as it was.
 */
export function withTomlServer(text: string, block: string): string {
  const lines = text.split(/\r?\n/);
  const header = /^\s*\[\s*mcp_servers\.snout\s*(\.[^\]]*)?\]\s*(#.*)?$/;
  const anyHeader = /^\s*\[/;
  const kept: string[] = [];
  let inOurs = false;
  for (const l of lines) {
    if (header.test(l)) { inOurs = true; continue; }
    if (inOurs && anyHeader.test(l)) inOurs = false;
    if (!inOurs) kept.push(l);
  }
  let out = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  if (block) out = `${out}${out ? "\n\n" : ""}${block.trimEnd()}`;
  return out ? `${out}\n` : "";
}

// ---------------------------------------------------------------- files

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

function loadJson(file: string): Json {
  const text = readText(file);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, text);
}
