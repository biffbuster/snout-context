/**
 * Overview: what the agents cost, what Snout kept out, and what is running now.
 * Layout follows design-references/overview.png: model cards, insight, executions, trend,
 * cost table, agent time.
 */
import type { Overview } from "../../api.js";
import { ago, basis, card, cardWith, chip, clientName, dur, empty, h, icon, logo, modelLogo, modelName, pct, short, stat, tail, tok, usd } from "../dom.js";
import { lineChart, stack, ticks } from "../charts.js";
import type { Ctx, PageHandle } from "../ctx.js";

const CLIENT_COLOR: Record<string, string> = { claude: "#d97757", codex: "#10a37f", cursor: "#6b7280", gemini: "#4796e3" };
const colorOf = (client: string) => CLIENT_COLOR[client] ?? "#8b8b94";

export function bucketLabel(t: string, bucket: number): string {
  const d = new Date(t);
  if (bucket >= 86400) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (bucket >= 3600) return d.toLocaleTimeString(undefined, { hour: "numeric" });
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const RANGE_TEXT: Record<string, string> = { live: "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time", custom: "Custom range" };

export async function overviewPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const o = await ctx.get<Overview>("overview");
  const rangeText = RANGE_TEXT[o.range.key] ?? "";
  el.append(header(ctx, o, rangeText));
  if (!o.usage.requests && !o.snout.reads) {
    el.append(h("div.grid", null, h("div.span-12", null, card("Nothing yet", null, empty("No agent activity in this range", "Start a Claude Code or Codex session in this project; it shows up here as it works.", "snout dashboard")))));
    return {};
  }
  el.append(
    h("div.grid", null,
      h("div.span-12", null, modelCards(o)),
      h("div.span-3", null, insight(o)),
      h("div.span-4", null, executions(ctx, o)),
      h("div.span-5", null, trend(o, rangeText)),
      h("div.span-6", null, costTable(o, rangeText)),
      h("div.span-6", null, activity(o)),
      h("div.span-7", null, feed(ctx, o)),
      h("div.span-5", null, sources(o))),
  );
  return {};
}

function header(ctx: Ctx, o: Overview, rangeText: string): HTMLElement {
  const est = o.savedUsd;
  return h("div.kpis", null,
    stat("Spend", usd(o.usage.costUsd), h("span", null, basis("list price"), ` ${o.usage.requests.toLocaleString()} requests`)),
    stat("Tokens billed", tok(o.usage.input + o.usage.cacheWrite + o.usage.cacheRead + o.usage.output), h("span", null, basis("measured"), ` ${tok(o.usage.cacheRead)} from cache`)),
    stat("Kept out of context", tok(o.snout.keptOut), h("span", null, basis("estimated"), est !== null ? ` ≈ ${usd(est)} of input` : ""), "accent"),
    stat("Context reduction", pct(o.reduction), h("span", null, basis("estimated"), ` of ${tok(o.snout.keptOut + o.snout.inContext)} Snout saw`)),
    stat("Sessions", `${o.sessions.active} active`, `${o.sessions.total} in ${rangeText.toLowerCase()}`),
    o.snout.couldKeepOut ? stat("Would keep out", tok(o.snout.couldKeepOut), h("span", null, basis("estimated"), " in observe mode; not a saving"), "warn") : null,
  );
}

function modelCards(o: Overview): HTMLElement {
  const cards = o.models.slice(0, 4);
  if (!cards.length) return h("section.card", null, empty("No model usage", "The agents' logs show no requests in this range."));
  const total = o.usage.input + o.usage.cacheWrite + o.usage.cacheRead + o.usage.output || 1;
  return h("section.card.models", null, cards.map((m) => {
    const tokens = m.usage.input + m.usage.cacheWrite + m.usage.cacheRead + m.usage.output;
    const share = tokens / total;
    const ctxShare = m.contextWindow ? m.peakContext / m.contextWindow : null;
    return h("div.model", null,
      h("div.model-h", null, modelLogo(m.model, 34), h("div", null, h("b", null, modelName(m.model)), h("span", null, `${clientName(m.client)} · ${m.sessions} session${m.sessions === 1 ? "" : "s"}`))),
      h("div.model-b", null,
        h("div", null,
          h("div.model-v.num", null, m.active ? h("span.pulse", { title: "Working now" }) : null, tok(tokens)),
          h("span.model-f", null, h("b", { class: m.today ? "accent-t" : "" }, m.today.toLocaleString()), " requests today")),
        h("div.model-m", null,
          ticks(share, colorOf(m.client), 26, `${pct(share)} of tokens in range`),
          h("span", null, ctxShare !== null ? `peak context ${tok(m.peakContext)}/${tok(m.contextWindow)}` : `${pct(share)} of tokens`))));
  }));
}

