#!/usr/bin/env node
/**
 * Sits between an agent and Snout's MCP server and logs every message both ways, unchanged, so the
 * handoff check (bench/handoff-check.mjs) scores what the receiver was actually shown, whichever
 * agent it is.
 *
 *   node bench/handoff-mcp-tap.mjs <log.jsonl> <server.mjs> [server args...]
 *
 * The server runs under this Node with the same environment. Each log row: {ts, dir: "in"|"out", msg}.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [log, ...server] = process.argv.slice(2);
const child = spawn(process.execPath, server, { stdio: ["pipe", "pipe", "inherit"], env: process.env });

/** Passes a stream through and logs each complete line (MCP's stdio transport is one JSON message per line). */
function tee(from, to, dir) {
  let buf = "";
  from.on("data", (chunk) => {
    to.write(chunk);
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { msg = { unparsed: line.slice(0, 2000) }; }
      try { appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), dir, msg }) + "\n"); } catch { /* the log is the check's, never the agent's problem */ }
    }
  });
  from.on("end", () => to.end?.());
}

tee(process.stdin, child.stdin, "in");
tee(child.stdout, process.stdout, "out");
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => child.kill("SIGTERM"));
