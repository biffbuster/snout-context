/**
 * Workflows: one agent session drawn as a flow, after design-references/workflow.png. Each
 * prompt starts a branch of model requests; each request fans out to the tool calls it made;
 * Snout's decisions hang under the tool call they acted on; compactions sit in the
 * main line. Built from the agent's transcript and Snout's ledger (/api/trace).
 *
 * It is a record of what ran, so it can be followed live and replayed, not edited: Snout does not
 * run workflows, and a control that implies it does would be false.
 */
import type { SessionRow, Trace, TraceNode } from "../../api.js";
import { ago, basis, chip, clientName, clock, dur, empty, h, icon, logo, modelLogo, modelName, s, short, tok, usd, when } from "../dom.js";
import type { Ctx, PageHandle } from "../ctx.js";

const W = 252;
const HEIGHT: Record<string, number> = { main: 88, tool: 76, snout: 66, cap: 40 };
const GAP_V = 64;
const GAP_H = 28;
const GAP_S = 24;
const COLS = 5;
const MARGIN = 120;

type Group = "agent" | "tools" | "snout" | "context";
const KINDS: { kind: TraceNode["kind"]; label: string; icon: string; group: Group }[] = [
  { kind: "prompt", label: "Prompt", icon: "user", group: "agent" },
  { kind: "request", label: "Model request", icon: "model", group: "agent" },
  { kind: "response", label: "Response", icon: "check", group: "agent" },
  { kind: "subagent", label: "Subagent", icon: "agents", group: "agent" },
  { kind: "read", label: "Read file", icon: "file", group: "tools" },
  { kind: "search", label: "Search", icon: "search", group: "tools" },
  { kind: "shell", label: "Shell command", icon: "terminal", group: "tools" },
  { kind: "edit", label: "Edit file", icon: "edit", group: "tools" },
  { kind: "mcp", label: "MCP tool", icon: "integrations", group: "tools" },
  { kind: "web", label: "Web", icon: "globe", group: "tools" },
  { kind: "tool", label: "Other tool", icon: "bolt", group: "tools" },
  { kind: "kept", label: "Kept out of context", icon: "eyeoff", group: "snout" },
  { kind: "trimmed", label: "Trimmed to its head", icon: "scissors", group: "snout" },
  { kind: "repeat", label: "Repeat read pointer", icon: "repeat", group: "snout" },
  { kind: "output-trim", label: "Output shortened", icon: "compress", group: "snout" },
  { kind: "would", label: "Would keep out", icon: "flag", group: "snout" },
  { kind: "asked", label: "Asked first", icon: "hand", group: "snout" },
  { kind: "brief", label: "Memory pointer", icon: "memory", group: "snout" },
  { kind: "recall", label: "Memory search", icon: "memory", group: "snout" },
  { kind: "compact", label: "Compaction", icon: "compress", group: "context" },
];
const KIND = new Map(KINDS.map((k) => [k.kind, k]));
const GROUP_LABEL: Record<Group, string> = { agent: "Agent", tools: "Tools", snout: "Snout", context: "Context" };
const SNOUT_KINDS = new Set(KINDS.filter((k) => k.group === "snout").map((k) => k.kind));
const CAPS = new Set(["start", "end"]);

const sizeOf = (n: TraceNode): number => (CAPS.has(n.kind) ? HEIGHT.cap! : n.parent && SNOUT_KINDS.has(n.kind) ? HEIGHT.snout! : n.parent ? HEIGHT.tool! : HEIGHT.main!);

