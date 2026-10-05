/**
 * `snout mcp`: a Model Context Protocol server over stdio, for agents with no read hook
 * (Copilot agent mode, Windsurf, Cline, Zed...). It offers a read tool the agent can use
 * in place of its own: bulk files come back as their head, an outline and a search hint;
 * everything else comes back whole. No dependencies: newline-delimited JSON-RPC 2.0.
 *
 * Reads are limited to the project directory, secrets and binaries are refused, and every
 * error becomes a tool error rather than a crash.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "./config.js";
import { bandOf, searchHint, worthGating } from "./gate/decide.js";
import { outline } from "./gate/outline.js";
import { tier0, toRel } from "./gate/tier0.js";
import { estimateTokens, fmtTokens } from "./ledger/tokens.js";

const HEAD_LINES = 60;
const HEAD_BYTES = 6 * 1024;
const MAX_BYTES = 256 * 1024;

const TOOLS = [
  {
    name: "snout_read",
    description:
      "Read a file from this project. Prefer this over reading whole files: for lockfiles, generated code, vendored libraries, minified bundles and build output it returns the first lines, an outline of the file with line numbers, and a search command, instead of tens of thousands of tokens. Ordinary source files come back in full. Pass offset and limit (1-based line numbers) to read a specific range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the project root." },
        offset: { type: "number", description: "1-based line to start from." },
        limit: { type: "number", description: "Number of lines to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "snout_classify",
    description:
      "Say what kind of file this is before reading it: source, lockfile, generated, vendored, minified, build output or secret, with a confidence score and roughly how many tokens a whole read would cost.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

type Json = Record<string, any>;

export function startMcp(projectDir: string, cfg: Config, version: string, write: (s: string) => void): void {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const reply = handle(line, projectDir, cfg, version);
      if (reply) write(JSON.stringify(reply) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

/** One JSON-RPC message in, at most one reply out. Exported for tests. */
export function handle(line: string, projectDir: string, cfg: Config, version: string): Json | null {
  let msg: Json;
  try {
    msg = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // a notification: no reply
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "snout", version },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      try {
        const text = callTool(String(params?.name ?? ""), params?.arguments ?? {}, projectDir, cfg);
        return ok({ content: [{ type: "text", text }] });
      } catch (err) {
        return ok({ content: [{ type: "text", text: (err as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function callTool(name: string, args: Json, projectDir: string, cfg: Config): string {
  const abs = inProject(String(args.path ?? ""), projectDir);
  const rel = toRel(abs, projectDir);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`No such file: ${rel}`);
  const bytes = statSync(abs).size;
  // The tool is opt-in, so it acts on the classification itself, whatever the project's mode.
  const d = tier0({ absPath: abs, projectDir, cfg });
  const band = bandOf(d);
  const tokens = estimateTokens(bytes, rel);

  if (name === "snout_classify") {
    if (!d) return `${rel}: source · band read · ~${fmtTokens(tokens)} tokens if read whole. No rule flags it, so it is read in full.`;
    return `${rel}: ${d.rule} · confidence ${d.confidence.toFixed(2)} · band ${band} · ~${fmtTokens(tokens)} tokens if read whole.\n${d.reason}`;
  }
  if (name !== "snout_read") throw new Error(`Unknown tool: ${name}`);
  if (d?.rule === "secret") throw new Error(`${rel} looks like a secret or credential. Ask the user before reading it.`);
  if (d?.rule === "binary" || d?.rule === "binary-content") throw new Error(`${rel} is binary; reading it yields nothing usable.`);

  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 0;

  if (offset || limit) {
    const from = Math.max(1, offset || 1);
    const to = Math.min(lines.length, limit ? from + limit - 1 : lines.length);
    return cap(`${rel} (lines ${from}–${to} of ${lines.length})\n\n${lines.slice(from - 1, to).join("\n")}`);
  }

  if (d && band === "act" && worthGating(d, true, tokens)) {
    const oneLine = bytes / Math.max(1, lines.length) > 1000;
    const map = outline(rel, d.rule, text);
    const hint = searchHint(d.rule, rel, { oneLine });
    const note = `${rel}: ${d.reason} (~${fmtTokens(tokens)} tokens).`;
    if (oneLine) return `${note} It is one very long line, so no head is shown.${map}${hint}`;
    let used = 0, n = 0;
    for (const l of lines.slice(0, HEAD_LINES)) {
      if (used + l.length + 1 > HEAD_BYTES) break;
      used += l.length + 1;
      n++;
    }
    return `${note} Showing lines 1–${n} of ${lines.length}.${map} Call snout_read again with offset and limit for other lines.${hint}\n\n${lines.slice(0, n).join("\n")}`;
  }
  return cap(text);
}

function inProject(p: string, projectDir: string): string {
  if (!p) throw new Error("path is required");
  const abs = resolve(isAbsolute(p) ? p : join(projectDir, p));
  const r = relative(projectDir, abs);
  if (r.startsWith("..") || isAbsolute(r)) throw new Error("snout_read only reads files inside the project.");
  return abs;
}

function cap(s: string): string {
  return Buffer.byteLength(s) > MAX_BYTES ? s.slice(0, MAX_BYTES) + `\n\n[truncated at ${MAX_BYTES / 1024} KB; pass offset and limit to read further]` : s;
}
