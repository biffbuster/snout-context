/** Environments: this machine, where agents ran from, Snout's records and hosted sync. */
import type { EnvironmentView } from "../../api.js";
import { ago, card, cardWith, chip, clientName, codeLine, empty, h, icon, logo, table } from "../dom.js";
import type { Ctx, PageHandle } from "../ctx.js";

const kb = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);

export async function environmentsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const e = await ctx.get<EnvironmentView>("environment", {}, { range: false });
  const l = e.local;
  el.append(h("div.page-h", null, h("div", null, h("h1", null, "Environments"), h("p.sub", null, "Where agents ran and where Snout keeps its records"))));
  el.append(h("div.grid", null,
    h("div.span-5", null, card(h("span.row", null, icon("laptop", 16), "This machine"), "Everything here stays local",
      h("dl.kv", null,
        h("dt", null, "Host"), h("dd", null, l.host),
        h("dt", null, "System"), h("dd", null, l.platform),
        h("dt", null, "Node"), h("dd", null, l.node),
        h("dt", null, "Snout"), h("dd", null, `v${l.snout}`),
        h("dt", null, "Project"), h("dd.mono.wrap", null, l.projectDir),
        h("dt", null, "Records"), h("dd.mono.wrap", null, l.snoutDir),
        h("dt", null, "User settings"), h("dd.mono.wrap", null, l.configDir),
        h("dt", null, "Dashboard"), h("dd.mono", null, l.dashboard),
        h("dt", null, "Fast hooks"), h("dd", null, l.fastServer.on ? chip(`On · port ${l.fastServer.port}`, "ok") : chip("Off", "muted"))))),
    h("div.span-7", null, card("Where agents ran", "Sessions in this project by surface, from the agents' logs", l.agents.length
      ? table([{ label: "Agent" }, { label: "Surface" }, { label: "Sessions", cls: "r" }, { label: "Last", cls: "r" }], l.agents.map((a) => [h("span.cell-logo", null, logo(a.client, 20), clientName(a.client)), a.surface, h("span.num", null, a.sessions), ago(a.last)]))
      : empty("No sessions", "Claude Code and Codex sessions in this folder show up here."))),
    h("div.span-12", null, card("Snout's records", "Plain files in .snout/, readable and removable", table([{ label: "File" }, { label: "Rows", cls: "r" }, { label: "Size", cls: "r" }], l.records.map((r) => [h("span.mono", null, r.name), h("span.num", null, r.rows ?? "–"), h("span.num", null, kb(r.bytes))])))),
    h("div.span-12", null, cardWith(h("span.row", null, icon("cloud", 16), "Hosted"), "Snout Cloud, opt-in", e.hosted.connected ? chip("Connected", "ok") : chip("Not connected", "muted"),
      e.hosted.connected
        ? h("dl.kv", null, h("dt", null, "Account"), h("dd", null, e.hosted.user ?? "–"), h("dt", null, "Team"), h("dd", null, e.hosted.team ?? "–"), h("dt", null, "Server"), h("dd.mono", null, e.hosted.url ?? "–"), h("dt", null, "Last sync"), h("dd", null, e.hosted.lastSync ? ago(e.hosted.lastSync) : "never"))
        : h("div", null, h("p", null, "Nothing is sent anywhere. Signing in shares daily totals with a team dashboard: no paths, no file contents, no prompts."), codeLine("snout login")))),
  ));
  return {};
}
