/** Analytics: spend and tokens over time, by model and agent, what fills context, and how sessions grow. */
import type { Analytics } from "../../api.js";
import { basis, card, cardWith, clientName, dur, empty, h, modelLogo, logo, modelName, pct, short, table, tail, tok, usd } from "../dom.js";
import { bars, lineChart, stack } from "../charts.js";
import type { Ctx, PageHandle } from "../ctx.js";
import { bucketLabel } from "./overview.js";

const PALETTE = ["var(--accent)", "#7c8cf5", "#e8a33d", "#3fb38f", "#a678d9", "#d26a6a"];

export async function analyticsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const a = await ctx.get<Analytics>("analytics");
  el.append(h("div.page-h", null, h("div", null, h("h1", null, "Analytics"), h("p.sub", null, "Measured spend from the agents' logs; Snout's numbers are estimates from content size"))));
  const labels = a.series.map((p) => p.t);
  const x = (t: string) => bucketLabel(t, a.range.bucket);
  const grid = h("div.grid");
  grid.append(
    h("div.span-8", null, cardWith("Tokens", "Billed per bucket, and what Snout kept out", h("span", null, basis("measured"), " ", basis("estimated")),
      lineChart([
        { key: "billed", label: "Billed input", color: "var(--accent)", values: a.series.map((p) => p.billed), area: true },
        { key: "out", label: "Output", color: "#7c8cf5", values: a.series.map((p) => p.output) },
        { key: "kept", label: "Kept out (est.)", color: "var(--ink-3)", values: a.series.map((p) => p.keptOut), dashed: true },
      ], { labels, fmt: tok, xfmt: x, height: 260 }))),
    h("div.span-4", null, cardWith("Spend", "List price per bucket", basis("list price"), bars(a.series.map((p) => p.costUsd), labels, { fmt: (n) => usd(n), xfmt: x, height: 260 }))),
    h("div.span-6", null, card("By model", null, a.byModel.length
      ? table([{ label: "Model" }, { label: "Requests", cls: "r" }, { label: "Billed", cls: "r" }, { label: "Cache hit", cls: "r" }, { label: "Cost", cls: "r" }, { label: "Kept out", cls: "r" }],
          a.byModel.map((m) => [h("span.cell-logo", null, modelLogo(m.key, 20), modelName(m.key)), h("span.num", null, m.usage.requests.toLocaleString()), h("span.num", null, tok(m.usage.input + m.usage.cacheWrite + m.usage.cacheRead + m.usage.output)), h("span.num", null, pct(m.usage.cacheRead / Math.max(1, m.usage.input + m.usage.cacheWrite + m.usage.cacheRead), 0)), h("span.num", null, m.usage.unpriced === m.usage.requests ? "no price" : usd(m.usage.costUsd)), h("span.num.accent-t", null, m.keptOut ? tok(m.keptOut) : "–")]))
      : empty("No usage", ""))),
    h("div.span-6", null, card("By agent", null, a.byAgent.length
      ? table([{ label: "Agent" }, { label: "Sessions", cls: "r" }, { label: "Requests", cls: "r" }, { label: "Cost", cls: "r" }, { label: "Kept out", cls: "r" }],
          a.byAgent.map((m) => [h("span.cell-logo", null, logo(m.key, 20), clientName(m.key)), h("span.num", null, m.sessions), h("span.num", null, m.usage.requests.toLocaleString()), h("span.num", null, usd(m.usage.costUsd)), h("span.num.accent-t", null, m.keptOut ? tok(m.keptOut) : "–")]))
      : empty("No usage", ""))),
    h("div.span-5", null, composition(a)),
    h("div.span-7", null, growth(a)),
    h("div.span-4", null, card("Memory and compaction", "Compaction is the agent's own. Snout tells a new session that earlier ones exist; the agent searches them when it needs to",
      h("div.tiles.two", null,
        h("div.tile", null, h("span", null, "Compactions"), h("b.num", null, a.retention.compactions)),
        h("div.tile", null, h("span", null, "History pointers"), h("b.num", null, a.retention.hints)),
        h("div.tile", null, h("span", null, "Memory searches"), h("b.num", null, a.retention.searches)),
        h("div.tile", null, h("span", null, "Records opened"), h("b.num", null, a.retention.opened)),
        ...(a.retention.notesShown ? [h("div.tile", null, h("span", null, "Automatic notes shown"), h("b.num", null, a.retention.notesShown))] : [])))),
    h("div.span-4", null, card("Repeat reads", "Same file, same content, same agent", h("div.tiles.two", null,
      h("div.tile", null, h("span", null, "Answered with a pointer"), h("b.num", null, a.repeats.count), h("small", null, `${tok(a.repeats.tokens)} tok kept out`)),
      h("div.tile", null, h("span", null, "Read again by another agent"), h("b.num", null, a.crossAgent.count), h("small", null, `${tok(a.crossAgent.tokens)} tok; subagents share no context, so Snout does not block these`))))),
    h("div.span-4", null, card("Most-read files", null, a.files.length
      ? h("ul.mini", null, a.files.slice(0, 10).map((f) => h("li", null, h("span.mono", { title: f.key }, tail(f.key, 3)), h("span.muted.num", null, `${f.reads}×`), h("b.num", null, tok(f.inContext + f.keptOut)))))
      : empty("No reads", ""))),
    h("div.span-12", null, card("Costliest turns", "Prompts by what the work they started cost", a.turns.length
      ? table([{ label: "Prompt" }, { label: "Time", cls: "r" }, { label: "Tokens", cls: "r" }, { label: "Cost", cls: "r" }, { label: "Kept out", cls: "r" }],
          a.turns.map((t) => [h("a", { href: `#/workflows/${encodeURIComponent(t.session)}`, title: t.prompt }, short(t.prompt || "(no text)", 100)), h("span.num", null, dur(t.durationMs)), h("span.num", null, tok(t.tokens)), h("span.num", null, usd(t.costUsd)), h("span.num.accent-t", null, t.keptOut ? tok(t.keptOut) : "–")]), "compact")
      : empty("No turns", ""))),
  );
  el.append(grid);
  return {};
}

