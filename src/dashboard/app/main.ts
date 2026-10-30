/**
 * The dashboard page: a sidebar, a toolbar (project, range, environment) and one page at a time,
 * picked by the URL hash. Data comes from the local server's /api/*; "tick" events on /events
 * say when anything changed, and the page on screen refetches.
 */
import { clear, h, icon, SNOUT_MARK } from "./dom.js";
import { getJson, postAction, query, save, store, type BootX, type Ctx, type Filters, type PageHandle, type Route } from "./ctx.js";
import { overviewPage } from "./pages/overview.js";
import { projectsPage } from "./pages/projects.js";
import { agentsPage } from "./pages/agents.js";
import { sessionsPage } from "./pages/sessions.js";
import { workflowsPage } from "./pages/workflows.js";
import { integrationsPage } from "./pages/integrations.js";
import { analyticsPage } from "./pages/analytics.js";
import { privacyPage } from "./pages/privacy.js";
import { settingsPage } from "./pages/settings.js";
import { createTour, type TourEnv } from "./tour.js";

type Page = (ctx: Ctx, el: HTMLElement) => Promise<PageHandle | void>;

interface NavItem {
  id: string;
  label: string;
  icon: string;
  page: Page;
  /** Pages that use the time range and environment. */
  ranged: boolean;
  group: string;
}

const NAV: NavItem[] = [
  { id: "overview", label: "Overview", icon: "overview", page: overviewPage, ranged: true, group: "Monitor" },
  { id: "sessions", label: "Sessions", icon: "sessions", page: sessionsPage, ranged: true, group: "Monitor" },
  { id: "workflows", label: "Workflows", icon: "workflows", page: workflowsPage, ranged: false, group: "Monitor" },
  { id: "agents", label: "Agents", icon: "agents", page: agentsPage, ranged: true, group: "Monitor" },
  { id: "analytics", label: "Analytics", icon: "analytics", page: analyticsPage, ranged: true, group: "Monitor" },
  { id: "projects", label: "Projects", icon: "projects", page: projectsPage, ranged: true, group: "Workspace" },
  { id: "integrations", label: "Integrations", icon: "integrations", page: integrationsPage, ranged: false, group: "Workspace" },
  { id: "privacy", label: "Security & Privacy", icon: "privacy", page: privacyPage, ranged: false, group: "Control" },
  { id: "settings", label: "Settings", icon: "settings", page: settingsPage, ranged: false, group: "Control" },
];

const RANGES: [string, string][] = [["live", "Live"], ["24h", "24h"], ["7d", "7d"], ["30d", "30d"], ["custom", "Custom"]];
const ENVS: [string, string][] = [["all", "All environments"], ["local", "Local CLI"], ["desktop", "Desktop app"], ["sdk", "SDK / headless"], ["remote", "Remote / mobile"], ["cloud", "Cloud"]];

const root = document.getElementById("app")!;
const filters: Filters = store<Filters>("filters", { range: "7d", from: null, to: null, env: "all", project: null });
let theme: string = store("theme", "light");
let collapsed: boolean = store("collapsed", false);
let boot: BootX | null = null;
let handle: PageHandle | void = undefined;
let renderSeq = 0;
let lastV = "";

function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
}
applyTheme();

function parseRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const parts = (path ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  const page = NAV.some((n) => n.id === parts[0]) ? parts[0]! : "overview";
  return { page, id: parts[1] ?? null, rest: parts.slice(2), params: new URLSearchParams(qs ?? "") };
}

const toasts = h("div.toasts", { role: "status", "aria-live": "polite" });
function toast(text: string, tone: "ok" | "bad" = "ok"): void {
  const t = h("div", { class: `toast ${tone}` }, text);
  toasts.append(t);
  setTimeout(() => t.classList.add("out"), 2600);
  setTimeout(() => t.remove(), 3000);
}

function ctxFor(route: Route): Ctx {
  return {
    boot: boot!,
    filters,
    route,
    get: <T>(name: string, params: Record<string, string | number | null | undefined> = {}, opts: { range?: boolean } = {}) =>
      getJson<T>(`/api/${name}${query(filters, params, opts.range !== false)}`),
    act: async (body) => {
      const m = await postAction(body);
      await loadBoot();
      return m;
    },
    go: (hash) => {
      location.hash = hash;
    },
    toast,
    refresh: () => void render(),
  };
}