interface Placed {
  n: TraceNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Positions for every node: the main line down the middle, tool calls in rows under their request. */
function layout(t: Trace, hidden: Set<string>): { placed: Map<string, Placed>; width: number; height: number } {
  const kids = new Map<string, TraceNode[]>();
  for (const n of t.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const placed = new Map<string, Placed>();
  let y = 0;
  for (const n of t.nodes) {
    if (n.parent) continue;
    const w = CAPS.has(n.kind) ? 200 : W;
    const hh = sizeOf(n);
    placed.set(n.id, { n, x: -w / 2, y, w, h: hh });
    y += hh + GAP_V;
    const tools = (kids.get(n.id) ?? []).filter((k) => !hidden.has(k.kind));
    for (let r = 0; r < tools.length; r += COLS) {
      const row = tools.slice(r, r + COLS);
      let rowH = 0;
      row.forEach((tool, j) => {
        const x = (j - (row.length - 1) / 2) * (W + GAP_H) - W / 2;
        let cy = y;
        placed.set(tool.id, { n: tool, x, y: cy, w: W, h: sizeOf(tool) });
        cy += sizeOf(tool);
        for (const d of (kids.get(tool.id) ?? []).filter((k) => !hidden.has("snout"))) {
          cy += GAP_S;
          placed.set(d.id, { n: d, x, y: cy, w: W, h: sizeOf(d) });
          cy += sizeOf(d);
        }
        rowH = Math.max(rowH, cy - y);
      });
      y += rowH + GAP_V;
    }
  }
  let minX = 0;
  let maxX = 0;
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + p.w);
  }
  for (const p of placed.values()) {
    p.x += -minX + MARGIN;
    p.y += MARGIN;
  }
  return { placed, width: maxX - minX + MARGIN * 2, height: y + MARGIN };
}

function edgePath(a: Placed, b: Placed, kind: string): string {
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const y2 = b.y;
  if (Math.abs(x1 - x2) < 1) return `M${x1},${y1} V${y2}`;
  const mid = kind === "branch" ? y1 + 28 : kind === "merge" ? y2 - 28 : (y1 + y2) / 2;
  const r = Math.min(12, Math.abs(x2 - x1) / 2, Math.abs(mid - y1), Math.abs(y2 - mid));
  const dir = x2 > x1 ? 1 : -1;
  return `M${x1},${y1} V${mid - r} Q${x1},${mid} ${x1 + dir * r},${mid} H${x2 - dir * r} Q${x2},${mid} ${x2},${mid + r} V${y2}`;
}

function metrics(n: TraceNode): string {
  if (n.kind === "request" || n.kind === "response") return `${tok(n.tokens)} tok${n.costUsd ? ` · ${usd(n.costUsd)}` : ""}`;
  if (SNOUT_KINDS.has(n.kind)) {
    if (n.kind === "would") return `${tok(n.keptOut)} would be kept out`;
    if (n.kind === "recall" || n.kind === "brief") return `${tok(n.tokens)} tok added`;
    return n.keptOut ? `−${tok(n.keptOut)} tok kept out` : `${tok(n.tokens)} tok in context`;
  }
  if (n.kind === "compact") return n.tokens ? `${tok(n.tokens)} tok before` : "";
  if (n.kind === "subagent") return `${tok(n.tokens)} tok${n.costUsd ? ` · ${usd(n.costUsd)}` : ""}`;
  if (n.bytes) return `${tok(n.bytes / 4)} tok result${n.endTs ? ` · ${dur(Date.parse(n.endTs) - Date.parse(n.ts))}` : ""}`;
  return n.endTs ? dur(Date.parse(n.endTs) - Date.parse(n.ts)) : "";
}

function statusMark(n: TraceNode): HTMLElement | null {
  if (n.status === "running") return chip("Running", "info");
  if (n.status === "failed") return chip("Failed", "bad");
  if (n.status === "optimized" && !SNOUT_KINDS.has(n.kind)) return chip("Snout", "accent");
  if (n.status === "skipped") return chip("Observe", "warn");
  return null;
}

