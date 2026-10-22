/** Sessions: every agent session in the project, and one session in detail. */
import type { SessionDetail, SessionRow } from "../../api.js";
import { ago, basis, card, cardWith, chip, clientName, dur, empty, h, icon, logo, modelLogo, modelName, pct, short, stat, table, tail, tok, usd, when } from "../dom.js";
import { lineChart, stack } from "../charts.js";
import type { Ctx, PageHandle } from "../ctx.js";

const ENV_LABEL: Record<string, string> = { local: "Local CLI", desktop: "Desktop", sdk: "SDK", remote: "Remote", cloud: "Cloud" };

export async function sessionsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  if (ctx.route.id) return detail(ctx, el, ctx.route.id);
  const rows = await ctx.get<SessionRow[]>("sessions");
  const client = ctx.route.params.get("client");
  let filter = "";
  let only = client ?? "all";
  const body = h("div");
  const draw = () => {
    const list = rows.filter((r) => (only === "all" || r.client === only || (only === "working" && r.status === "working")) && (!filter || `${r.title} ${r.task} ${r.id} ${r.branch}`.toLowerCase().includes(filter)));
    body.replaceChildren(list.length ? sessionTable(list) : empty("No sessions match", "Change the range, environment or search."));
  };
  const search = h("input.search", { type: "search", placeholder: "Search sessions", "aria-label": "Search sessions" });
  search.addEventListener("input", () => { filter = search.value.toLowerCase(); draw(); });
  const seg = h("div.seg", { role: "group" }, [["all", "All"], ["working", "Working"], ["claude", "Claude Code"], ["codex", "Codex"]].map(([k, l]) =>
    h("button", { class: only === k ? "on" : "", onclick: (e: Event) => { only = k!; (e.currentTarget as HTMLElement).parentElement!.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget)); draw(); } }, l)));
  const totals = rows.reduce((a, r) => ({ cost: a.cost + r.usage.costUsd, kept: a.kept + r.snout.keptOut, working: a.working + (r.status === "working" ? 1 : 0) }), { cost: 0, kept: 0, working: 0 });
  el.append(
    h("div.page-h", null, h("div", null, h("h1", null, "Sessions"), h("p.sub", null, `${rows.length} sessions · ${totals.working} working · ${usd(totals.cost)} at list price · ${tok(totals.kept)} kept out (est.)`)), h("div.page-r", null, search, seg)),
    body,
  );
  draw();
  return {};
}

function statusOf(r: SessionRow): HTMLElement {
  return r.status === "working" ? chip("Working", "info") : chip("Idle", "muted");
}

function sessionTable(rows: SessionRow[]): HTMLElement {
  return h("section.card.flush", null, table(
    [{ label: "Session" }, { label: "Agent" }, { label: "Environment" }, { label: "Turns", cls: "r" }, { label: "Context", cls: "r" }, { label: "Cost", cls: "r" }, { label: "Kept out", cls: "r" }, { label: "Last active", cls: "r" }, { label: "" }],
    rows.slice(0, 300).map((r) => [
      h("a.cell-main", { href: `#/sessions/${encodeURIComponent(r.id)}` }, h("b", null, short(r.title, 70)), h("small.mono", null, `${r.id.slice(0, 8)}${r.branch ? ` · ${r.branch}` : ""}`)),
      h("span.cell-logo", null, logo(r.client, 20), h("span", null, clientName(r.client), h("small", null, r.models[0] ? modelName(r.models[0]) : ""))),
      h("span", null, ENV_LABEL[r.environment] ?? r.environment),
      h("span.num", null, r.turns.toLocaleString()),
      contextCell(r),
      h("span.num", null, usd(r.usage.costUsd)),
      h("span.num.accent-t", null, r.snout.keptOut ? tok(r.snout.keptOut) : "–"),
      h("span", null, statusOf(r), " ", h("small", null, ago(r.last))),
      h("a.icon-btn", { href: `#/workflows/${encodeURIComponent(r.id)}`, title: "Open as workflow" }, icon("workflows", 15)),
    ]),
  ));
}