function composition(a: Analytics): HTMLElement {
  const rows = a.composition.filter((c) => c.inContext + c.keptOut > 0).slice(0, 9);
  const total = rows.reduce((x, c) => x + c.inContext + c.keptOut, 0) || 1;
  return cardWith("What agents asked to read", "By kind, what reached context and what Snout kept out", basis("estimated"), rows.length
    ? h("div", null,
        stack(rows.map((c, i) => ({ value: c.inContext + c.keptOut, color: PALETTE[i % PALETTE.length]!, label: `${c.key}: ${tok(c.inContext + c.keptOut)}` })), 12),
        h("ul.bars-list", null, rows.map((c, i) => h("li", null, h("span.k", null, h("i.dot", { style: { background: PALETTE[i % PALETTE.length] } as Partial<CSSStyleDeclaration> }), c.key), h("span.muted.num", null, pct((c.inContext + c.keptOut) / total, 0)), h("span.num", null, tok(c.inContext)), h("b.num.accent-t", null, c.keptOut ? `−${tok(c.keptOut)}` : "")))))
    : empty("Nothing seen", ""));
}

function growth(a: Analytics): HTMLElement {
  const g = a.growth.filter((x) => x.points.length > 2).slice(0, 4);
  if (!g.length) return card("Context growth", "Per request, in recent sessions", empty("Not enough requests", ""));
  const n = Math.max(...g.map((x) => x.points.length));
  const series = g.map((x, i) => ({ key: x.session, label: short(x.title, 30), color: PALETTE[i % PALETTE.length]!, values: Array.from({ length: n }, (_, j) => x.points[j]?.context ?? NaN).map((v) => (Number.isNaN(v) ? 0 : v)) }));
  return cardWith("Context growth", "Context size at each request in recent sessions; drops are compactions", basis("measured"),
    lineChart(series, { labels: Array.from({ length: n }, (_, i) => String(i + 1)), fmt: tok, xfmt: (l) => `#${l}`, height: 240 }),
    h("div.legend", null, g.map((x, i) => h("span", null, h("i.sw", { style: { background: PALETTE[i % PALETTE.length] } as Partial<CSSStyleDeclaration> }), short(x.title, 34)))));
}
