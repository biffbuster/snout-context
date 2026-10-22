/**
 * Agents: one card per coding agent and per subagent type, after design-references/agents_dash.png.
 * Status, task, models and tools come from the agents' logs; the switch is Snout's project mode,
 * which applies to every agent in the project (Snout has no per-agent switch).
 */
import type { AgentCard, Integration } from "../../api.js";
import { ago, basis, chip, clientName, empty, h, icon, logo, modelLogo, modelName, pct, short, tok, toggle, usd, when } from "../dom.js";
import { ticks } from "../charts.js";
import type { Ctx, PageHandle } from "../ctx.js";

const ROLE_TEXT: Record<string, string> = {
  main: "The main agent loop.",
  Explore: "Read-only search subagent.",
  Plan: "Planning subagent.",
  "general-purpose": "General subagent for multi-step tasks.",
};

export async function agentsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const { agents, integrations } = await ctx.get<{ agents: AgentCard[]; integrations: Integration[] }>("agents");
  const total = agents.reduce((a, c) => a + c.usage.costUsd, 0);
  let view = "grid";
  const grid = h("div.agent-grid");
  const draw = () => {
    grid.className = view === "grid" ? "agent-grid" : "agent-grid list";
    grid.replaceChildren(...agents.map((a) => agentCard(ctx, a, total, integrations)));
  };
  el.append(
    h("div.page-h", null,
      h("div", null, h("h1", null, "Agents"), h("p.sub", null, `${agents.filter((a) => a.status === "working").length} working · ${agents.length} seen in this project`)),
      h("div.page-r", null,
        h("div.seg", { role: "group", "aria-label": "Layout" },
          h("button", { class: "on", title: "Cards", onclick: (e: Event) => { view = "grid"; setOn(e); draw(); } }, icon("overview", 15)),
          h("button", { title: "List", onclick: (e: Event) => { view = "list"; setOn(e); draw(); } }, icon("sessions", 15))))),
  );
  if (!agents.length) {
    el.append(empty("No agents yet", "Snout lists Claude Code, Codex and their subagents once they work in this project.", "snout init codex"));
    return {};
  }
  draw();
  el.append(grid);
  return {};
}

function setOn(e: Event): void {
  const b = (e.currentTarget as HTMLElement);
  b.parentElement?.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
}

function agentCard(ctx: Ctx, a: AgentCard, total: number, integrations: Integration[]): HTMLElement {
  const issues = a.warnings.length;
  const share = total ? a.usage.costUsd / total : 0;
  const integ = integrations.find((i) => i.id === `agent:${a.client}`);
  const enforcing = ctx.boot.mode !== "observe";
  const mainModel = a.models[0] ?? "";
  const tools = a.tools.slice(0, 6);
  return h("article.agent", null,
    h("header.agent-h", null,
      h("div", null,
        h("h3", null, a.role === "main" ? a.name : `${a.role}`, a.role !== "main" ? h("small", null, ` · ${clientName(a.client)} subagent`) : null),
        h("p.sub", null, a.task ? short(a.task, 160) : ROLE_TEXT[a.role] ?? "Subagent.")),
      issues ? h("span.issue", { title: a.warnings.join("\n") }, `${issues} issue${issues === 1 ? "" : "s"}`, h("i")) : a.status === "working" ? chip("Working", "info") : null),
    h("div.agent-b", null,
      h("div.agent-stats", null,
        h("div", null, h("span", null, "Sessions"), h("b.num", null, a.sessions.toLocaleString())),
        h("div", null, h("span", null, a.role === "main" ? "Turns" : "Requests"), h("b.num", null, (a.role === "main" ? a.turns : a.usage.requests).toLocaleString())),
        h("div", null, h("span", null, "Tool calls"), h("b.num", null, a.toolCalls.toLocaleString())),
        h("div", null, h("span", null, "Kept out"), h("b.num.accent-t", null, tok(a.keptOut)))),
      h("div.agent-spend", null,
        h("span", null, "Spend ", basis("list price")),
        h("div.agent-spend-v", null, h("b.num", null, usd(a.usage.costUsd)), h("small", null, `/${usd(total)}`), h("span.num", null, pct(share, 0))),
        ticks(share, share > 0.6 ? "#e8794a" : "var(--ok)", 22, `${pct(share)} of this project's spend`))),
    h("div.agent-c", null,
      h("div.agent-logos", null,
        h("span.logo-main", { title: mainModel ? modelName(mainModel) : clientName(a.client) }, mainModel ? modelLogo(mainModel, 28) : logo(a.client, 28)),
        h("div.logo-row", null,
          a.models.slice(1, 3).map((m) => h("span", { title: modelName(m) }, modelLogo(m, 22))),
          a.mcp.slice(0, 4).map((m) => h("span", { title: `MCP: ${m}` }, logo(m, 22))),
          tools.length ? h("span.tool-names", null, tools.slice(0, 3).map((t) => t.name.replace(/^mcp__/, "")).join(" · ")) : h("span.muted", null, "No tool calls in range"),
          a.tools.length > 3 ? h("span.more", null, `+${a.tools.length - 3}`) : null)),
      h("a.agent-link", { href: `#/sessions?client=${a.client}` }, h("b.num", null, a.sessions), h("span", null, `session${a.sessions === 1 ? "" : "s"} to review`), icon("arrow", 15))),
    h("footer.agent-f", null,
      a.role === "main"
        ? toggle(enforcing && integ?.status !== "off", enforcing ? "Snout trimming for this agent" : "Snout watching only", ctx.boot.controls && integ?.status !== "off" ? async (on) => {
            try {
              ctx.toast(await ctx.act({ type: "mode", value: on ? "enforce" : "observe" }));
              ctx.refresh();
            } catch (e) {
              ctx.toast((e as Error).message, "bad");
            }
          } : null, "Snout's mode applies to every agent in this project")
        : h("span.muted", null, `Runs inside ${clientName(a.client)}; Snout gates its reads too`),
      h("span.last", null, "Last run: ", h("b", null, a.last ? (Date.now() - Date.parse(a.last) < 86_400_000 ? ago(a.last) : when(a.last)) : "never"))));
}