function contextCell(r: SessionRow): HTMLElement {
  if (!r.contextWindow) return h("span.num", null, tok(r.contextNow));
  const share = r.contextNow / r.contextWindow;
  return h("span.ctx-cell", { title: `${tok(r.contextNow)} of ${tok(r.contextWindow)} at the latest request` }, h("span.num", null, tok(r.contextNow)), stack([{ value: share, color: share > 0.8 ? "var(--warn)" : "var(--ink-3)", label: "" }, { value: 1 - share, color: "var(--seg)", label: "" }], 4));
}

async function detail(ctx: Ctx, el: HTMLElement, id: string): Promise<PageHandle> {
  const d = await ctx.get<SessionDetail>("session", { id }, { range: false });
  const r = d.session;
  el.append(
    h("div.page-h", null,
      h("div", null,
        h("a.back", { href: "#/sessions" }, icon("back", 14), "Sessions"),
        h("h1", null, short(r.title, 90)),
        h("p.sub.meta", null, logo(r.client, 18), h("span", null, clientName(r.client)), r.models.map((m) => h("span", null, modelName(m))), h("span", null, ENV_LABEL[r.environment] ?? r.environment), r.branch ? h("span.mono", null, r.branch) : null, h("span", null, `started ${when(r.first)}`), statusOf(r))),
      h("div.page-r", null, h("a.btn.primary", { href: `#/workflows/${encodeURIComponent(r.id)}` }, icon("workflows", 15), "Open workflow"))),
    h("div.kpis", null,
      stat("Cost", usd(r.usage.costUsd), h("span", null, basis("list price"), ` ${r.usage.requests} requests`)),
      stat("Tokens billed", tok(r.usage.input + r.usage.cacheWrite + r.usage.cacheRead + r.usage.output), h("span", null, basis("measured"), ` ${pct(r.usage.cacheRead / Math.max(1, r.usage.input + r.usage.cacheWrite + r.usage.cacheRead))} cached`)),
      stat("Context now", tok(r.contextNow), r.contextWindow ? `of ${tok(r.contextWindow)} window` : "window unknown"),
      stat("Kept out", tok(r.snout.keptOut), h("span", null, basis("estimated"), r.savedUsd !== null ? ` ≈ ${usd(r.savedUsd)}` : ""), "accent"),
      stat("Turns", r.turns.toLocaleString(), `${r.toolCalls} tool calls · ${r.errors} errors`),
      stat("Compactions", r.compactions.toLocaleString(), "by the agent")),
  );
  const grid = h("div.grid");
  if (d.timeline.length > 1) {
    const marks = d.compactions.map((c) => ({ i: Math.max(0, d.timeline.findIndex((p) => p.t >= c.ts)), label: "compacted" })).filter((m) => m.i > 0);
    grid.append(h("div.span-8", null, card("Context size per request", "Input + cache reads + cache writes at each request (measured)", lineChart([{ key: "ctx", label: "Context", color: "var(--accent)", values: d.timeline.map((p) => p.context), area: true }], { labels: d.timeline.map((p) => p.t), fmt: tok, xfmt: (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }), marks, height: 220 }))));
  }
  grid.append(h("div.span-4", null, card("Compactions", "When the agent summarized its context", d.compactions.length
    ? h("ul.list", null, d.compactions.map((c) => h("li", null, h("div.row", null, icon("compress", 15), h("span.grow", null, h("b", null, c.preTokens ? `${tok(c.preTokens)} → ${tok(c.postTokens ?? 0)}` : c.trigger), h("small", null, `${c.trigger} · ${when(c.ts)}`))))))
    : empty("No compactions", "This session never filled its context."))));
  grid.append(h("div.span-6", null, card("Turns", "Each prompt, its cost and what Snout kept out", d.turns.length
    ? table([{ label: "#" }, { label: "Prompt" }, { label: "Time", cls: "r" }, { label: "Tokens", cls: "r" }, { label: "Cost", cls: "r" }, { label: "Snout", cls: "r" }],
        d.turns.slice(-40).reverse().map((t) => [h("span.num", null, t.n), h("a", { href: `#/workflows/${encodeURIComponent(r.id)}/${t.n}`, title: t.prompt }, short(t.prompt || "(no text)", 60), t.compacted ? chip("compacted", "warn") : null), h("span.num", null, dur(t.durationMs)), h("span.num", null, tok(t.tokens)), h("span.num", null, usd(t.costUsd)), snoutCell(t.keptOut, t.checked)]), "compact")
    : empty("No prompts", ""))));
  grid.append(h("div.span-12", null, passedCard(d, r)));
  grid.append(h("div.span-6", null, card("Tools", "Calls and result size", d.tools.length
    ? table([{ label: "Tool" }, { label: "Calls", cls: "r" }, { label: "Errors", cls: "r" }, { label: "Result size", cls: "r" }], d.tools.slice(0, 16).map((t) => [h("span.mono", null, t.name), h("span.num", null, t.calls), h("span.num", null, t.errors || "–"), h("span.num", null, `${tok(t.resultBytes / 4)} tok`)]), "compact")
    : empty("No tool calls", ""))));
  grid.append(h("div.span-12", null, cardWith("What Snout saw", "Every read and tool result in this session", h("span.muted", null, `${d.feed.length} rows`), d.feed.length
    ? table([{ label: "When" }, { label: "Agent" }, { label: "Tool" }, { label: "Path" }, { label: "Kind" }, { label: "Outcome" }, { label: "In context", cls: "r" }, { label: "Kept out", cls: "r" }],
        d.feed.slice(0, 120).map((f) => [h("span.muted", null, ago(f.ts)), f.agent, h("span.mono", null, f.tool), h("span.mono", { title: f.path }, tail(f.path, 3)), f.rule, h("span", { class: `out ${f.outcome.replace(/ /g, "-")}` }, f.outcome), h("span.num", null, tok(f.inContext)), h("span.num.accent-t", null, f.keptOut ? tok(f.keptOut) : "–")]), "compact")
    : empty("Snout recorded nothing for this session", "Its hooks may not have been active, or the agent read nothing Snout gates."))));
  el.append(grid);
  return {};
}

