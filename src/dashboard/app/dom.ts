/**
 * Small DOM helpers, number formats, icons and connector marks for the dashboard page.
 * No framework: each page renders into a container from fresh data, and the canvas keeps its
 * own state. Every icon is inline SVG, so the page loads nothing.
 */
import { BRANDS, CLAUDE_MARK, OPENAI_MARK } from "./brands.js";

export const SVG_NS = "http://www.w3.org/2000/svg";

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener | Partial<CSSStyleDeclaration>>;

function append(el: Element, kids: Child[]): void {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

function setAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style" && typeof v === "object") {
      // Custom properties (--c) only take effect through setProperty.
      for (const [p, val] of Object.entries(v as Record<string, string>)) if (val !== null && val !== undefined) (el as HTMLElement).style.setProperty(p.startsWith("--") ? p : p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(val));
    }
    else if (k === "class") el.setAttribute("class", String(v));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

/** h("div.card.wide", {attrs}, ...children) */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}` | `${K}#${string}`, attrs?: Attrs | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const [tagId, ...classes] = sel.split(".");
  const [tag, id] = tagId!.split("#");
  const el = document.createElement(tag as K);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(" ");
  setAttrs(el, attrs);
  append(el, kids);
  return el;
}

export function s(tag: string, attrs?: Attrs | null, ...kids: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, kids);
  return el;
}

export const clear = (el: Element): void => el.replaceChildren();

// ---------------------------------------------------------------- formats

export function tok(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, "")}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