function insight(o: Overview): HTMLElement {
  const rows = o.models.filter((m) => m.keptOut > 0).slice(0, 3);
  return card("Performance insight", "Context Snout kept out, per model", rows.length
    ? h("div.tiles", null, rows.map((m) => {
        const seen = m.keptOut + m.usage.input + m.usage.cacheWrite;
        return h("div.tile", null, h("span", null, modelName(m.model)), h("b.num", null, tok(m.keptOut)), h("small", null, m.savedUsd !== null ? `≈ ${usd(m.savedUsd)} input · ` : "", pct(m.keptOut / Math.max(1, seen), 1), " of new input"));
      }), h("p.note", null, basis("estimated"), " Kept-out tokens are sized from content at the gate."))
    : h("div.tiles", null,
        h("div.tile", null, h("span", null, "Repeat reads answered"), h("b.num", null, o.insights.repeats.count.toLocaleString()), h("small", null, tok(o.insights.repeats.tokens), " tokens")),
        h("div.tile", null, h("span", null, "Outputs shortened"), h("b.num", null, o.insights.outputs.count.toLocaleString()), h("small", null, tok(o.insights.outputs.tokens), " tokens")),
        h("div.tile", null, h("span", null, "Compactions"), h("b.num", null, o.insights.compaction.compactions.toLocaleString()), h("small", null, "by the agent"))));
}

function statusChip(status: string): HTMLElement {
  return status === "running" ? chip("Running", "info") : status === "compacted" ? chip("Compacted", "warn") : status === "error" ? chip("Failed", "bad") : chip("Complete", "ok");
}

function executions(ctx: Ctx, o: Overview): HTMLElement {
  return card("Recent executions", "Each prompt and the work it started", o.executions.length
    ? h("ul.list", null, o.executions.slice(0, 6).map((x) => h("li", null,
        h("a.row", { href: `#/workflows/${encodeURIComponent(x.session)}`, title: x.prompt },
          h("span.when", null, ago(x.start)),
          modelLogo(x.model, 22),
          h("span.grow", null, h("b", null, short(x.prompt || "(no prompt text)", 46)), h("small", null, `${modelName(x.model)} · ${x.toolCalls} tools · ${tok(x.tokens)} tok${x.keptOut ? ` · ${tok(x.keptOut)} kept out` : ""}`)),
          statusChip(x.status)))))
    : empty("No prompts in this range", ""));
}

function trend(o: Overview, rangeText: string): HTMLElement {
  const labels = o.series.map((p) => p.t);
  const chart = lineChart(
    [
      { key: "billed", label: "Billed input", color: "var(--accent)", values: o.series.map((p) => p.billed + p.output), area: true },
      { key: "kept", label: "Kept out (est.)", color: "var(--ink-3)", values: o.series.map((p) => p.keptOut), dashed: true },
    ],
    { labels, fmt: tok, xfmt: (t) => bucketLabel(t, o.range.bucket), height: 236 },
  );
  return cardWith("Token usage trend", rangeText, h("div.legend", null, h("span", null, h("i.sw.accent"), "Billed"), h("span", null, h("i.sw.dash"), "Kept out")), chart);
}

