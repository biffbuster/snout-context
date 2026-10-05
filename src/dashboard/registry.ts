/**
 * Which local dashboards are running, one per project, so a new session reuses the open one
 * instead of starting another. Kept in the user's config directory; entries whose process has
 * gone are ignored and overwritten.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeAtomic } from "../util/atomic.js";

export interface DashboardEntry {
  port: number;
  pid: number;
  startedAt: string;
}

const file = (configDir: string) => join(configDir, "dashboards.json");

function read(configDir: string): Record<string, DashboardEntry> {
  try {
    return JSON.parse(readFileSync(file(configDir), "utf8"));
  } catch {
    return {};
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running dashboard for a project, or null. */
export function liveDashboard(configDir: string, projectDir: string): DashboardEntry | null {
  const e = read(configDir)[resolve(projectDir)];
  return e && alive(e.pid) ? e : null;
}

export function registerDashboard(configDir: string, projectDir: string, entry: DashboardEntry): void {
  try {
    const all = read(configDir);
    for (const [k, v] of Object.entries(all)) if (!alive(v.pid)) delete all[k];
    all[resolve(projectDir)] = entry;
    const f = file(configDir);
    if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
    writeAtomic(f, JSON.stringify(all, null, 2) + "\n");
  } catch {
    // an unregistered dashboard still works; a new session just starts another
  }
}
