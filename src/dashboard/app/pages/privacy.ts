/** Security & Privacy: what Snout stores, what can leave the machine and when, and what never does. */
import type { PrivacyView } from "../../api.js";
import { card, chip, h, icon, table } from "../dom.js";
import type { Ctx, PageHandle } from "../ctx.js";

const kb = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);

export async function privacyPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const p = await ctx.get<PrivacyView>("privacy", {}, { range: false });
  const anyOn = p.local.network.some((n) => n.on);
  el.append(
    h("div.page-h", null, h("div", null, h("h1", null, "Security & Privacy"), h("p.sub", null, anyOn ? "Some opt-in features send data; each is listed below" : "Nothing leaves this machine"))),
    h("div.banner", { class: anyOn ? "banner warn" : "banner ok" }, icon(anyOn ? "info" : "shield", 18), h("div", null,
      h("b", null, anyOn ? "Opt-in network features are on" : "Local only"),
      h("p", null, "Hooks run on this machine and call no model. Snout changes what an agent is given, never the files on disk. Paths are recorded; file contents are not."))),
    h("div.grid", null,
      h("div.span-7", null, card("What can leave this machine", "Each feature is off until you turn it on", table(
        [{ label: "Feature" }, { label: "Status" }, { label: "Sends" }, { label: "To" }],
        p.local.network.map((n) => [h("b", null, n.feature), n.on ? chip("On", "warn") : chip("Off", "muted"), n.sends, h("span.mono", null, n.to)])))),
      h("div.span-5", null, card("Never read, never sent", "Files matching these patterns are not classified at all; every read asks you first, in every mode",
        h("ul.patterns", null, p.redact.map((r) => h("li.mono", null, r))))),
      h("div.span-7", null, card("Stored on this machine", "Plain files in .snout/; delete any of them at any time", table(
        [{ label: "File" }, { label: "Holds" }, { label: "Size", cls: "r" }],
        p.local.stored.map((s) => [h("span.mono", null, s.file), h("small", null, s.holds), h("span.num", null, kb(s.bytes))]), "compact"),
        h("p.note", null, "Telemetry: ", p.local.telemetry)))),
  );
  return {};
}
