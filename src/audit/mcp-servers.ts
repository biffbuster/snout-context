/**
 * MCP tool-list audit: which MCP servers are configured for this project, how often the agent
 * actually used each one, and (optionally) how many tokens each server's tool list costs.
 *
 * Every connected MCP server sends its full list of tools, with descriptions and input schemas,
 * to the model on every request, whether or not a tool is ever called. A server nobody uses is a
 * fixed tax on every turn. This finds them and says how to turn them off.
 *
 * Usage comes from the agent's own session history (Claude Code transcripts name every tool it
 * called, as mcp__<server>__<tool>), so it works whether or not Snout was running at the time.
 * Nothing here touches the network; `measure` starts local stdio servers only when asked.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface ServerConfig {
  name: string;
  /** Where it is configured, e.g. "project .mcp.json", "Claude Code (user)", "Cursor (project)". */
  source: string;
  agent: "claude" | "cursor" | "gemini" | "codex";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ServerReport extends ServerConfig {
  /** Tool calls seen in the agent's session history in the window. Claude Code only. */
  calls: number | null;
  /** Tool count and estimated tokens of the tool list, when measured. */
  tools?: number;
  listTokens?: number;
  measureError?: string;
}

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

function fromMap(map: unknown, source: string, agent: ServerConfig["agent"]): ServerConfig[] {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map as Record<string, any>).map(([name, c]) => ({
    name,
    source,
    agent,
    command: typeof c?.command === "string" ? c.command : undefined,
    args: Array.isArray(c?.args) ? c.args.map(String) : undefined,
    env: c?.env && typeof c.env === "object" ? c.env : undefined,
    url: typeof c?.url === "string" ? c.url : typeof c?.httpUrl === "string" ? c.httpUrl : undefined,
  }));
}

/** Codex keeps servers in TOML as [mcp_servers.<name>] tables; names are all the audit needs. */
function codexServers(path: string): ServerConfig[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: ServerConfig[] = [];
  const re = /^\s*\[mcp_servers\.("?)([^\]"]+)\1\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ name: m[2]!, source: "Codex (user)", agent: "codex" });
  return out;
}

/** Every MCP server this project's agents will load, across the agents Snout supports. */
export function configuredServers(projectDir: string, home = homedir()): ServerConfig[] {
  const dir = resolve(projectDir);
  const servers: ServerConfig[] = [];
  servers.push(...fromMap(readJson(join(dir, ".mcp.json"))?.mcpServers, "project .mcp.json", "claude"));
  const claude = readJson(join(process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "..") : home, ".claude.json"));
  if (claude) {
    servers.push(...fromMap(claude.mcpServers, "Claude Code (user)", "claude"));
    servers.push(...fromMap(claude.projects?.[dir]?.mcpServers, "Claude Code (this project)", "claude"));
    // Project .mcp.json servers the user turned off in Claude Code are not loaded.
    const disabled: string[] = claude.projects?.[dir]?.disabledMcpjsonServers ?? [];
    for (let i = servers.length - 1; i >= 0; i--) if (servers[i]!.source === "project .mcp.json" && disabled.includes(servers[i]!.name)) servers.splice(i, 1);
  }
  servers.push(...fromMap(readJson(join(dir, ".cursor", "mcp.json"))?.mcpServers, "Cursor (project)", "cursor"));
  servers.push(...fromMap(readJson(join(home, ".cursor", "mcp.json"))?.mcpServers, "Cursor (user)", "cursor"));
  servers.push(...fromMap(readJson(join(dir, ".gemini", "settings.json"))?.mcpServers, "Gemini CLI (project)", "gemini"));
  servers.push(...fromMap(readJson(join(home, ".gemini", "settings.json"))?.mcpServers, "Gemini CLI (user)", "gemini"));
  servers.push(...codexServers(join(process.env.CODEX_HOME || join(home, ".codex"), "config.toml")));
  return servers;
}