function costTable(o: Overview, rangeText: string): HTMLElement {
  const rows = o.costBy.model.filter((m) => m.costUsd > 0 || m.periods.some((p) => p > 0));
  const total = rows.reduce((a, m) => a + m.costUsd, 0) || 1;
  return cardWith("Cost breakdown", "Per model, at list price", h("span.big.num", null, usd(o.usage.costUsd), h("small", null, ` ${rangeText}`)),
    rows.length
      ? h("div.table-wrap", null, h("table.t.cost", null,
          h("thead", null, h("tr", null, h("th", null, "Model"), o.costBy.periods.map((p) => h("th.r", null, periodLabel(p))), h("th.r", null, "Share"))),
          h("tbody", null, rows.map((m) => h("tr", null,
            h("td", null, h("span.cell-logo", null, modelLogo(m.key, 20), h("i.dot", { style: { background: colorOf(m.client) } as Partial<CSSStyleDeclaration> }), modelName(m.key))),
            m.periods.map((p) => h("td.r.num", null, usd(p))),
            h("td.r.num", null, h("b", null, pct(m.costUsd / total))))))))
      : empty("No priced usage", "Requests on models without a list price are counted in tokens only."),
    o.usage.unpriced ? h("p.note", null, icon("info", 13), ` ${o.usage.unpriced} requests used a model with no known price; their cost is not included.`) : null);
}

function periodLabel(p: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return new Date(`${p}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (/^\d{4}-\d{2}$/.test(p)) return new Date(`${p}-15T12:00:00`).toLocaleDateString(undefined, { month: "long" });
  return p;
}

function activity(o: Overview): HTMLElement {
  const rows = o.activity;
  return card("Agent time", "Time spent working today, from turn durations", rows.length
    ? h("div.act", null, rows.map((a) => {
        const delta = a.yesterdayMs ? (a.todayMs - a.yesterdayMs) / a.yesterdayMs : null;
        return h("div.act-col", { style: { "--c": colorOf(a.client) } as unknown as Partial<CSSStyleDeclaration> },
          h("div.act-h", null, logo(a.client, 18), h("span", null, clientName(a.client))),
          h("b.act-v.num", null, dur(a.todayMs)),
          h("span", { class: `delta ${delta === null ? "" : delta >= 0 ? "up" : "down"}` }, delta === null ? `${a.turns} turns today` : `${delta >= 0 ? "↑" : "↓"} ${pct(Math.abs(delta), 0)} vs yesterday`),
          h("div.act-bar", null, h("small.num", null, pct(a.share, 0)), h("i", { style: { height: `${Math.max(6, a.share * 150)}px` } as Partial<CSSStyleDeclaration> })));
      }))
    : empty("No turns today", "Agent time appears once a session finishes a turn today."));
}

function feed(ctx: Ctx, o: Overview): HTMLElement {
  const rows = o.feed.slice(0, 12);
  return cardWith("Live context feed", "Reads and tool results as Snout saw them", h("a.link", { href: "#/sessions" }, "All sessions ", icon("arrow", 13)),
    rows.length
      ? h("ul.feed", null, rows.map((r) => h("li", { class: r.keptOut ? "kept" : "" },
          h("span.when", null, ago(r.ts)),
          h("span", { class: `out ${r.outcome.replace(/ /g, "-")}` }, r.outcome),
          h("span.grow.mono", { title: r.path }, tail(r.path, 3)),
          h("span.muted", null, r.rule),
          h("b.num", null, r.keptOut ? `−${tok(r.keptOut)}` : tok(r.inContext)))))
      : empty("Snout has not seen a read in this range", ctx.boot.mode === "observe" ? "Snout is watching; reads will show here." : "Reads appear here as agents work."),
    h("p.note", null, "Trimming changes what the agent reads. Your files are never modified."));
}

function sources(o: Overview): HTMLElement {
  const top = o.insights.topSources.slice(0, 6);
  const max = Math.max(1, ...top.map((x) => x.keptOut + x.inContext));
  return card("Where context goes", "By kind of content Snout saw", top.length
    ? h("ul.bars-list", null, top.map((x) => h("li", null,
        h("span.k", null, x.key), stack([{ value: x.keptOut, color: "var(--accent)", label: `${tok(x.keptOut)} kept out` }, { value: x.inContext, color: "var(--bar-in)", label: `${tok(x.inContext)} reached context` }, { value: max - x.keptOut - x.inContext, color: "transparent", label: "" }], 8),
        h("b.num", null, tok(x.keptOut)))))
    : empty("No bulk seen", "Lockfiles, build output, logs and big tool results show here when agents read them."));
}
