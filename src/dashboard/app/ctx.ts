/** What every page gets: the boot info, the toolbar's filters, and a way to fetch and act. */
import type { Boot } from "../api.js";

export type BootX = Boot & { coach: string | null; now: string; v: string };

export interface Filters {
  range: string;
  from: string | null;
  to: string | null;
  env: string;
  project: string | null;
  /** Snout Cloud: the team the page shows. */
  team?: string | null;
}

export interface Route {
  page: string;
  id: string | null;
  rest: string[];
  params: URLSearchParams;
}

export interface PageHandle {
  /** Called when the server says something changed. Return without re-rendering to skip. */
  tick?: () => void;
  dispose?: () => void;
}

export interface Ctx {
  boot: BootX;
  filters: Filters;
  route: Route;
  get<T>(name: string, params?: Record<string, string | number | null | undefined>, opts?: { range?: boolean }): Promise<T>;
  act(body: Record<string, unknown>): Promise<string>;
  go(hash: string): void;
  toast(text: string, tone?: "ok" | "bad"): void;
  /** Re-render the current page (after an action). */
  refresh(): void;
  /** Snout Cloud: a cookie-authenticated write to one of its endpoints; resolves to the JSON reply. */
  post<T = { ok?: boolean }>(path: string, body?: Record<string, unknown>): Promise<T>;
  /** Snout Cloud: show another team, or reload who is signed in after a change. */
  switchTeam(id: string): Promise<void>;
  hosted: boolean;
  /** "local" reads this machine; "cloud" is the Snout Cloud preview drawn from sample data. */
  view: View;
  setView(v: View): void;
}

export type View = "local" | "cloud";

const KEY = document.body.dataset.key ?? "";

export function store<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`snout.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, v: unknown): void {
  try {
    localStorage.setItem(`snout.${key}`, JSON.stringify(v));
  } catch {
    // private window: the setting lasts for this visit only
  }
}

export function query(f: Filters, params: Record<string, string | number | null | undefined> = {}, withRange = true): string {
  const q = new URLSearchParams();
  if (f.project) q.set("project", f.project);
  if (f.env && f.env !== "all") q.set("env", f.env);
  if (withRange) {
    q.set("range", f.range);
    if (f.range === "custom") {
      if (f.from) q.set("from", f.from);
      if (f.to) q.set("to", f.to);
    }
  }
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      // not json
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export async function postJson<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  let j: (T & { error?: string }) | null = null;
  try {
    j = (await r.json()) as T & { error?: string };
  } catch {
    // not json
  }
  if (!r.ok) throw new Error(j?.error ?? `failed (${r.status})`);
  return j as T;
}

export async function postAction(body: Record<string, unknown>): Promise<string> {
  const r = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json", "x-snout-key": KEY }, body: JSON.stringify(body) });
  const j = (await r.json()) as { ok?: boolean; message?: string; error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? `failed (${r.status})`);
  return j.message ?? "Done.";
}
