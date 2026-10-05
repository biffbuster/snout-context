/**
 * Snout Cloud, the opt-in half: `snout login`, `snout sync`, `snout logout`.
 *
 * Nothing is sent until the user logs in. What is sent is per-day totals: for each day,
 * coding agent and label, how many reads and how many tokens reached context or were held
 * back. No file contents, no paths, no reasons. The project is identified by a hash of its
 * git remote (or folder), plus its folder name. `snout sync --dry-run` prints the payload.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Paths } from "../config.js";
import { readDecisions } from "../ledger/store.js";
import { dailyAggregates, type DayRow } from "../dashboard/summary.js";
import { readSpend, type SpendRow } from "../spend/usage.js";
import { modelKey } from "../spend/prices.js";

export interface Credentials {
  url: string;
  token: string;
  user: string;
  team: string;
}

export interface SyncPayload {
  v: 1;
  snout: string;
  project: { key: string; name: string };
  days: DayRow[];
  /** A hash of the agent session this sync belongs to: a cloud agent's run counts once. */
  run?: string;
  /** Measured usage per day, agent and model, from the agents' own logs, with its list-price cost. */
  spend: SpendRow[];
}

/** Snout Cloud. `--url` or SNOUT_CLOUD_URL points the CLI at another deployment (a self-hosted one, or local dev). */
export const DEFAULT_CLOUD_URL = "https://app.usesnout.xyz";
/** Days of history each sync resends. Totals replace, so resending is safe. */
const SYNC_DAYS = 35;
/** Agent activity triggers a sync at most this often, so the team dashboard is about a minute behind. */
export const AUTO_SYNC_MS = 60 * 1000;
/** Between full resends, a sync carries only today and yesterday: small enough to send every minute. */
const RECENT_DAYS = 2;
const FULL_SYNC_MS = 60 * 60 * 1000;
/** Cloud agents are short-lived: sync every minute so a run's end isn't lost. */
export const AGENT_SYNC_MS = 60 * 1000;

export function configDir(): string {
  if (process.env.SNOUT_CONFIG_DIR) return process.env.SNOUT_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "snout");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "snout");
}

const credsPath = () => join(configDir(), "cloud.json");

export function loadCredentials(): Credentials | null {
  // Cloud agents (CI, Claude Code on the web, Codex cloud) can't log in through a browser:
  // a workspace key from the team dashboard, set as SNOUT_TOKEN, stands in for a login.
  const env = process.env.SNOUT_TOKEN;
  if (env && env.startsWith("snt_")) return { url: cloudUrl(), token: env, user: "agent", team: "workspace" };
  try {
    const c = JSON.parse(readFileSync(credsPath(), "utf8")) as Credentials;
    return c.url && c.token ? c : null;
  } catch {
    return null;
  }
}

function saveCredentials(c: Credentials): void {
  const p = credsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // the token is a password; an existing file keeps its old mode otherwise
  } catch {
    // Windows has no POSIX modes; the file sits in the user's own profile.
  }
}

export function forgetCredentials(): boolean {
  if (!existsSync(credsPath())) return false;
  rmSync(credsPath());
  return true;
}

export function cloudUrl(flag?: string): string {
  return (flag || process.env.SNOUT_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/+$/, "");
}

/** The session the hooks last saw, from `.snout/state.json`. */
function sessionOf(paths: Paths): string | null {
  try {
    const s = JSON.parse(readFileSync(join(paths.snoutDir, "state.json"), "utf8"));
    return typeof s.session === "string" && s.session ? s.session : null;
  } catch {
    return null;
  }
}

/** A stable id for the project that reveals neither its remote nor its path. */
export function projectKey(projectDir: string): string {
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: projectDir, encoding: "utf8", timeout: 3000 });
  const remote = r.status === 0 ? r.stdout.trim() : "";
  // github.com:me/x.git, https://user:pw@github.com/me/x and https://github.com/me/x are one project.
  const norm = remote
    ? remote.replace(/^[a-z+]+:\/\/([^@/]*@)?/i, "").replace(/^[^@/]*@/, "").replace(":", "/").replace(/\.git$/, "").toLowerCase()
    : projectDir;
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

