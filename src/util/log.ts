/**
 * stdout is the hook protocol. Anything written there that is not our JSON response
 * breaks the hook, so this module is the only sanctioned way to emit diagnostics and
 * it writes exclusively to stderr.
 */
import { appendFileSync, existsSync, statSync, truncateSync } from "node:fs";

let errorLogPath: string | null = null;

export function setErrorLog(p: string): void {
  errorLogPath = p;
}

export function debug(...parts: unknown[]): void {
  if (!process.env.SNOUT_DEBUG) return;
  process.stderr.write(`[snout] ${parts.map(fmt).join(" ")}\n`);
}

export function warn(...parts: unknown[]): void {
  process.stderr.write(`[snout] ${parts.map(fmt).join(" ")}\n`);
}

/** Records a failure without ever throwing out of a hook. */
export function recordError(where: string, err: unknown): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    where,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
  debug("error", line);
  if (!errorLogPath) return;
  try {
    // An error that recurs every hook invocation would otherwise fill the disk quietly.
    if (existsSync(errorLogPath) && statSync(errorLogPath).size > 1_048_576) {
      truncateSync(errorLogPath, 0);
    }
    appendFileSync(errorLogPath, line + "\n");
  } catch {
    /* a failure to log a failure is where we stop */
  }
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