async function loadBoot(): Promise<void> {
  boot = await getJson<BootX>(`/api/boot${query(filters, {}, false)}`);
  if (filters.project && boot.project.id !== filters.project) filters.project = boot.project.id;
  lastV = boot.v;
}

// ---------------------------------------------------------------- shell

const side = h("aside.side");
const top = h("header.top");
const main = h("main.main", { id: "main", tabindex: "-1" });
const shell = h("div.shell", null, side, h("div.body", null, top, main), toasts);
const liveDot = h("span.live", { title: "Connected to the local Snout server" }, h("i"), "Live");
const tour = createTour(() => ringTab());
const tourEnv = (): TourEnv => ({ mode: boot!.mode, go: (hash) => { if (location.hash !== hash) location.hash = hash; } });
/** Rings the sidebar tab the tour is talking about. */
function ringTab(): void {
  const t = tour.target();
  for (const a of side.querySelectorAll<HTMLAnchorElement>("a.side-a")) a.classList.toggle("tour-ring", !!t && a.getAttribute("href") === `#/${t}`);
}

function drawSide(route: Route): void {
  shell.classList.toggle("collapsed", collapsed);
  const groups = [...new Set(NAV.map((n) => n.group))];
  clear(side);
  side.append(
    h("div.side-h", null,
      h("a.brand", { href: "#/overview", title: "Snout" }, h("img", { src: SNOUT_MARK, width: 26, height: 22, alt: "" }), h("span", null, "Snout")),
      h("button.icon-btn.collapse", { title: collapsed ? "Expand sidebar" : "Collapse sidebar", "aria-label": "Toggle sidebar", onclick: () => { collapsed = !collapsed; save("collapsed", collapsed); drawSide(route); } }, icon("panel", 17))),
    h("nav.side-nav", { "aria-label": "Pages" }, groups.map((g) => [
      h("div.side-g", null, g),
      NAV.filter((n) => n.group === g).map((n) => h("a", { href: `#/${n.id}`, class: `side-a ${route.page === n.id ? "on" : ""}`, title: n.label, "aria-current": route.page === n.id ? "page" : null }, icon(n.icon, 17), h("span", null, n.label))),
    ])),
    h("div.side-f", null,
      h("div.mode-card", null,
        h("div.mode-l", null, h("span", null, "Snout is"), h("b", { class: `mode-${boot!.mode}` }, boot!.mode)),
        h("p", null, boot!.mode === "enforce" ? "Trimming bulk before it reaches the agent." : boot!.mode === "advise" ? "Trimming, and telling the agent why." : "Watching only. Nothing is trimmed."),
        boot!.controls && boot!.mode !== "enforce" ? h("button.btn.sm.accent", { onclick: async () => { try { toast(await ctxFor(route).act({ type: "mode", value: "enforce" })); render(); } catch (e) { toast((e as Error).message, "bad"); } } }, "Turn on enforce") : null),
      h("div.who", null,
        h("span.avatar", null, icon("laptop", 15)),
        h("div", null, h("b", null, "This machine"), h("span", null, `Local · v${boot!.version}`)))),
  );
  ringTab();
}

