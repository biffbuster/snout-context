/**
 * Projects: every project on this machine an agent worked in, then the selected one's files:
 * folders by what reading them costs, the agent context files loaded every session, and one
 * file's report. Snout never changes these files; it changes what the agent is given.
 */
import type { FeedRow, ProjectCard } from "../../api.js";
import { ago, basis, card, cardWith, chip, codeLine, empty, h, icon, logo, pct, short, table, tail, tok, usd } from "../dom.js";
import { stack } from "../charts.js";
import { save, type Ctx, type PageHandle } from "../ctx.js";

interface RepoGroup { key: string; files: number; tokens: number; bulk: number; reads: number; inContext: number; heldBack: number; top: { path: string; tokens: number; label: string; sendTokens: number; reads: number; inContext: number; heldBack: number; last: string | null }[]; kinds: { label: string; files: number; tokens: number; heldBack: number }[] }
interface RepoView { files: number; tokens: number; bulk: number; groups: RepoGroup[]; more: number; mapBuiltAt: string | null }
interface AgentFile { path: string; role: string; kind: string; agents: string[]; tokens: number; perSession: number; uses: number; savePerSession: number; flags: { code: string; reason: string; action: string }[] }
interface Summary { agentFiles: { files: AgentFile[]; count: number; alwaysPerSession: number; flagged: number; savePerSession: number } | null }
interface FileReport { path: string; tokens: number; lines: number; label: string; band: string; reason: string; head: { lines: number; tokens: number } | null; outline: { name: string; detail: string; line: number | null; kind: string }[]; more: number; hint: string; reads: number; inContext: number; keptOut: number; history: FeedRow[]; allowed: boolean }

export async function projectsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const file = ctx.route.params.get("file");
  if (file) return fileView(ctx, el, file);
  const [cards, repo, summary] = await Promise.all([
    ctx.get<ProjectCard[]>("projects"),
    ctx.get<RepoView | null>("repo", {}, { range: false }).catch(() => null),
    fetch(`/api/summary`).then((r) => r.json() as Promise<Summary>).catch(() => ({ agentFiles: null })),
  ]);
  el.append(h("div.page-h", null, h("div", null, h("h1", null, "Projects"), h("p.sub", null, `${cards.length} projects on this machine with agent sessions`))));
  el.append(h("div.proj-grid", null, cards.map((c) => projectCard(ctx, c))));
  if (ctx.boot.project.current) {
    el.append(h("div.grid", null,
      h("div.span-7", null, repoCard(repo)),
      h("div.span-5", null, contextFiles(summary.agentFiles))));
  } else {
    el.append(h("p.note", null, icon("info", 13), " File details are shown for the project this dashboard was started in. Run `snout dashboard` inside another project to see its files."));
  }
  return {};
}

function projectCard(ctx: Ctx, c: ProjectCard): HTMLElement {
  const on = c.ref.id === ctx.boot.project.id;
  return h("article", { class: `proj ${on ? "on" : ""}` },
    h("header", null,
      h("span.proj-ic", null, c.ref.remote?.startsWith("github.com") ? logo("github", 26) : logo("git", 26)),
      h("div.grow", null, h("b", null, c.ref.name), h("small.mono", { title: c.ref.dir }, c.ref.remote ?? tail(c.ref.dir, 3))),
      c.active ? chip(`${c.active} working`, "info") : c.mode ? chip(c.mode, c.mode === "enforce" ? "accent" : "muted") : chip("No Snout", "muted", "Snout has no records for this project")),
    h("div.proj-stats", null,
      h("div", null, h("span", null, "Sessions"), h("b.num", null, c.sessions)),
      h("div", null, h("span", null, "Spend"), h("b.num", null, c.usage ? usd(c.usage.costUsd) : "–")),
      h("div", null, h("span", null, "Kept out"), h("b.num.accent-t", null, c.snout ? tok(c.snout.keptOut) : "–"))),
    c.topFiles.length ? h("ul.mini", null, c.topFiles.map((f) => h("li", null, h("span.mono", { title: f.key }, tail(f.key, 2)), h("b.num", null, tok(f.keptOut))))) : h("p.muted.small", null, c.snout ? "Nothing kept out in this range." : "Install Snout in this project to trim and measure."),
    h("footer", null, h("span.muted", null, `Last active ${ago(c.ref.last)}`), on ? h("span.chip.ok", null, "Viewing") : h("button.btn.sm", { onclick: () => { ctx.filters.project = c.ref.id; save("filters", ctx.filters); location.hash = "#/overview"; location.reload(); } }, "Open")));
}

function repoCard(repo: RepoView | null): HTMLElement {
  if (!repo) return card("Files", null, empty("No file list", "Snout lists the project's files the first time the dashboard opens."));
  return cardWith("Files", "Folders by the tokens an agent would spend reading them", h("span.muted", null, `${repo.files.toLocaleString()} files · ${tok(repo.tokens)} tok · ${pct(repo.bulk / Math.max(1, repo.tokens), 0)} bulk`),
    h("div.folders", null, repo.groups.map((g) => h("details.folder", null,
      h("summary", null,
        icon("projects", 15),
        h("b.mono", null, g.key === "/" ? "(root)" : g.key),
        h("span.grow", null, stack([{ value: g.bulk, color: "var(--accent-hi)", label: `${tok(g.bulk)} in bulk files` }, { value: g.tokens - g.bulk, color: "var(--bar-in)", label: `${tok(g.tokens - g.bulk)} in source` }], 6)),
        h("span.num", null, tok(g.tokens)),
        g.heldBack ? h("span.num.accent-t", null, `−${tok(g.heldBack)}`) : h("span.muted", null, "")),
      table([{ label: "File" }, { label: "Kind" }, { label: "Size", cls: "r" }, { label: "Sent if read", cls: "r" }, { label: "Reads", cls: "r" }, { label: "Kept out", cls: "r" }],
        g.top.map((f) => [h("a.mono", { href: `#/projects?file=${encodeURIComponent(f.path)}`, title: f.path }, tail(f.path, 3)), f.label === "source" ? h("span.muted", null, "source") : chip(f.label, "accent"), h("span.num", null, tok(f.tokens)), h("span.num", null, tok(f.sendTokens)), h("span.num", null, f.reads || "–"), h("span.num.accent-t", null, f.heldBack ? tok(f.heldBack) : "–")]), "compact")))),
    repo.more ? h("p.note", null, `${repo.more} more folders not shown.`) : null,
    h("p.note", null, basis("estimated"), " Sizes are estimated tokens. Trimming changes what the agent reads; files are never modified."));
}