/**
 * Calls per server name in this project's Claude Code transcripts from the last `days` days.
 * Transcripts are JSON lines; every tool call names its tool, so a regex over the text is enough
 * and avoids parsing megabytes of JSON.
 */
export function mcpUsage(projectDir: string, days = 30, home = homedir()): Map<string, number> {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects", resolve(projectDir).replace(/[^A-Za-z0-9]/g, "-"));
  const counts = new Map<string, number>();
  if (!existsSync(root)) return counts;
  const since = Date.now() - days * 86_400_000;
  for (const f of readdirSync(root)) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(root, f);
    try {
      if (statSync(path).mtimeMs < since) continue;
      const text = readFileSync(path, "utf8");
      const re = /"name":"mcp__([A-Za-z0-9_.-]+?)__[A-Za-z0-9_.-]+"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
    } catch {
      // an unreadable transcript just isn't counted
    }
  }
  return counts;
}

/** Claude Code names a server's tools mcp__<name>__…, with characters outside [A-Za-z0-9_-] replaced. */
const toolPrefixName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Starts a local stdio server, asks for its tool list, and estimates the tokens it costs per
 * request (about 4 characters per token of JSON). Remote servers are skipped. Never throws.
 */
/** How long a server gets to answer with its tool list. SNOUT_MCP_MEASURE_MS raises it on slow or loaded machines (CI). */
const MEASURE_TIMEOUT_MS = Number(process.env.SNOUT_MCP_MEASURE_MS) || 10_000;

export function measureServer(s: ServerConfig, timeoutMs = MEASURE_TIMEOUT_MS): Promise<{ tools: number; listTokens: number } | { error: string }> {
  if (!s.command) return Promise.resolve({ error: s.url ? "remote server: not measured" : "no command to start" });
  return new Promise((done) => {
    let settled = false;
    const finish = (r: { tools: number; listTokens: number } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      done(r);
    };
    const child = spawn(s.command!, s.args ?? [], { env: { ...process.env, ...(s.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => finish({ error: `no tool list within ${timeoutMs / 1000}s` }), timeoutMs);
    child.on("error", (e) => finish({ error: e.message.slice(0, 80) }));
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools) ? msg.result.tools : [];
          finish({ tools: tools.length, listTokens: Math.round(JSON.stringify(tools).length / 4) });
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "snout-audit", version: "1" } } }) + "\n");
  });
}

export async function auditServers(projectDir: string, opts: { days?: number; measure?: boolean; home?: string } = {}): Promise<ServerReport[]> {
  const servers = configuredServers(projectDir, opts.home);
  const usage = mcpUsage(projectDir, opts.days ?? 30, opts.home);
  const reports: ServerReport[] = servers.map((s) => ({ ...s, calls: s.agent === "claude" ? usage.get(toolPrefixName(s.name)) ?? 0 : null }));
  // Servers the agent used that no local file configures: account connectors and plugin servers.
  const known = new Set(servers.map((s) => toolPrefixName(s.name)));
  for (const [name, calls] of usage) {
    if (!known.has(name)) reports.push({ name, source: name.startsWith("claude_ai_") ? "Claude account connector" : "plugin or other config", agent: "claude", calls });
  }
  if (opts.measure) {
    await Promise.all(reports.map(async (r) => {
      const m = await measureServer(r);
      if ("error" in m) r.measureError = m.error;
      else Object.assign(r, m);
    }));
  }
  return reports;
}

/** How to turn a server off, in the agent's own terms. */
export function disableHint(r: ServerConfig): string {
  if (r.agent === "claude") return r.source === "project .mcp.json" ? `disable it in Claude Code's /mcp menu, or remove it from .mcp.json` : `claude mcp remove ${r.name}${r.source.includes("user") ? " -s user" : ""}`;
  if (r.agent === "cursor") return "turn it off in Cursor Settings → MCP";
  if (r.agent === "gemini") return "remove it from mcpServers in .gemini/settings.json";
  return `remove [mcp_servers.${r.name}] from ~/.codex/config.toml`;
}