function drawTop(route: Route): void {
  const nav = NAV.find((n) => n.id === route.page)!;
  const projectSel = h("select.sel", { "aria-label": "Project", title: boot!.project.dir },
    boot!.projects.map((p) => h("option", { value: p.id, selected: p.id === boot!.project.id }, `${p.name}${p.current ? " (this one)" : ""}${p.snout ? "" : " · no Snout"}`)));
  projectSel.addEventListener("change", async () => {
    filters.project = projectSel.value;
    save("filters", filters);
    await loadBoot();
    render();
  });
  const rangeSeg = h("div.seg", { role: "group", "aria-label": "Time range" }, RANGES.map(([k, l]) => h("button", { class: filters.range === k ? "on" : "", "aria-pressed": String(filters.range === k), onclick: () => { filters.range = k; if (k === "custom" && !filters.from) filters.from = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10); save("filters", filters); render(); } }, l)));
  const custom = filters.range === "custom"
    ? h("div.custom", null,
        h("input", { type: "date", value: filters.from?.slice(0, 10) ?? "", "aria-label": "From", onchange: (e: Event) => { filters.from = (e.target as HTMLInputElement).value || null; save("filters", filters); render(); } }),
        h("span", null, "to"),
        h("input", { type: "date", value: filters.to?.slice(0, 10) ?? "", "aria-label": "To", onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; filters.to = v ? `${v}T23:59:59` : null; save("filters", filters); render(); } }))
    : null;
  const envSel = h("select.sel", { "aria-label": "Environment" }, ENVS.map(([k, l]) => h("option", { value: k, selected: filters.env === k }, l)));
  envSel.addEventListener("change", () => { filters.env = envSel.value; save("filters", filters); render(); });
  clear(top);
  top.append(
    h("div.crumbs", null, h("span.crumb-p", null, boot!.project.name), icon("chevron", 14, "faint"), h("b", null, nav.label), route.id ? [icon("chevron", 14, "faint"), h("span.crumb-id", null, route.id.length > 14 ? `${route.id.slice(0, 8)}…` : route.id)] : null),
    h("div.tools", null,
      projectSel,
      nav.ranged ? [rangeSeg, custom] : null,
      nav.ranged || route.page === "workflows" ? envSel : null,
      liveDot,
      h("button.icon-btn", { title: "Show me around", "aria-label": "Start the dashboard tour", onclick: () => tour.replay(tourEnv()) }, icon("help", 16)),
      h("button.icon-btn", { title: theme === "dark" ? "Light theme" : "Dark theme", "aria-label": "Toggle theme", onclick: () => { theme = theme === "dark" ? "light" : "dark"; save("theme", theme); applyTheme(); drawTop(route); } }, icon(theme === "dark" ? "sun" : "moon", 16))),
  );
}

async function render(): Promise<void> {
  const seq = ++renderSeq;
  const route = parseRoute();
  const nav = NAV.find((n) => n.id === route.page)!;
  if (handle && handle.dispose) handle.dispose();
  handle = undefined;
  drawSide(route);
  drawTop(route);
  const el = h("div.page", { "data-page": route.page });
  const loading = h("div.loading", null, h("i"), "Loading");
  if (!main.firstChild) main.append(loading);
  try {
    const hnd = await nav.page(ctxFor(route), el);
    if (seq !== renderSeq) {
      if (hnd && hnd.dispose) hnd.dispose();
      return;
    }
    handle = hnd;
    main.replaceChildren(el);
    tour.greet(tourEnv());
  } catch (err) {
    if (seq !== renderSeq) return;
    main.replaceChildren(h("div.page", null, h("div.empty.err", null, h("b", null, "This page could not load"), h("p", null, (err as Error).message), h("button.btn", { onclick: () => render() }, "Try again"))));
  }
}

// Live updates: the server sends "tick" with a version whenever records change.
function connect(): void {
  const q = filters.project ? `?project=${encodeURIComponent(filters.project)}` : "";
  const es = new EventSource(`/events${q}`);
  es.addEventListener("open", () => liveDot.classList.add("on"));
  es.addEventListener("error", () => liveDot.classList.remove("on"));
  es.addEventListener("tick", (e) => {
    const v = (JSON.parse((e as MessageEvent).data) as { v: string }).v;
    if (v === lastV) return;
    lastV = v;
    if (handle && handle.tick) handle.tick();
    else if (filters.range === "live" || ["overview", "sessions", "agents"].includes(parseRoute().page)) void render();
  });
  // The older summary stream still runs for other consumers; this page ignores it.
  es.addEventListener("summary", () => undefined);
  connected = es;
}
let connected: EventSource | null = null;

async function start(): Promise<void> {
  root.replaceChildren(shell, tour.el);
  try {
    await loadBoot();
  } catch (err) {
    const msg = (err as Error).message;
    main.replaceChildren(h("div.page", null, h("div.empty.err", null, h("b", null, "Snout's local server did not answer"), h("p", null, `${msg}. Run \`snout dashboard\` again.`))));
    return;
  }
  window.addEventListener("hashchange", () => void render());
  await render();
  connect();
  let lastProject = filters.project;
  setInterval(() => {
    if (filters.project !== lastProject && connected) {
      lastProject = filters.project;
      connected.close();
      connect();
    }
  }, 1000);
}

void start();
