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
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { configDir, type Paths } from "../config.js";
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

/**
 * `snout logout`: the server stops accepting this machine's token, then the saved login is
 * deleted. Offline, the local half still happens and the message says how to finish it.
 */
export async function logout(): Promise<string> {
  let saved: Credentials | null = null;
  try {
    saved = JSON.parse(readFileSync(credsPath(), "utf8")) as Credentials;
  } catch {
    // no saved login
  }
  if (!saved?.token) {
    forgetCredentials();
    return process.env.SNOUT_TOKEN ? "Not logged in. This machine syncs with SNOUT_TOKEN; unset it to stop." : "Not logged in.";
  }
  let disconnected = false;
  try {
    disconnected = (await post(`${saved.url}/api/token/revoke`, {}, saved.token)).status === 200;
  } catch {
    // offline: the local half still happens
  }
  forgetCredentials();
  return disconnected
    ? `Logged out. ${saved.url} no longer accepts this machine's syncs; what it already sent stays. The local ledger is untouched.`
    : `Logged out here. ${saved.url} could not be reached to disconnect this machine; disconnect it on the dashboard's Environments page.`;
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

/** The server's slugs: lowercase letters, digits and dashes (labels, agents), plus `.:_` in model names. */
const slug = (s: string, max: number): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
export const modelSlug = (m: string): string => (m ? modelKey(m).replace(/[^a-z0-9.:_-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 64) : "");

/**
 * Rows whose names collapse to one slug ("opus[1m]" and "opus") become one row: the server keys
 * a day by these names, so two rows with the same key would refuse the whole sync.
 */
function merge<T extends object>(rows: T[], key: (r: T) => string, sum: (keyof T)[]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const prev = m.get(k);
    if (!prev) {
      m.set(k, { ...r });
      continue;
    }
    for (const f of sum) {
      const a = prev[f] as unknown as number | null;
      const b = r[f] as unknown as number | null;
      (prev as Record<keyof T, unknown>)[f] = a === null || b === null ? null : a + b;
    }
  }
  return [...m.values()];
}

export function buildPayload(paths: Paths, version: string, now = new Date(), days = SYNC_DAYS): SyncPayload {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const dayRows = dailyAggregates(readDecisions(paths.ledger, 20_000), since)
    .map((d) => ({ ...d, client: slug(d.client, 32) || "claude", label: slug(d.label, 32) || "other", model: modelSlug(d.model) }));
  const spendRows = [...readSpend(paths.projectDir, join(paths.snoutDir, "spend-cache.json"), configDir()).values()]
    .flat()
    .filter((r) => r.day >= since)
    .map((r) => ({ ...r, client: slug(r.client, 32) || "claude", model: modelSlug(r.model) }))
    .filter((r) => r.model);
  return {
    v: 1,
    snout: version,
    project: { key: projectKey(paths.projectDir), name: basename(paths.projectDir).slice(0, 80) },
    days: merge(dayRows, (d) => `${d.day}\0${d.client}\0${d.label}\0${d.model}`, ["reads", "gated", "inContext", "heldBack", "couldHoldBack"]),
    ...(sessionOf(paths) ? { run: createHash("sha256").update(sessionOf(paths)!).digest("hex").slice(0, 32) } : {}),
    spend: merge(spendRows, (r) => `${r.day}\0${r.client}\0${r.model}`, ["requests", "input", "cacheWrite", "cacheRead", "output", "costUsd"])
      .map((r) => ({ ...r, costUsd: r.costUsd === null ? null : Math.round(r.costUsd * 1e6) / 1e6 })),
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
/** The newest sync from any project on this machine, for the local dashboard's "last sync". */
export const machineSyncState = () => join(configDir(), "cloud-sync.json");

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
    if (result.ok) {
      mkdirSync(configDir(), { recursive: true });
      writeFileSync(machineSyncState(), JSON.stringify({ at: new Date().toISOString(), project: payload.project.name }) + "\n");
    }
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
  // The hosted cloud is in private beta: say so, and that everything local works without it.
  const beta = url === DEFAULT_CLOUD_URL ? " Snout Cloud is in private beta; everything local works without it. To join: https://usesnout.xyz/contact" : "";
  try {
    // The machine's name labels it on the dashboard's Environments page, so two laptops differ.
    start = await post(`${url}/api/device/start`, { client: "snout-cli", label: hostname().slice(0, 40) });
  } catch (err) {
    say(`Could not reach ${url}: ${(err as Error).message}.${beta}`);
    return false;
  }
  if (start.status !== 200 || !start.json?.device_code) {
    say(`${url} did not start a login (${start.status}).${beta}`);
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
      say(`Logged in as ${res.json.user} (${res.json.team}). Totals sync when a session ends; \`snout sync\` sends them now and \`snout sync --dry-run\` shows what is sent. Dashboard: ${url}/app`);
      return true;
    }
    say(`Login ${res.status === 410 ? "expired" : "was refused"}. Run \`snout login\` to try again.`);
    return false;
  }
  say("Login timed out. Run `snout login` to try again.");
  return false;
}
