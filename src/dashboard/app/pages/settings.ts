/**
 * Settings: Snout's project settings, changed through the same code as the CLI. Only keys the
 * server allows (pages.ts EDITABLE) have controls; the rest show the command to run.
 */
import type { SettingsView } from "../../api.js";
import { card, chip, codeLine, empty, h, icon, table, when } from "../dom.js";
import type { Ctx, PageHandle } from "../ctx.js";

type View = SettingsView & { sources: Record<string, string>; editable: Record<string, (string | boolean)[]>; userConfig: string };

const ROWS: { key: string; label: string; help: string; cli?: string }[] = [
  { key: "mode", label: "Mode", help: "Observe records only. Advise and enforce trim bulk before the agent reads it." },
  { key: "repeatReads", label: "Repeat reads", help: "Answer a re-read of an unchanged file with a pointer to the earlier copy." },
  { key: "longDocs", label: "Long docs and logs", help: "Whole reads of long docs return a section map; logs return their tail." },
  { key: "memory", label: "Memory", help: "A record of each session, on this machine. A new session is told earlier ones exist; the agent searches and opens them when it needs to." },
  { key: "repoMap", label: "Repo map hints", help: "Suggest the files linked to names in each prompt, from a local repo map." },
  { key: "output", label: "Output style", help: "Concise adds one short instruction at session start." },
  { key: "coach", label: "Prompt coach", help: "Tip scores prompts with local rules. Jev sends task prompts to api.typesafe.ai." },
  { key: "memoryJudge", label: "Memory preference judge", help: "Paused: not part of the current memory workflow. Jev judges which of your sentences are lasting preferences, and sends up to six sentences per session." },
  { key: "fastHooks", label: "Fast hooks", help: "Blocking hooks call a long-running local server instead of starting Node each time.", cli: "snout fast on" },
  { key: "sizeCapBytes", label: "Size cap", help: "Files larger than this are trimmed whatever their kind.", cli: "Edit .snout/config.json" },
];

const SENDS = new Set(["coach:jev", "memoryJudge:jev"]);

export async function settingsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const v = await ctx.get<View>("settings", {}, { range: false });
  const set = async (key: string, value: string | boolean) => {
    if (SENDS.has(`${key}:${value}`) && !confirm("This sends text to api.typesafe.ai. Turn it on?")) return;
    try {
      ctx.toast(await ctx.act({ type: "set", key, value }));
      ctx.refresh();
    } catch (e) {
      ctx.toast((e as Error).message, "bad");
    }
  };
  const control = (key: string) => {
    const allowed = v.editable[key];
    const cur = v.values[key];
    if (!allowed || !ctx.boot.controls) return h("b", null, typeof cur === "boolean" ? (cur ? "On" : "Off") : key === "sizeCapBytes" && typeof cur === "number" ? `${Math.round(cur / 1024)} KB` : String(cur));
    if (allowed.length === 2 && typeof allowed[0] === "boolean") {
      const on = cur === true;
      const b = h("button", { class: `switch ${on ? "on" : ""}`, role: "switch", "aria-checked": String(on), "aria-label": key }, h("i"));
      b.addEventListener("click", () => void set(key, !on));
      return b;
    }
    return h("div.seg", { role: "group", "aria-label": key }, allowed.map((opt) => h("button", { class: cur === opt ? "on" : "", "aria-pressed": String(cur === opt), onclick: () => (cur === opt ? undefined : void set(key, opt)) }, String(opt))));
  };
  el.append(
    h("div.page-h", null, h("div", null, h("h1", null, "Settings"), h("p.sub.mono", null, v.configFile))),
    ...(ctx.boot.controls ? [] : [h("div.banner.warn", null, icon("info", 18), h("div", null, h("b", null, "Read only"), h("p", null, "Settings can be changed from the dashboard of the project they belong to.")))]),
    h("div.grid", null,
      h("div.span-7", null, card("Snout", "Saved to this project's .snout/config.json",
        h("ul.settings", null, ROWS.map((r) => h("li", null,
          h("div.grow", null, h("b", null, r.label), h("p", null, r.help), v.sources[r.key] && v.sources[r.key] !== "default" ? h("small.muted", null, `set in ${v.sources[r.key]} settings`) : null),
          h("div.ctl", null, control(r.key), r.cli && !v.editable[r.key] ? h("small.muted.mono", null, r.cli) : null)))))),
      h("div.span-5", null,
        card("Always read in full", "Files Snout never trims", v.alwaysAllow.length
          ? h("ul.paths", null, v.alwaysAllow.map((p) => h("li", null, h("span.mono.grow", null, p), ctx.boot.controls ? h("button.icon-btn", { title: "Remove", "aria-label": `Remove ${p}`, onclick: async () => { try { ctx.toast(await ctx.act({ type: "unallow", path: p })); ctx.refresh(); } catch (e) { ctx.toast((e as Error).message, "bad"); } } }, icon("x", 14)) : null)))
          : h("p.muted", null, "None."), codeLine("snout allow <path>")),
        card("Always kept out", null, h("ul.paths", null, v.alwaysDeny.map((p) => h("li.mono", null, p)))),
        card("Prices", `List prices as of ${v.pricesAsOf}; override in ${v.userConfig.replace(/config\.json$/, "")}prices.json`, v.prices.length
          ? table([{ label: "Model" }, { label: "Input /M", cls: "r" }, { label: "Cache read /M", cls: "r" }, { label: "Output /M", cls: "r" }, { label: "" }],
              v.prices.map((p) => [h("span.mono", null, p.model), h("span.num", null, `$${p.input}`), h("span.num", null, `$${p.cacheRead}`), h("span.num", null, `$${p.output}`), p.source === "yours" ? chip("yours", "info") : h("span")]), "compact")
          : h("p.muted", null, "No priced models used yet.")),
        healthCard(v.health),
        card("TypeSafe key", "Used only by the opt-in Jev features", h("p", null, v.keyPresent.typesafe ? chip("TYPESAFE_API_KEY is set", "ok") : chip("Not set", "muted"))))),
  );
  return {};
}

/** Snout's own errors from the last week. Older lines stay in the file but are not news. */
function healthCard(x: View["health"]): HTMLElement {
  const sub = x.recent.length ? `${x.recent.length + x.more} in the last 7 days` : "Errors Snout recorded in the last 7 days";
  const foot = x.more || x.older ? h("p.note", null, [x.more ? `${x.more} more this week` : "", x.older ? `${x.older} older` : ""].filter(Boolean).join(" · "), " in ", h("span.mono", null, x.file)) : null;
  return card(h("span.row", null, icon(x.recent.length || x.hooks ? "alert" : "check", 16), "Snout's health"), sub,
    x.hooks ? h("div.banner.warn", null, icon("alert", 16), h("div", null, h("b", null, "Plugin hooks are not running"), h("p", null, x.hooks))) : null,
    x.recent.length
      ? h("ul.errlist", null, x.recent.map((e) => h("li", null, h("div.row", null, h("b", null, e.where), h("small.muted", null, when(e.ts))), h("code.wrap", null, e.message))))
      : empty("No recent errors", "Hooks and logs ran without a recorded error this week."),
    foot);
}
