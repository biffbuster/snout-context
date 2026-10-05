/**
 * What a tool actually put into context, from the PostToolUse `tool_response` field.
 *
 * The field was read as `tool_result.content` until 2026-09-23, a name Claude Code never
 * sends: every "real returned size" silently fell back to the file's size on disk, so a
 * 20-line Read of an 18 KB lockfile was recorded as 18 KB. The shape also varies by tool
 * and version, so this accepts every one seen or documented rather than trusting one.
 */
export function responseText(response: unknown, depth = 0): string {
  if (depth > 4 || response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map((r) => responseText(r, depth + 1)).join("\n"); // MCP content blocks
  if (typeof response !== "object") return "";
  const o = response as Record<string, unknown>;
  const file = o.file as Record<string, unknown> | undefined;
  if (file && typeof file.content === "string") return file.content; // Read
  if (typeof o.stdout === "string") return o.stdout + (typeof o.stderr === "string" ? o.stderr : ""); // Bash
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content; // Grep content mode
  if (Array.isArray(o.content)) return responseText(o.content, depth + 1); // MCP { content: [...] }
  if (typeof o.result === "string") return o.result; // WebFetch
  if (Array.isArray(o.filenames)) return o.filenames.filter((f) => typeof f === "string").join("\n"); // Glob, Grep files mode
  return JSON.stringify(o);
}

/** Byte length of what the tool returned, or 0 when the payload carried nothing. */
export function responseBytes(response: unknown): number {
  const text = responseText(response);
  return text ? Buffer.byteLength(text) : 0;
}