function nodeEl(p: Placed, selected: boolean): HTMLElement {
  const n = p.n;
  const k = KIND.get(n.kind);
  const isSnout = SNOUT_KINDS.has(n.kind);
  const style = { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` } as Partial<CSSStyleDeclaration>;
  if (CAPS.has(n.kind)) {
    return h("div", { class: `wf-node cap ${selected ? "sel" : ""}`, style, "data-id": n.id, tabindex: 0 }, n.kind === "start" ? icon("play", 13) : icon("stop", 13), h("b", null, n.label), h("small", null, n.kind === "start" ? when(n.ts) : clock(n.ts)));
  }
  const glyph = n.kind === "request" || n.kind === "response" ? modelLogo(n.model ?? "", 20) : n.kind === "mcp" ? logo("mcp", 20) : h("span", { class: `wf-ic k-${k?.group ?? "agent"}` }, icon(k?.icon ?? "bolt", 13));
  const pill = !n.parent && n.kind === "prompt" ? h("span.wf-pill", null, `Turn ${n.turn} · ${clock(n.ts)}`) : null;
  return h("div", { class: `wf-node k-${n.kind} ${isSnout ? "snout" : ""} ${n.parent ? "child" : "main"} st-${n.status} ${selected ? "sel" : ""}`, style, "data-id": n.id, tabindex: 0, title: n.detail },
    pill,
    h("div.wf-h", null, glyph, h("b", null, n.kind === "request" || n.kind === "response" ? (n.kind === "request" ? "Model request" : "Response") : n.label), statusMark(n)),
    h("div.wf-d", null, n.kind === "request" || n.kind === "response" ? modelName(n.model ?? "") : short(n.detail || "", 80)),
    h("div.wf-m", null, metrics(n)));
}

export async function workflowsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  if (ctx.hosted) {
    el.append(empty("Traces stay on the developer's machine", "The hosted dashboard receives daily totals only. Open `snout dashboard` locally to see a session as a workflow."));
    return {};
  }
  const sessions = await ctx.get<SessionRow[]>("sessions", {}, { range: false });
  const id = ctx.route.id ?? sessions.find((x) => x.status === "working")?.id ?? sessions[0]?.id;
  if (!id) {
    el.append(h("div.page-h", null, h("div", null, h("h1", null, "Workflows"))), empty("No sessions yet", "Each agent session shows here as a flow of prompts, model requests, tool calls and Snout's steps."));
    return {};
  }
  const focusTurn = ctx.route.rest[0] ? Number(ctx.route.rest[0]) : null;
  let win: { from?: number; to?: number } = focusTurn ? { from: Math.max(1, focusTurn - 2), to: focusTurn + 3 } : {};
  let trace = await ctx.get<Trace>("trace", { id, from: win.from, to: win.to }, { range: false });
  const hidden = new Set<string>();
  let selected: string | null = null;
  let highlight: string | null = null;
  let follow = trace.session.status === "working" && !focusTurn;
  let replay: { i: number; timer: number; order: string[] } | null = null;
  let tab: "outline" | "details" = "outline";
  // View transform
  let k = 1;
  let tx = 0;
  let ty = 0;

  const viewport = h("div.wf-canvas", { tabindex: 0, "aria-label": "Workflow canvas. Drag to pan, Ctrl+scroll to zoom." });
  const world = h("div.wf-world");
  viewport.append(world);
  const leftPanel = h("aside.wf-left");
  const rightPanel = h("aside.wf-right");
  const zoomLabel = h("span.num", null, "100%");
  const head = h("div.wf-head");
  let current: ReturnType<typeof layout> | null = null;

  const apply = () => {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    zoomLabel.textContent = `${Math.round(k * 100)}%`;
    viewport.style.backgroundSize = `${18 * k}px ${18 * k}px`;
    viewport.style.backgroundPosition = `${tx}px ${ty}px`;
  };
  const zoomAt = (nk: number, cx: number, cy: number) => {
    nk = Math.max(0.15, Math.min(2, nk));
    tx = cx - ((cx - tx) * nk) / k;
    ty = cy - ((cy - ty) * nk) / k;
    k = nk;
    apply();
  };
  const fit = () => {
    if (!current) return;
    const vw = viewport.clientWidth || 900;
    const vh = viewport.clientHeight || 600;
    k = Math.max(0.15, Math.min(1, vw / current.width, vh / current.height));
    tx = (vw - current.width * k) / 2;
    ty = Math.max(0, (vh - current.height * k) / 2);
    apply();
  };
  const focusNode = (nid: string, smooth = true) => {
    const p = current?.placed.get(nid);
    if (!p) return;
    const vw = viewport.clientWidth || 900;
    const vh = viewport.clientHeight || 600;
    if (k < 0.6) k = 0.85;
    tx = vw / 2 - (p.x + p.w / 2) * k;
    ty = vh / 3 - p.y * k;
    world.classList.toggle("anim", smooth);
    apply();
    setTimeout(() => world.classList.remove("anim"), 300);
  };
  const latestNode = (): string | null => {
    let best: Placed | null = null;
    for (const p of current?.placed.values() ?? []) if (!best || p.y > best.y) best = p;
    return best?.n.id ?? null;
  };

  const drawWorld = () => {
    current = layout(trace, hidden);
    const { placed, width, height } = current;
    world.style.width = `${width}px`;
    world.style.height = `${height}px`;
    const svg = s("svg", { class: "wf-edges", width, height, viewBox: `0 0 ${width} ${height}` });
    const future = replay ? new Set(replay.order.slice(replay.i + 1)) : null;
    for (const e of trace.edges) {
      const a = placed.get(e.from);
      const b = placed.get(e.to);
      if (!a || !b) continue;
      const dim = (highlight && !(a.n.kind === highlight || b.n.kind === highlight)) || (future && future.has(b.n.id));
      svg.append(s("path", { d: edgePath(a, b, e.kind), class: `wf-e ${e.kind} ${b.n.status === "running" ? "run" : ""} ${dim ? "dim" : ""}` }));
    }
    const nodes = h("div.wf-nodes");
    for (const p of placed.values()) {
      const el = nodeEl(p, p.n.id === selected);
      if ((highlight && p.n.kind !== highlight) || (future && future.has(p.n.id))) el.classList.add("dim");
      if (replay && replay.order[replay.i] === p.n.id) el.classList.add("now");
      nodes.append(el);
    }
    world.replaceChildren(svg, nodes);
  };

  const drawHead = () => {
    const r = trace.session;
    head.replaceChildren(
      h("div", null,
        h("h1", null, short(r.title, 80)),
        h("p.sub.meta", null, logo(r.client, 18), h("span", null, clientName(r.client)), r.models[0] ? h("span", null, modelName(r.models[0])) : null, h("span", null, when(r.first)), r.status === "working" ? chip("Working", "info") : chip("Idle", "muted"), h("span", null, `${usd(r.usage.costUsd)} `, basis("list price")), h("span.accent-t", null, `${tok(r.snout.keptOut)} kept out`))),
      h("div.page-r", null,
        r.status === "working" ? h("button", { class: `btn ${follow ? "on" : ""}`, "aria-pressed": String(follow), onclick: () => { follow = !follow; drawHead(); if (follow) { const l = latestNode(); if (l) focusNode(l); } } }, icon("live", 15), follow ? "Following live" : "Follow live") : null,
        h("button.btn", { onclick: () => toggleReplay() }, icon(replay ? "pause" : "play", 14), replay ? "Pause replay" : "Replay"),
        h("a.btn", { href: `#/sessions/${encodeURIComponent(r.id)}` }, icon("sessions", 15), "Session details")),
    );
  };

  const toggleReplay = () => {
    if (replay) {
      clearInterval(replay.timer);
      replay = null;
      drawWorld();
      drawHead();
      return;
    }
    const order = [...trace.nodes].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).map((n) => n.id).filter((nid) => current?.placed.has(nid));
    replay = { i: 0, order, timer: 0 };
    replay.timer = window.setInterval(() => {
      if (!replay) return;
      replay.i += 1;
      if (replay.i >= replay.order.length) {
        clearInterval(replay.timer);
        replay = null;
        drawHead();
        drawWorld();
        return;
      }
      drawWorld();
      focusNode(replay.order[replay.i]!, true);
    }, 420);
    drawHead();
    drawWorld();
  };

  const loadWindow = async (w: { from?: number; to?: number }) => {
    win = w;
    trace = await ctx.get<Trace>("trace", { id, from: w.from, to: w.to }, { range: false });
    drawWorld();
    drawLeft();
    drawRight();
  };

  const drawLeft = () => {
    const r = trace.session;
    const sel = h("select.sel.full", { "aria-label": "Session" }, sessions.slice(0, 60).map((x) => h("option", { value: x.id, selected: x.id === id }, `${x.status === "working" ? "● " : ""}${short(x.title, 46)} · ${ago(x.last)}`)));
    sel.addEventListener("change", () => ctx.go(`#/workflows/${encodeURIComponent(sel.value)}`));
    const turns = trace.turns;
    const inWin = (n: number) => n >= trace.window.from && n <= trace.window.to;
    leftPanel.replaceChildren(
      h("div.wf-panel-h", null, icon("workflows", 15), h("b", null, "Run")),
      h("div.wf-sec", null, h("div.wf-sec-h", null, "Session"), sel,
        h("dl.kv", null,
          h("dt", null, "Agent"), h("dd", null, clientName(r.client)),
          h("dt", null, "Model"), h("dd", null, r.models.map(modelName).join(", ") || "–"),
          h("dt", null, "Where"), h("dd", null, r.environment),
          h("dt", null, "Context"), h("dd.num", null, r.contextWindow ? `${tok(r.contextNow)} / ${tok(r.contextWindow)}` : tok(r.contextNow)),
          h("dt", null, "Turns"), h("dd.num", null, `${turns.length} (${trace.window.from}–${trace.window.to} shown)`))),
      h("div.wf-sec.grow", null,
        h("div.wf-sec-h", null, "Turns", turns.length > trace.window.to - trace.window.from + 1 ? h("button.link", { onclick: () => loadWindow({ from: Math.max(1, trace.window.from - 6), to: trace.window.to }) }, "Load earlier") : null),
        h("ol.wf-turns", null, [...turns].reverse().map((t) => h("li", { class: inWin(t.n) ? "in" : "" },
          h("button", { title: t.prompt, onclick: () => {
            if (inWin(t.n)) {
              const p = trace.nodes.find((n) => n.kind === "prompt" && n.turn === t.n);
              if (p) focusNode(p.id);
            } else void loadWindow({ from: Math.max(1, t.n - 2), to: Math.min(turns.length, t.n + 3) }).then(() => { const p = trace.nodes.find((n) => n.kind === "prompt" && n.turn === t.n); if (p) focusNode(p.id); });
          } },
            h("span.n.num", null, t.n),
            h("span.grow", null, h("b", null, short(t.prompt || "(no text)", 56)), h("small", null, `${tok(t.tokens)} tok · ${usd(t.costUsd)}${t.keptOut ? ` · ${tok(t.keptOut)} kept out` : ""}${t.compacted ? " · compacted" : ""}`))))))),
      h("div.wf-sec", null, h("div.wf-sec-h", null, "Show"),
        h("div.wf-checks", null, KINDS.filter((x) => x.group === "tools").map((x) => checkbox(x.label, !hidden.has(x.kind), (on) => { if (on) hidden.delete(x.kind); else hidden.add(x.kind); drawWorld(); })),
          checkbox("Snout's steps", !hidden.has("snout"), (on) => { if (on) hidden.delete("snout"); else hidden.add("snout"); drawWorld(); }))),
    );
  };

  const drawRight = () => {
    const counts = new Map<string, number>();
    for (const n of trace.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    const tabs = h("div.wf-tabs", null,
      h("button", { class: tab === "outline" ? "on" : "", onclick: () => { tab = "outline"; drawRight(); } }, "Steps"),
      h("button", { class: tab === "details" ? "on" : "", onclick: () => { tab = "details"; drawRight(); } }, "Details"));
    if (tab === "details") {
      const n = trace.nodes.find((x) => x.id === selected);
      rightPanel.replaceChildren(tabs, n ? details(n) : h("p.muted.pad", null, "Select a step on the canvas to see what happened."));
      return;
    }
    const groups = (["agent", "tools", "snout", "context"] as Group[]).map((g) => {
      const items = KINDS.filter((x) => x.group === g && counts.get(x.kind));
      if (!items.length) return null;
      return h("div.wf-sec", null, h("div.wf-sec-h", null, GROUP_LABEL[g]),
        items.map((x) => h("button", { class: `wf-pal ${highlight === x.kind ? "on" : ""}`, onclick: () => {
          highlight = highlight === x.kind ? null : x.kind;
          drawWorld();
          drawRight();
          if (highlight) {
            const list = trace.nodes.filter((n) => n.kind === highlight && current?.placed.has(n.id));
            const at = list.findIndex((n) => n.id === selected);
            const next = list[(at + 1) % list.length];
            if (next) focusNode(next.id);
          }
        } }, h("span", { class: `wf-ic k-${g}` }, icon(x.icon, 13)), h("span.grow", null, x.label), h("b.num", null, counts.get(x.kind)))));
    });
    const kept = trace.nodes.reduce((a, n) => a + (SNOUT_KINDS.has(n.kind) && n.kind !== "would" ? n.keptOut : 0), 0);
    rightPanel.replaceChildren(tabs,
      h("div.wf-sum", null, h("div", null, h("span", null, "Kept out here"), h("b.num.accent-t", null, tok(kept))), h("div", null, h("span", null, "Steps"), h("b.num", null, trace.nodes.length))),
      ...groups.filter(Boolean) as HTMLElement[],
      ...(trace.truncated ? [h("p.note.pad", null, `${trace.truncated} steps not drawn to keep the canvas fast. Pick fewer turns.`)] : []));
  };

  const details = (n: TraceNode): HTMLElement => {
    const k2 = KIND.get(n.kind);
    const isSnout = SNOUT_KINDS.has(n.kind);
    const rows: [string, string | Node][] = [["When", `${when(n.ts)}${n.endTs ? ` · took ${dur(Date.parse(n.endTs) - Date.parse(n.ts))}` : ""}`], ["Turn", String(n.turn)]];
    if (n.model) rows.push(["Model", modelName(n.model)]);
    if (n.tokens) rows.push([n.kind === "request" ? "Tokens billed" : isSnout ? "Reached context" : "Tokens", h("span", null, tok(n.tokens), " ", basis(n.kind === "request" || n.kind === "subagent" ? "measured" : "estimated"))]);
    if (n.costUsd !== null && n.costUsd !== undefined) rows.push(["Cost", h("span", null, usd(n.costUsd), " ", basis("list price"))]);
    if (n.keptOut) rows.push([n.kind === "would" ? "Would keep out" : "Kept out", h("span.accent-t", null, tok(n.keptOut), " ", basis("estimated"))]);
    if (n.bytes) rows.push(["Size", `${(n.bytes / 1024).toFixed(1)} KB`]);
    if (n.path) rows.push(["Path", h("span.mono.wrap", null, n.path)]);
    if (n.rule) rows.push(["Kind", n.rule]);
    if (n.agent) rows.push(["Agent", n.agent]);
    return h("div.wf-detail", null,
      h("div.wf-detail-h", null, h("span", { class: `wf-ic k-${k2?.group ?? "agent"}` }, icon(k2?.icon ?? "bolt", 14)), h("div", null, h("b", null, n.label), h("small", null, k2?.label ?? n.kind)), statusMark(n)),
      n.detail ? h("pre.wf-text", null, n.detail) : null,
      h("dl.kv", null, rows.map(([a, b]) => [h("dt", null, a), h("dd", null, b)])),
      n.reason ? h("div.wf-reason", null, h("small", null, n.kind === "request" ? "Usage" : "Snout's reason"), h("p", null, n.reason)) : null,
      isSnout && n.kind !== "recall" && n.kind !== "brief" ? h("p.note", null, icon("info", 13), " Snout changed what the agent was given for this call. The file on disk was not touched.") : null,
      n.path && (n.kind === "read" || isSnout) ? h("a.btn.sm", { href: `#/projects?file=${encodeURIComponent(n.path)}` }, icon("file", 14), "File report") : null);
  };

  // Interaction
  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  viewport.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".wf-node")) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("grab");
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!drag) return;
    tx = drag.tx + e.clientX - drag.x;
    ty = drag.ty + e.clientY - drag.y;
    drag.moved = true;
    if (follow) {
      follow = false;
      drawHead();
    }
    apply();
  });
  const end = () => {
    drag = null;
    viewport.classList.remove("grab");
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(k * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    else {
      tx -= e.deltaX;
      ty -= e.deltaY;
      apply();
    }
  }, { passive: false });
  world.addEventListener("click", (e) => {
    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>(".wf-node");
    if (!nodeEl) return;
    selected = nodeEl.dataset.id ?? null;
    tab = "details";
    drawWorld();
    drawRight();
  });
  viewport.addEventListener("keydown", (e) => {
    const step = 60;
    if (e.key === "+" || e.key === "=") zoomAt(k * 1.15, viewport.clientWidth / 2, viewport.clientHeight / 2);
    else if (e.key === "-") zoomAt(k / 1.15, viewport.clientWidth / 2, viewport.clientHeight / 2);
    else if (e.key === "0") fit();
    else if (e.key === "ArrowUp") { ty += step; apply(); }
    else if (e.key === "ArrowDown") { ty -= step; apply(); }
    else if (e.key === "ArrowLeft") { tx += step; apply(); }
    else if (e.key === "ArrowRight") { tx -= step; apply(); }
    else if (e.key === "Enter" && document.activeElement?.classList.contains("wf-node")) (document.activeElement as HTMLElement).click();
    else return;
    e.preventDefault();
  });

  const bottom = h("div.wf-bottom", null,
    h("div.seg", null,
      h("button", { class: "on", onclick: (e: Event) => { tab = "outline"; markSeg(e); drawRight(); } }, "Outline"),
      h("button", { onclick: (e: Event) => { tab = "details"; markSeg(e); drawRight(); } }, "Details")),
    h("div.wf-zoom", null,
      h("button.icon-btn", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => zoomAt(k / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2) }, icon("minus", 15)),
      zoomLabel,
      h("button.icon-btn", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => zoomAt(k * 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2) }, icon("plus", 15)),
      h("button.icon-btn", { title: "Fit to screen", "aria-label": "Fit to screen", onclick: () => fit() }, icon("fit", 15)),
      h("button.icon-btn", { title: "Latest step", "aria-label": "Jump to latest step", onclick: () => { const l = latestNode(); if (l) focusNode(l); } }, icon("down", 15))));

  el.classList.add("wf-page");
  el.append(head, h("div.wf", null, leftPanel, h("div.wf-mid", null, viewport, bottom), rightPanel));
  drawHead();
  drawLeft();
  drawRight();
  drawWorld();
  requestAnimationFrame(() => {
    const vw = viewport.clientWidth || 900;
    k = Math.min(1, Math.max(0.35, vw / (current?.width ?? vw)));
    tx = (vw - (current?.width ?? 0) * k) / 2;
    ty = 0;
    apply();
    if (focusTurn) {
      const p = trace.nodes.find((n) => n.kind === "prompt" && n.turn === focusTurn);
      if (p) focusNode(p.id, false);
    } else if (follow) {
      const l = latestNode();
      if (l) focusNode(l, false);
    }
  });

  return {
    tick: async () => {
      if (replay) return;
      const latest = win.to === undefined;
      const next = await ctx.get<Trace>("trace", { id, from: latest ? undefined : win.from, to: latest ? undefined : win.to }, { range: false });
      trace = next;
      drawWorld();
      drawLeft();
      drawRight();
      drawHead();
      if (follow) {
        const l = latestNode();
        if (l) focusNode(l);
      }
    },
    dispose: () => {
      if (replay) clearInterval(replay.timer);
    },
  };
}

function markSeg(e: Event): void {
  const b = e.currentTarget as HTMLElement;
  b.parentElement?.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
}

function checkbox(label: string, on: boolean, change: (on: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", checked: on });
  input.addEventListener("change", () => change(input.checked));
  return h("label.check", null, input, h("span", null, label));
}
