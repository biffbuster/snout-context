/**
 * For the stand-in agents (fake-claude.mjs, fake-codex.mjs): SWE_FAKE_MCP holds JSON
 * `{ command, args, env, calls: [{ name, arguments }] }`, an MCP server as the session was given it and
 * the tool calls a real agent might make. The stand-in makes them once, before its Stop, so a dry run
 * exercises what happens during a session (a lesson proposed, then checked at Stop). Returns each
 * call with the text that came back; an empty list when SWE_FAKE_MCP is unset.
 */
import { spawnSync } from "node:child_process";

export function fakeMcpCalls() {
  if (!process.env.SWE_FAKE_MCP) return [];
  const spec = JSON.parse(process.env.SWE_FAKE_MCP);
  const msgs = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...spec.calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: c })),
  ];
  const r = spawnSync(spec.command, spec.args, { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env: { ...process.env, ...spec.env }, encoding: "utf8", timeout: 60_000 });
  const replies = (r.stdout ?? "").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return spec.calls.map((c, i) => ({ ...c, text: (replies.find((x) => x.id === i + 1)?.result?.content ?? []).map((x) => x.text ?? "").join("\n") }));
}
