/**
 * Integrations: agents, MCP servers, models, services and the repo, each with a status that a
 * file or log line on this machine proves (pages.ts). Setup commands are shown, not run.
 */
import type { Integration } from "../../api.js";
import { ago, chip, codeLine, empty, h, icon, logo, modelLogo } from "../dom.js";
import type { Ctx, PageHandle } from "../ctx.js";

const KIND_LABEL: Record<string, string> = { agent: "Coding agents", mcp: "MCP servers", model: "Models", service: "Services", repo: "Repository" };
const STATUS: Record<string, { text: string; tone: "ok" | "info" | "warn" | "bad" | "muted" | "accent" }> = {
  connected: { text: "Connected", tone: "ok" },
  installed: { text: "Installed", tone: "info" },
  available: { text: "Not set up", tone: "warn" },
  off: { text: "Off", tone: "muted" },
  error: { text: "Needs attention", tone: "bad" },
};

export function integrationLogo(i: Integration, size = 30): Element {
  if (i.kind === "model") return modelLogo(i.name, size);
  if (i.kind === "agent") return logo(i.id.slice(6), size);
  if (i.kind === "repo") return logo(i.name.startsWith("github.com") ? "github" : "git", size);
  if (i.id === "service:jev") return logo("jev", size);
  if (i.kind === "mcp") return /github/i.test(i.name) ? logo("github", size) : logo(i.name, size);
  return logo(i.name, size);
}

export async function integrationsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const list = await ctx.get<Integration[]>("integrations", {}, { range: false });
  const kinds = ["agent", "mcp", "model", "service", "repo"].filter((k) => list.some((i) => i.kind === k));
  const connected = list.filter((i) => i.status === "connected").length;
  el.append(h("div.page-h", null, h("div", null, h("h1", null, "Integrations"), h("p.sub", null, `${connected} connected · status read from this machine: hook calls, config files, agent logs`))));
  if (!list.length) el.append(empty("Nothing found", "No agents, MCP servers or models have been used in this project yet."));
  for (const k of kinds) {
    el.append(h("h2.section", null, KIND_LABEL[k] ?? k), h("div.int-grid", null, list.filter((i) => i.kind === k).map((i) => integrationCard(i))));
  }
  return {};
}

function integrationCard(i: Integration): HTMLElement {
  const st = STATUS[i.status] ?? STATUS.off!;
  return h("article.int", null,
    h("header", null, integrationLogo(i), h("div.grow", null, h("b", null, i.name), h("small", null, i.detail)), chip(st.text, st.tone)),
    i.capabilities.length ? h("ul.caps", null, i.capabilities.map((c) => h("li", { class: c.on ? "on" : "" }, icon(c.on ? "check" : "minus", 13), c.name))) : null,
    i.telemetry.length ? h("ul.tele", null, i.telemetry.map((t) => h("li", null, t))) : null,
    i.errors.length ? h("ul.errs", null, i.errors.map((e) => h("li", null, icon("alert", 13), e))) : null,
    i.setup ? codeLine(i.setup) : null,
    h("footer", null, i.version ? h("span.muted", null, `v${i.version}`) : h("span"), h("span.muted", null, i.last ? `Last seen ${ago(i.last)}` : "")));
}