export function usd(n: number | null | undefined, opts: { exact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return "<$0.01";
  if (!opts.exact && Math.abs(n) >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const pct = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined || !Number.isFinite(n) ? "–" : `${(n * 100).toFixed(digits).replace(/\.0$/, "")}%`);

export const int = (n: number | null | undefined): string => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString());

export function ago(ts: string | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const when = (ts: string): string => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const clock = (ts: string): string => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

export const short = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** The last segments of a path, so a long one stays readable in a narrow cell. */
export function tail(path: string, n = 2): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > n ? `…/${parts.slice(-n).join("/")}` : path;
}

// ---------------------------------------------------------------- icons

const ICONS: Record<string, string> = {
  overview: "M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z",
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  agents: "M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M9 13v2M15 13v2",
  sessions: "M4 6h16M4 12h16M4 18h10",
  workflows: "M6 3v6M6 15v6M18 9v6M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9 12h6",
  environments: "M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 15a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM6 7h.01M6 17h.01",
  integrations: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
  analytics: "M3 3v18h18M7 15l4-4 3 3 5-6",
  privacy: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  panel: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 3v18",
  chevron: "M9 18l6-6-6-6",
  down: "M6 9l6 6 6-6",
  arrow: "M5 12h14M13 6l6 6-6 6",
  back: "M15 18l-6-6 6-6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  play: "M6 4l14 8-14 8z",
  pause: "M7 4h3v16H7zM14 4h3v16h-3z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  fit: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3",
  x: "M18 6L6 18M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  copy: "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  live: "M12 12h.01M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  terminal: "M4 17l6-6-6-6M12 19h8",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  bolt: "M13 2L3 14h9l-1 8 10-12h-9z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  model: "M12 2l9 5v10l-9 5-9-5V7zM12 22V12M21 7l-9 5-9-5",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  scissors: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12",
  repeat: "M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  eyeoff: "M17.9 17.9A10 10 0 0 1 12 20C5 20 1 12 1 12a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 1 1-4.2-4.2",
  compress: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  restore: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  memory: "M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4M8 12h8M12 8v8",
  flag: "M4 22V4a1 1 0 0 1 1-1h13l-3 5 3 5H5",
  stop: "M6 6h12v12H6z",
  hand: "M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-2a2 2 0 0 0-4 0",
  git: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  cloud: "M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z",
  laptop: "M4 5h16v11H4zM2 20h20",
  phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
  dollar: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  layers: "M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  signout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
};

export function icon(name: string, size = 16, cls = ""): SVGElement {
  return s("svg", { class: `ic ${cls}`, width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, s("path", { d: ICONS[name] ?? ICONS.info! }));
}

// ---------------------------------------------------------------- connector marks

const ALIAS: Record<string, string> = { gemini: "googlegemini", google: "googlegemini", "github.com": "github", drive: "googledrive", gdrive: "googledrive", calendar: "googlecalendar", postgres: "postgresql" };

/** The brand mark for a connector name: an exact slug or alias, else a brand named inside it ("claude_ai_Linear"). */
export function brandOf(name: string): (typeof BRANDS)[string] | null {
  const k = name.toLowerCase().replace(/[^a-z0-9.]/g, "");
  const direct = BRANDS[ALIAS[k] ?? k] ?? (k.startsWith("github.com") ? BRANDS.github : undefined);
  if (direct) return direct;
  const found = Object.keys(BRANDS).sort((a, b) => b.length - a.length).find((slug) => k.includes(slug) || k.includes(BRANDS[slug]!.title.toLowerCase().replace(/[^a-z0-9]/g, "")));
  return found ? BRANDS[found]! : null;
}

/** A connector's mark: the brand's own logo where we have it, else its initial. */
export function logo(kind: string, size = 22): Element {
  const k = kind.toLowerCase();
  const box = (bg: string, ...kids: Child[]) =>
    h("span.logo", { style: { width: `${size}px`, height: `${size}px`, background: bg } as Partial<CSSStyleDeclaration> }, ...kids);
  const svg = (vb: string, ...kids: Child[]) => s("svg", { width: Math.round(size * 0.72), height: Math.round(size * 0.72), viewBox: vb, "aria-hidden": "true" }, ...kids);
  const img = (src: string, cls = "") => box("var(--logo-bg)", h("img", { src, class: cls || null, width: Math.round(size * 0.72), height: Math.round(size * 0.72), alt: "" }));
  if (k === "claude" || k === "anthropic" || k.includes("claude")) return img(CLAUDE_MARK);
  if (k === "codex" || k === "openai" || k.startsWith("gpt") || /^o\d/.test(k)) return img(OPENAI_MARK, "inv");
  const brand = brandOf(k);
  if (brand) {
    // Black marks follow the theme's ink so they stay visible in dark mode.
    const fill = brand.hex === "#000000" || brand.hex === "#181717" ? "var(--logo-ink)" : brand.hex;
    return box("var(--logo-bg)", svg("0 0 24 24", s("title", null, brand.title), s("path", { d: brand.path, fill })));
  }
  if (k === "mcp") {
    return box("var(--logo-bg)", svg("0 0 24 24", s("path", { d: "M4 11l7-7a3 3 0 0 1 4.2 4.2L9.5 14M9.5 14l6-6a3 3 0 0 1 4.2 4.2l-7 7a1.5 1.5 0 0 0 0 2.1L14 22M7 13.5l5.6-5.6", fill: "none", stroke: "var(--logo-ink)", "stroke-width": 1.7, "stroke-linecap": "round" })));
  }
  if (k === "snout") return box("var(--accent-soft)", h("img", { src: SNOUT_MARK, width: Math.round(size * 0.8), height: Math.round(size * 0.8), alt: "" }));
  if (k === "jev" || k === "typesafe") return box("#111827", h("b", { style: { color: "#fff", fontSize: `${Math.round(size * 0.48)}px` } as Partial<CSSStyleDeclaration> }, "J"));
  if (k === "cloud") return box("var(--accent-soft)", icon("cloud", Math.round(size * 0.66), "accent"));
  if (k === "git") return box("var(--logo-bg)", icon("git", Math.round(size * 0.66)));
  if (k === "kimi" || k === "moonshot") return box("#000", h("b", { style: { color: "#fff", fontSize: `${Math.round(size * 0.5)}px` } as Partial<CSSStyleDeclaration> }, "K"));
  if (k === "mistral") return box("var(--logo-bg)", svg("0 0 24 24", s("path", { d: "M3 4h4v4H3zM17 4h4v4h-4zM3 8h8v4H3zM13 8h8v4h-8zM3 12h18v4H3zM3 16h4v4H3zM10 16h4v4h-4zM17 16h4v4h-4z", fill: "#fa520f" })));
  // Anything else: its initial on a color derived from its name.
  let hash = 0;
  for (const c of k) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return box(`hsl(${hue} 55% 92%)`, h("b", { style: { color: `hsl(${hue} 45% 32%)`, fontSize: `${Math.round(size * 0.46)}px` } as Partial<CSSStyleDeclaration> }, (kind.replace(/^mcp[-_:]*/i, "")[0] ?? "?").toUpperCase()));
}

/** The mark for a model, by provider. */
export function modelLogo(model: string, size = 22): Element {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return logo("claude", size);
  if (/^gpt|codex|^o\d/.test(m)) return logo("openai", size);
  if (m.includes("gemini")) return logo("gemini", size);
  if (m.includes("kimi")) return logo("kimi", size);
  if (m.includes("mistral") || m.includes("codestral")) return logo("mistral", size);
  return logo(model, size);
}

export const clientName = (c: string): string => ({ claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI" })[c] ?? c;

/** "claude-opus-5-5" → "Claude Opus 5.5" */
export function modelName(model: string): string {
  const m = model.replace(/-\d{8}$/, "");
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(m);
  if (claude) return `Claude ${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(m);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2][0]!.toUpperCase()}${gpt[2].slice(1)}` : ""}`;
  return m;
}

export const SNOUT_MARK = document.querySelector<HTMLLinkElement>("link[rel=icon]")?.href ?? "";

// ---------------------------------------------------------------- small components

export function chip(text: string, tone: "ok" | "info" | "warn" | "bad" | "accent" | "muted" = "muted", title?: string): HTMLElement {
  return h("span", { class: `chip ${tone}`, title: title ?? null }, text);
}

/** A label that says how a number is known. */
export const basis = (kind: "measured" | "estimated" | "list price" | "count"): HTMLElement => h("span", { class: `basis ${kind === "estimated" ? "est" : ""}`, title: BASIS[kind] }, kind);
const BASIS: Record<string, string> = {
  measured: "From the agents' own usage logs",
  estimated: "Estimated from content size at Snout's gate; not a bill",
  "list price": "Tokens from the agents' logs at public list prices; your plan may bill differently",
  count: "Counted from records on this machine",
};

export function card(title: string | Node, sub?: string | Node | null, ...body: Child[]): HTMLElement {
  return h("section.card", null, h("header.card-h", null, h("div", null, h("h3", null, title), sub ? h("p.sub", null, sub) : null)), ...body);
}

export function cardWith(title: string | Node, sub: string | Node | null, right: Child, ...body: Child[]): HTMLElement {
  return h("section.card", null, h("header.card-h", null, h("div", null, h("h3", null, title), sub ? h("p.sub", null, sub) : null), h("div.card-r", null, right)), ...body);
}

export function empty(title: string, text: string, cmd?: string): HTMLElement {
  return h("div.empty", null, h("b", null, title), h("p", null, text), cmd ? codeLine(cmd) : null);
}

export function codeLine(cmd: string): HTMLElement {
  const btn = h("button.copy", { title: "Copy", "aria-label": "Copy command" }, icon("copy", 13));
  btn.addEventListener("click", () => {
    void navigator.clipboard?.writeText(cmd).then(() => {
      btn.replaceChildren(icon("check", 13));
      setTimeout(() => btn.replaceChildren(icon("copy", 13)), 1200);
    });
  });
  return h("div.code", null, h("code", null, cmd), btn);
}

export function stat(label: string, value: string | Node, foot?: string | Node | null, tone = ""): HTMLElement {
  return h("div", { class: `stat ${tone}` }, h("span.stat-l", null, label), h("b.stat-v.num", null, value), foot ? h("span.stat-f", null, foot) : null);
}

/** A toggle switch. */
export function toggle(on: boolean, label: string, onChange: ((on: boolean) => void) | null, title?: string): HTMLElement {
  const b = h("button", { class: `switch ${on ? "on" : ""}`, role: "switch", "aria-checked": String(on), disabled: !onChange, title: title ?? null }, h("i"));
  if (onChange) b.addEventListener("click", () => onChange(!on));
  return h("label.switch-l", null, b, h("span", null, label));
}

export function table(cols: { label: string; cls?: string }[], rows: Child[][], cls = ""): HTMLElement {
  return h("div.table-wrap", null, h("table", { class: `t ${cls}` }, h("thead", null, h("tr", null, cols.map((c) => h("th", { class: c.cls ?? null }, c.label)))), h("tbody", null, rows.map((r) => h("tr", null, r.map((cell, i) => h("td", { class: cols[i]?.cls ?? null }, cell)))))));
}