export function buildPayload(paths: Paths, version: string, now = new Date(), days = SYNC_DAYS): SyncPayload {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return {
    v: 1,
    snout: version,
    project: { key: projectKey(paths.projectDir), name: basename(paths.projectDir).slice(0, 80) },
    days: dailyAggregates(readDecisions(paths.ledger, 20_000), since),
    ...(sessionOf(paths) ? { run: createHash("sha256").update(sessionOf(paths)!).digest("hex").slice(0, 32) } : {}),
    spend: [...readSpend(paths.projectDir, join(paths.snoutDir, "spend-cache.json"), configDir()).values()]
      .flat()
      .filter((r) => r.day >= since)
      .map((r) => ({ ...r, model: modelKey(r.model).slice(0, 64), costUsd: r.costUsd === null ? null : Math.round(r.costUsd * 1e6) / 1e6 })),
  };
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // an error page, not JSON
  }
  return { status: res.status, json };
}

const syncState = (paths: Paths) => join(paths.snoutDir, "cloud-sync.json");

export function lastSync(paths: Paths): { at: string; ok: boolean; error?: string; fullAt?: string } | null {
  try {
    return JSON.parse(readFileSync(syncState(paths), "utf8"));
  } catch {
    return null;
  }
}

export async function sync(paths: Paths, version: string): Promise<{ ok: boolean; message: string }> {
  const creds = loadCredentials();
  if (!creds) return { ok: false, message: "Not logged in. Run `snout login` first; nothing is sent until you do." };
  const last = lastSync(paths);
  const full = !last?.fullAt || Date.now() - Date.parse(last.fullAt) > FULL_SYNC_MS;
  const payload = buildPayload(paths, version, new Date(), full ? SYNC_DAYS : RECENT_DAYS);
  let result: { ok: boolean; message: string };
  try {
    const { status, json } = await post(`${creds.url}/api/ingest`, payload, creds.token);
    if (status === 200) result = { ok: true, message: `Synced ${payload.days.length} day-row(s) for ${payload.project.name} to ${creds.team}.` };
    else if (status === 401) result = { ok: false, message: "The saved login was revoked or expired. Run `snout login` again." };
    else if (status === 402) result = { ok: false, message: `${String(json?.error ?? "Plan limit reached.").slice(0, 200)}${json?.upgrade ? ` ${String(json.upgrade).slice(0, 200)}` : ""} (Snout itself keeps working locally.)` };
    else result = { ok: false, message: `Sync failed (${status}): ${String(json?.error ?? "no detail").slice(0, 200)}` };
  } catch (err) {
    result = { ok: false, message: `Sync failed: ${(err as Error).message}` };
  }
  try {
    mkdirSync(paths.snoutDir, { recursive: true });
    const fullAt = full && result.ok ? new Date().toISOString() : last?.fullAt;
    writeFileSync(syncState(paths), JSON.stringify({ at: new Date().toISOString(), ok: result.ok, ...(fullAt ? { fullAt } : {}), ...(result.ok ? {} : { error: result.message }) }) + "\n");
  } catch {
    // a missed stamp only means the next session syncs again
  }
  return result;
}

/**
 * The device flow: the CLI asks for a code, the user approves it in the browser while
 * signed in, and the CLI polls until it receives a token. No password touches the terminal.
 */
export async function login(url: string, say: (s: string) => void, openBrowser: (u: string) => void): Promise<boolean> {
  if (!url) {
    say("Snout Cloud has no default address yet. Pass one: snout login --url https://<your-snout-cloud>");
    return false;
  }
  let start;
  try {
    start = await post(`${url}/api/device/start`, { client: "snout-cli" });
  } catch (err) {
    say(`Could not reach ${url}: ${(err as Error).message}`);
    return false;
  }
  if (start.status !== 200 || !start.json?.device_code) {
    say(`${url} did not start a login (${start.status}).`);
    return false;
  }
  const { device_code, user_code, verify_url, interval = 3, expires_in = 600 } = start.json;
  say(`Open ${verify_url} and approve code ${user_code}.`);
  openBrowser(verify_url);
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    let res;
    try {
      res = await post(`${url}/api/device/poll`, { device_code });
    } catch {
      continue; // a dropped request is retried on the next tick
    }
    if (res.status === 428) continue;
    if (res.status === 200 && res.json?.token) {
      saveCredentials({ url, token: res.json.token, user: res.json.user, team: res.json.team });
      say(`Logged in as ${res.json.user} (${res.json.team}). Totals sync when a session ends; \`snout sync --dry-run\` shows what is sent.`);
      return true;
    }
    say(`Login ${res.status === 410 ? "expired" : "was refused"}. Run \`snout login\` to try again.`);
    return false;
  }
  say("Login timed out. Run `snout login` to try again.");
  return false;
}