/** A turn's Snout column: what it kept out, else how many tool calls passed its hooks untouched. */
function snoutCell(kept: number, calls: number): HTMLElement {
  if (kept) return h("span.num.accent-t", { title: `${calls} tool calls passed Snout's hooks` }, tok(kept));
  if (!calls) return h("span.num.muted", null, "–");
  return h("span.num.muted", { title: `Snout checked ${calls} tool calls and found nothing worth trimming` }, `0 of ${calls}`);
}

/** Why "kept out" is small: what passed through whole, and how little of the bill reads are. */
function passedCard(d: SessionDetail, r: SessionDetail["session"]): HTMLElement {
  const billed = r.usage.input + r.usage.cacheWrite + r.usage.cacheRead;
  const reads = d.passed.reduce((a, p) => a + p.tokens, 0) + r.snout.keptOut;
  return card("What Snout let through, and why", "Snout trims bulk: lockfiles, generated and minified files, long logs and docs, big command output, repeat reads. It never trims source code.",
    d.passed.length
      ? table([{ label: "Reason" }, { label: "Reads", cls: "r" }, { label: "Tokens", cls: "r" }], d.passed.map((p) => [p.why, h("span.num", null, p.count.toLocaleString()), h("span.num", null, tok(p.tokens))]), "compact")
      : empty("Nothing passed through", "Snout saw no reads in this session."),
    billed ? h("p.note", null, icon("info", 14), h("span", null, `Reads and tool results Snout saw: ${tok(reads)} tokens (`, basis("estimated"), `). Billed input: ${tok(billed)} tokens (`, basis("measured"), "). Every request re-sends the whole conversation, so most of the bill is history; Snout acts on what reads add, not on the conversation.")) : null);
}