function contextFiles(a: Summary["agentFiles"]): HTMLElement {
  if (!a) return card("Agent context files", "CLAUDE.md, AGENTS.md, skills, rules", empty("Not read yet", "Snout reads these in the background a few seconds after the page opens.", "snout audit context"));
  return cardWith("Agent context files", "Loaded by the agents on every session or on demand", h("span.muted", null, `${tok(a.alwaysPerSession)} tok every session`),
    a.files.length
      ? h("ul.ctxfiles", null, a.files.slice(0, 12).map((f) => h("li", null,
          h("div.row", null, icon("file", 15), h("b.mono.grow", { title: f.path }, tail(f.path, 3)), h("span.num", null, `${tok(f.perSession)} / session`)),
          h("small.muted", null, `${f.kind} · ${f.agents.join(", ")}${f.uses ? ` · used ${f.uses}×` : ""}`),
          f.flags.length ? h("div.flags", null, f.flags.slice(0, 2).map((x) => chip(`${x.code}: ${x.action}`, "warn", x.reason))) : null)))
      : empty("None found", ""),
    a.flagged ? [h("p.note", null, `${a.flagged} flagged: could save about ${tok(a.savePerSession)} tokens per session. Review with:`), codeLine("snout audit context")] : null);
}

async function fileView(ctx: Ctx, el: HTMLElement, path: string): Promise<PageHandle> {
  let f: FileReport;
  try {
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error((await r.json() as { error: string }).error);
    f = (await r.json()) as FileReport;
  } catch (e) {
    el.append(h("a.back", { href: "#/projects" }, icon("back", 14), "Projects"), empty("No report for this file", `${(e as Error).message}. It may be outside the project or deleted.`));
    return {};
  }
  el.append(
    h("div.page-h", null, h("div", null, h("a.back", { href: "#/projects" }, icon("back", 14), "Projects"), h("h1.mono", null, f.path), h("p.sub", null, `${f.label} · ${f.lines.toLocaleString()} lines · ${tok(f.tokens)} tokens to read whole`)),
      h("div.page-r", null, ctx.boot.controls
        ? f.allowed
          ? h("button.btn", { onclick: async () => { try { ctx.toast(await ctx.act({ type: "unallow", path: f.path })); ctx.refresh(); } catch (e) { ctx.toast((e as Error).message, "bad"); } } }, "Let Snout trim it again")
          : f.label !== "source" ? h("button.btn", { onclick: async () => { try { ctx.toast(await ctx.act({ type: "allow", path: f.path })); ctx.refresh(); } catch (e) { ctx.toast((e as Error).message, "bad"); } } }, "Always read in full") : null
        : null)),
    h("div.grid", null,
      h("div.span-5", null, card("What Snout does with it", null,
        h("dl.kv", null,
          h("dt", null, "Kind"), h("dd", null, f.label === "source" ? "Source: always read in full" : chip(f.label, "accent")),
          h("dt", null, "Why"), h("dd", null, f.reason || "No rule matched"),
          h("dt", null, "If read"), h("dd", null, f.head ? `The first ${f.head.lines} lines (${tok(f.head.tokens)} tok), with a pointer to the rest` : "Read whole"),
          h("dt", null, "Reads seen"), h("dd.num", null, f.reads),
          h("dt", null, "Reached context"), h("dd.num", null, tok(f.inContext)),
          h("dt", null, "Kept out"), h("dd.num.accent-t", null, tok(f.keptOut), " ", basis("estimated"))),
        f.hint ? h("p.note", null, f.hint) : null,
        h("p.note", null, icon("info", 13), " The file on disk is never changed."))),
      h("div.span-7", null, card("Outline", "What the agent can ask for by name", f.outline.length
        ? h("ul.outline", null, f.outline.slice(0, 60).map((o) => h("li", null, h("span.muted.num", null, o.line ?? ""), h("b.mono", null, o.name), h("span.muted", null, o.detail))), f.more ? h("li.muted", null, `${f.more} more`) : null)
        : empty("No outline", "Snout found no declarations or dependencies to list."))),
      h("div.span-12", null, card("History", "Each time an agent read it", f.history.length
        ? table([{ label: "When" }, { label: "Agent" }, { label: "Tool" }, { label: "Outcome" }, { label: "In context", cls: "r" }, { label: "Kept out", cls: "r" }, { label: "Reason" }],
            f.history.map((x) => [ago(x.ts), x.agent, h("span.mono", null, x.tool), h("span", { class: `out ${x.outcome.replace(/ /g, "-")}` }, x.outcome), h("span.num", null, tok(x.inContext)), h("span.num.accent-t", null, x.keptOut ? tok(x.keptOut) : "–"), h("small.muted", null, short(x.reason, 90))]), "compact")
        : empty("Never read", "No agent has read this file since Snout started recording.")))));
  return {};
}
