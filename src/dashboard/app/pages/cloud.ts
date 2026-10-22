/**
 * Snout Cloud: the team view. Two sources, one shape (api.ts TeamView):
 *
 *   hosted   served by Snout Cloud, from what each machine's `snout sync` sent: daily totals per
 *            person, agent, model, project and file label. Numbers carry how they are known.
 *   preview  `snout dashboard`'s Cloud tab, drawn from sample.ts. Every page opens with a banner
 *            that says so, and every number is marked "sample".
 *
 * The server has no sessions, paths or prompts, so these pages show none.
 */
import { bars, stack } from "../charts.js";
import { basis, card, chip, clientName, codeLine, empty, h, icon, int, logo, modelLogo, modelName, pct, stat, table, tok, usd, ago } from "../dom.js";
import type { Ctx, PageHandle } from "../ctx.js";
import type { HostedTeam, TeamMachine, TeamMember, TeamView } from "../../api.js";
import { SAMPLE_ENVS, SAMPLE_INTEGRATIONS, sampleTeam, type SampleIntegration } from "../sample.js";

const sample = () => h("span.basis.est", { title: "Made-up numbers; this is a preview" }, "sample");
/** How a number is known: its basis when hosted, "sample" in the preview. */
const how = (ctx: Ctx, kind: Parameters<typeof basis>[0]) => (ctx.hosted ? basis(kind) : sample());

const agoMin = (m: number) => (m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`);

/** "today", "yesterday" or "Oct 14" for a YYYY-MM-DD day. */
function dayLabel(day: string | null): string {
  if (!day) return "–";
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return "today";
  if (day === yesterday) return "yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const shortDay = (l: string) => new Date(`${l}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The range buttons offer 7, 30 and 90 days when hosted. */
export const HOSTED_RANGES: [string, string][] = [["7d", "7d"], ["30d", "30d"], ["90d", "90d"]];
export const hostedDays = (range: string): number => (range === "7d" ? 7 : range === "90d" ? 90 : 30);

async function teamData(ctx: Ctx): Promise<TeamView> {
  if (!ctx.hosted) return sampleTeam();
  return ctx.get<TeamView>("team", { team: ctx.boot.hosted?.team, days: hostedDays(ctx.filters.range) }, { range: false });
}

function previewBanner(ctx: Ctx): HTMLElement {
  return h("div.banner.warn.cloud-banner", null, icon("info", 18),
    h("div.grow", null, h("b", null, "Sample data: Snout Cloud is not connected yet"),
      h("p", null, "This preview shows what a team workspace will look like. Nothing here comes from your machine, and nothing is sent anywhere.")),
    h("button.btn.sm", { onclick: () => ctx.setView("local") }, "Back to local"));
}

/** What every team page opens with: the preview banner, or a note when the plan shows less history. */
function top(ctx: Ctx, v: TeamView | null): HTMLElement | null {
  if (!ctx.hosted) return previewBanner(ctx);
  if (v?.capped) {
    return h("div.banner.warn", null, icon("info", 18), h("div.grow", null, h("b", null, `Showing the last ${v.capped.historyDays} days`), h("p", null, "Your plan shows this much history. Everything synced is kept, so a longer plan shows it all.")));
  }
  return null;
}

function head(ctx: Ctx, title: string, sub: string): HTMLElement {
  return h("div.page-h", null, h("div", null, h("h1", null, title, " ", ctx.hosted ? null : chip("Preview", "accent")), h("p.sub", null, sub)));
}

const teamOf = (ctx: Ctx): HostedTeam | undefined => ctx.boot.hosted?.teams.find((t) => t.id === ctx.boot.hosted?.team);
const whose = (ctx: Ctx) => (teamOf(ctx)?.personal ? "Your machines" : "Everyone in the team");
const rangeText = (v: TeamView) => `last ${v.days} day${v.days === 1 ? "" : "s"}`;

const hasData = (v: TeamView) => v.totals.reads > 0 || v.spend.requests > 0;

/**
 * Nothing synced yet: how to connect a machine. With a machine already connected, how to send
 * its first totals now instead of at the end of the next session.
 */
function connectPanel(ctx: Ctx, v: TeamView): HTMLElement {
  const cmd = ctx.boot.hosted?.connect ?? "npx usesnout login";
  const waiting = v.machines.length > 0;
  return h("section.card.connect", null,
    h("header.card-h", null, h("div", null,
      h("h3", null, waiting ? "Waiting for the first sync" : "Connect a machine"),
      h("p.sub", null, waiting
        ? `${v.machines.length} machine${v.machines.length === 1 ? "" : "s"} connected, nothing synced in the ${rangeText(v)}. Totals arrive when an agent session ends.`
        : "Snout runs on your machine. Connect it once and its daily totals show up here."))),
    h("ol.steps", null,
      waiting ? null : h("li", null, h("div", null, h("b", null, "Sign this machine in"), h("p", null, "In a project where Snout runs. A browser tab opens with a code to approve."), codeLine(cmd))),
      h("li", null, h("div", null, h("b", null, waiting ? "Send totals now" : "Send the first totals"), h("p", null, "Or wait: they sync by themselves when each agent session ends."), codeLine("npx usesnout sync"))),
      h("li", null, h("div", null, h("b", null, "Check what is sent"), h("p", null, "Daily totals per agent, model and file label, and measured spend. Never file contents, paths or prompts."), codeLine("npx usesnout sync --dry-run")))),
  );
}

// ---------------------------------------------------------------- shared pieces

function person(m: TeamMember): HTMLElement {
  const face = m.avatar ? h("img.avatar", { src: m.avatar, width: 26, height: 26, alt: "" }) : h("span.avatar", null, m.agent ? icon("cloud", 14) : (m.name[0] ?? "?").toUpperCase());
  return h("span.cell-logo", null, face, h("span", null, m.name, h("small", null, m.agent ? "cloud agent" : m.key !== m.name ? `@${m.key}` : null)));
}

function peopleTable(ctx: Ctx, v: TeamView): HTMLElement {
  if (!v.byMember.length) return empty("No one has synced yet", "People appear here after their machine's first sync.");
  return table([{ label: "Person" }, { label: "Agents" }, { label: "Requests", cls: "r" }, { label: "Spend", cls: "r" }, { label: "Kept out", cls: "r" }, { label: "Last", cls: "r" }],
    v.byMember.map((m) => [person(m), h("span.logo-stack", null, m.clients.map((c) => logo(c, 22))), h("span.num", null, int(m.spend.requests)), h("span.num", null, usd(m.spend.costUsd)), h("span.num", null, tok(m.snout.keptOut)), dayLabel(m.last)]));
}

function modelTable(v: TeamView): HTMLElement {
  if (!v.byModel.length) return empty("No models yet", "Models appear once a machine syncs its agents' usage.");
  return table([{ label: "Model" }, { label: "Requests", cls: "r" }, { label: "Tokens", cls: "r" }, { label: "Spend", cls: "r" }, { label: "Kept out", cls: "r" }],
    v.byModel.map((m) => [h("span.cell-logo", null, modelLogo(m.key, 22), h("span", null, modelName(m.key), h("small", null, clientName(m.client)))), h("span.num", null, int(m.spend.requests)), h("span.num", null, tok(m.spend.tokens)),
      h("span.num", null, v.spend.unpriced.includes(m.key) ? chip("no list price", "muted", "Tokens count; cost is not estimated") : usd(m.spend.costUsd)), h("span.num", null, tok(m.snout.keptOut))]));
}

function projectTable(v: TeamView, limit = Infinity): HTMLElement {
  if (!v.byProject.length) return empty("No projects yet", "Each project a machine syncs from shows up here, named by its folder.");
  return table([{ label: "Project" }, { label: "Requests", cls: "r" }, { label: "Spend", cls: "r" }, { label: "Reads", cls: "r" }, { label: "Kept out", cls: "r" }, { label: "Last", cls: "r" }],
    v.byProject.slice(0, limit).map((p) => [h("span.cell-logo", null, logo("git", 22), h("span", null, p.name)), h("span.num", null, int(p.spend.requests)), h("span.num", null, usd(p.spend.costUsd)), h("span.num", null, int(p.snout.reads)), h("span.num", null, tok(p.snout.keptOut)), dayLabel(p.last)]));
}

function agentList(v: TeamView): HTMLElement {
  if (!v.byClient.length) return empty("No agents yet", "Coding agents appear after the first sync.");
  return h("ul.cloud-list", null, v.byClient.map((c) => h("li", null, logo(c.key, 26),
    h("div.grow", null, h("b", null, clientName(c.key)), h("small.muted", null, `${c.members} ${c.members === 1 ? "person" : "people"} · ${tok(c.snout.keptOut)} kept out`)),
    h("span.num", null, usd(c.spend.costUsd)))));
}

function labelMix(v: TeamView): HTMLElement {
  const rows = v.byLabel.filter((l) => l.keptOut > 0).slice(0, 6);
  if (!rows.length) return empty("Nothing kept out yet", "In observe mode Snout only records; in enforce it trims logs, lockfiles and other bulk.");
  const max = Math.max(...rows.map((l) => l.keptOut));
  return h("ul.cloud-list", null, rows.map((l) => h("li", null, logo(l.key === "mcp" ? "mcp" : l.key, 26),
    h("div.grow", null, h("b", null, l.key), stack([{ value: l.keptOut, color: "var(--accent)", label: `${tok(l.keptOut)} kept out` }, { value: max - l.keptOut, color: "transparent", label: "" }], 6)),
    h("span.num", null, tok(l.keptOut)))));
}

// ---------------------------------------------------------------- pages

export async function cloudOverviewPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const v = await teamData(ctx);
  const title = ctx.hosted ? (teamOf(ctx)?.personal ? "Your overview" : "Team overview") : "Team overview";
  el.append(top(ctx, v) ?? "", head(ctx, title, `${whose(ctx)}, ${rangeText(v)}${v.lastSyncAt ? ` · last sync ${ago(v.lastSyncAt)}` : ""}`));
  if (ctx.hosted && !hasData(v)) {
    el.append(connectPanel(ctx, v));
    return {};
  }
  const read = v.totals.keptOut + v.totals.inContext;
  const people = v.byMember.filter((m) => !m.agent).length;
  const agents = v.byMember.length - people;
  el.append(
    h("div.kpis", null,
      stat("Spend", usd(v.spend.costUsd), h("span", null, how(ctx, "list price"), ` ${int(v.spend.requests)} requests`)),
      stat("Kept out of context", tok(v.totals.keptOut), h("span", null, how(ctx, "estimated"), read ? ` ${pct(v.totals.keptOut / read)} of what agents read` : ""), "accent"),
      stat("Tokens billed", tok(v.spend.tokens), h("span", null, how(ctx, "measured"), v.spend.tokens ? ` ${pct(v.spend.cacheRead / v.spend.tokens)} cache reads` : "")),
      stat(people === 1 && !agents ? "Person" : "People", String(people), h("span", null, how(ctx, "count"), agents ? ` plus ${agents} cloud agent${agents === 1 ? "" : "s"}` : ctx.hosted ? ` ${v.machines.length} machine${v.machines.length === 1 ? "" : "s"}` : " billed per active developer"))),
    v.spend.unpriced.length ? h("p.muted.small", null, `No list price for ${v.spend.unpriced.join(", ")}: their tokens count, their cost does not.`) : "",
    h("div.grid", null,
      h("div.span-8", null, card("Spend by day", "At list price", bars(v.series.map((d) => d.costUsd), v.series.map((d) => d.day), { fmt: (n) => usd(n), xfmt: shortDay }))),
      h("div.span-4", null, card("By agent", null, agentList(v))),
      h("div.span-8", null, card("Kept out by day", "Estimated at each machine's gate", bars(v.series.map((d) => d.keptOut), v.series.map((d) => d.day), { fmt: (n) => tok(n), xfmt: shortDay, color: "var(--accent)" }))),
      h("div.span-4", null, card("What was kept out", "By file label", labelMix(v))),
      h("div.span-12", null, card("People", "Totals each machine synced; no paths, file contents or prompts", peopleTable(ctx, v))),
      h("div.span-6", null, card("Models", null, modelTable(v))),
      h("div.span-6", null, card("Projects", null, projectTable(v, 6)))),
  );
  return {};
}

export async function cloudAgentsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const v = await teamData(ctx);
  el.append(top(ctx, v) ?? "", head(ctx, ctx.hosted && teamOf(ctx)?.personal ? "Agents" : "Team agents", `Coding agents ${ctx.hosted && teamOf(ctx)?.personal ? "on your machines" : "across the workspace"}, ${rangeText(v)}`));
  if (ctx.hosted && !hasData(v)) {
    el.append(connectPanel(ctx, v));
    return {};
  }
  el.append(
    h("div.int-grid", null, v.byClient.map((c) => h("article.int", null,
      h("header", null, logo(c.key, 34), h("div.grow", null, h("b", null, clientName(c.key)), h("small", null, `${c.members} ${c.members === 1 ? "person" : "people"}`)), chip("Reporting", "ok")),
      h("dl.kv", null,
        h("dt", null, "Requests"), h("dd.num", null, int(c.spend.requests)),
        h("dt", null, "Spend"), h("dd.num", null, usd(c.spend.costUsd)),
        h("dt", null, "Kept out"), h("dd.num", null, tok(c.snout.keptOut)),
        c.models.length ? [h("dt", null, "Models"), h("dd", null, c.models.slice(0, 3).map(modelName).join(", "))] : null),
      h("footer", null, how(ctx, "measured"), h("span.muted", null, `Last sync ${dayLabel(c.last)}`))))),
    h("h2.section", null, "People"),
    card("People", null, peopleTable(ctx, v)),
    h("h2.section", null, "Models"),
    card("Models", null, modelTable(v)),
  );
  return {};
}

export async function cloudProjectsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const v = await teamData(ctx);
  el.append(top(ctx, v) ?? "", head(ctx, "Projects", `Every project that synced, ${rangeText(v)} · named by folder; the server keeps a hash of the git remote, never the path`));
  if (ctx.hosted && !hasData(v)) {
    el.append(connectPanel(ctx, v));
    return {};
  }
  el.append(card("Projects", null, projectTable(v)));
  return {};
}

const ENV_STATUS = { running: chip("Running", "ok"), idle: chip("Idle", "info"), off: chip("Off", "muted") };

export async function cloudEnvironmentsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  if (ctx.hosted) return machinesPage(ctx, el);
  el.append(
    previewBanner(ctx),
    head(ctx, "Environments", "Cloud sandboxes, CI runners and synced machines that report to the workspace"),
    h("div.int-grid", null, SAMPLE_ENVS.map((e) => h("article.int", null,
      h("header", null, logo(e.client, 34), h("div.grow", null, h("b", null, e.name), h("small", null, `${e.surface} · ${e.region}`)), ENV_STATUS[e.status].cloneNode(true)),
      h("dl.kv", null, h("dt", null, "Sessions"), h("dd.num", null, e.sessions), h("dt", null, "Spend"), h("dd.num", null, usd(e.spendUsd)), h("dt", null, "Kept out"), h("dd.num", null, tok(e.keptOut))),
      h("footer", null, sample(), h("span.muted", null, `Last activity ${agoMin(e.last)}`))))),
  );
  return {};
}

/** Hosted Environments: the CLI logins and cloud-agent keys that sync into this team. */
async function machinesPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const v = await teamData(ctx);
  const revoke = async (m: TeamMachine) => {
    if (!confirm(`Disconnect "${m.label}"? That machine stops syncing here until it runs snout login again.`)) return;
    try {
      await ctx.post(`/api/tokens/${encodeURIComponent(m.id)}/revoke`);
      ctx.toast("Disconnected. Its synced totals stay.");
      ctx.refresh();
    } catch (e) {
      ctx.toast((e as Error).message, "bad");
    }
  };
  el.append(head(ctx, "Environments", "Machines and cloud agents that sync into this workspace"));
  el.append(card("Machines", `A machine is one snout login. ${v.machines.length ? "Disconnecting one stops its syncs; what it already sent stays." : ""}`,
    v.machines.length
      ? table([{ label: "Machine" }, { label: "Owner" }, { label: "Kind" }, { label: "Connected" }, { label: "Last sync", cls: "r" }, { label: "", cls: "r" }],
          v.machines.map((m) => [h("span.cell-logo", null, logo(m.kind === "workspace" ? "cloud" : "snout", 22), h("span", null, m.label)), m.owner, m.kind === "workspace" ? chip("Cloud agent", "info") : chip("CLI login", "muted"),
            m.createdAt ? dayLabel(m.createdAt.slice(0, 10)) : "–", m.lastUsedAt ? ago(m.lastUsedAt) : "never",
            m.mine ? h("button.btn.sm", { onclick: () => void revoke(m) }, "Disconnect") : ""]))
      : empty("No machines yet", "Run this in a project where Snout runs, then approve the code in the browser.", ctx.boot.hosted?.connect)));
  if (v.machines.length) el.append(connectPanel(ctx, { ...v, machines: [] }));
  return {};
}

const KIND: Record<SampleIntegration["kind"], string> = { agent: "Coding agents", model: "Models", mcp: "MCP servers and apps", app: "Apps" };

export async function cloudIntegrationsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  if (ctx.hosted) return hostedIntegrations(ctx, el);
  const on = SAMPLE_INTEGRATIONS.filter((i) => i.status === "connected").length;
  el.append(previewBanner(ctx), head(ctx, "Integrations", `${on} connected in the sample workspace · Snout trims what these tools return before the agent reads it`));
  for (const k of ["agent", "model", "mcp"] as const) {
    const list = SAMPLE_INTEGRATIONS.filter((i) => i.kind === k);
    el.append(h("h2.section", null, KIND[k]), h("div.int-grid", null, list.map((i) => h("article.int", null,
      h("header", null, logo(i.kind === "model" && i.id === "claude-model" ? "claude" : i.id, 34), h("div.grow", null, h("b", null, i.name), h("small", null, i.detail)), i.status === "connected" ? chip("Connected", "ok") : chip("Available", "muted")),
      h("footer", null, sample(), h("span.muted", null, i.calls ? `${i.calls.toLocaleString()} calls this month` : "Not set up"))))));
  }
  return {};
}

/** Hosted Integrations: what the synced totals name. Agents, models, and MCP servers by their labels. */
async function hostedIntegrations(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const v = await teamData(ctx);
  el.append(head(ctx, "Integrations", `What synced in the ${rangeText(v)}: agents, models and MCP servers`));
  if (!hasData(v)) {
    el.append(connectPanel(ctx, v));
    return {};
  }
  const grid = (items: HTMLElement[], none: HTMLElement) => (items.length ? h("div.int-grid", null, items) : none);
  el.append(
    h("h2.section", null, "Coding agents"),
    grid(v.byClient.map((c) => h("article.int", null,
      h("header", null, logo(c.key, 34), h("div.grow", null, h("b", null, clientName(c.key)), h("small", null, `${c.members} ${c.members === 1 ? "person" : "people"}`)), chip("Reporting", "ok")),
      h("footer", null, basis("measured"), h("span.muted", null, `${int(c.spend.requests)} requests`)))), empty("No agents", "")),
    h("h2.section", null, "Models"),
    grid(v.byModel.map((m) => h("article.int", null,
      h("header", null, modelLogo(m.key, 34), h("div.grow", null, h("b", null, modelName(m.key)), h("small", null, clientName(m.client))), v.spend.unpriced.includes(m.key) ? chip("No list price", "muted") : chip("Priced", "ok")),
      h("footer", null, basis("measured"), h("span.muted", null, `${int(m.spend.requests)} requests · ${usd(m.spend.costUsd)}`)))), empty("No models", "")),
    h("h2.section", null, "MCP servers"),
    grid(v.byMcp.map((m) => h("article.int", null,
      h("header", null, logo(m.key, 34), h("div.grow", null, h("b", null, m.key), h("small", null, "MCP server")), chip("Reporting", "ok")),
      h("dl.kv", null, h("dt", null, "Calls"), h("dd.num", null, int(m.reads)), h("dt", null, "Reached context"), h("dd.num", null, tok(m.inContext)), h("dt", null, "Kept out"), h("dd.num", null, tok(m.keptOut))),
      h("footer", null, basis("estimated"), h("span")))),
    empty("No MCP calls synced", "When agents call MCP servers, each server shows up here with what Snout kept out of its results.")),
  );
  return {};
}

// ---------------------------------------------------------------- settings (hosted)

interface MemberRow { id: string; login: string; avatar: string | null; role: string; joinedAt: string; lastSync: string | null }

export async function cloudSettingsPage(ctx: Ctx, el: HTMLElement): Promise<PageHandle> {
  const hb = ctx.boot.hosted!;
  const team = teamOf(ctx)!;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      ctx.toast(ok);
    } catch (e) {
      ctx.toast((e as Error).message, "bad");
    }
  };

  const signOut = h("button.btn.sm", { onclick: () => void act(async () => { await ctx.post("/auth/logout"); location.href = "/login"; }, "Signed out.") }, "Sign out");
  const face = hb.user.avatar ? h("img.avatar", { src: hb.user.avatar, width: 34, height: 34, alt: "" }) : h("span.avatar", null, (hb.user.login[0] ?? "?").toUpperCase());
  const account = card("Account", null, h("div.row-between", null, h("span.cell-logo", null, face, h("span", null, h("b", null, hb.user.name ?? hb.user.login), h("small", null, `@${hb.user.login}`))), h("span", null, hb.user.admin ? chip("Admin", "accent") : null, " ", signOut)));

  const name = h("input.input", { placeholder: "Team name", "aria-label": "New team name", maxlength: 60 });
  const create = h("button.btn.sm", { onclick: () => void act(async () => {
    const n = name.value.trim();
    if (!n) throw new Error("Give the team a name.");
    const r = await ctx.post<{ id: string }>("/api/teams", { name: n });
    await ctx.switchTeam(String(r.id));
  }, "Team created.") }, "Create team");
  const workspaces = card("Workspaces", "Each workspace is its own dashboard. Your personal one holds only your machines; a team pools everyone's.",
    table([{ label: "Workspace" }, { label: "Role" }, { label: "Plan" }, { label: "People", cls: "r" }, { label: "", cls: "r" }],
      hb.teams.map((t) => [h("span", null, h("b", null, t.name), " ", t.personal ? chip("personal", "muted") : null), t.role, t.plan, h("span.num", null, t.members),
        t.id === hb.team ? chip("Showing", "accent") : h("button.btn.sm", { onclick: () => void ctx.switchTeam(t.id) }, "Open")])),
    h("div.inline-form", null, name, create),
    hb.beta ? h("p.muted.small", null, "During the beta, starting a team takes an access code. Joining one by invite does not.") : null);

  el.append(head(ctx, "Settings", "Your account, workspaces and machines"), h("div.grid", null,
    h("div.span-6", null, account, workspaces),
    h("div.span-6", null, await membersCard(ctx, team), card("Connect a machine", "Run in a project where Snout runs, then approve the code in the browser.", codeLine(hb.connect)),
      card("Stop syncing", null, h("p.muted", null, "On a machine, this stops its syncs and deletes its saved login:"), codeLine("npx usesnout logout"),
        h("p.muted.small", null, "To cut a machine off from here, disconnect it on Environments. Totals it already sent stay in the workspace.")))));
  return {};
}

async function membersCard(ctx: Ctx, team: HostedTeam): Promise<HTMLElement> {
  if (team.personal) return card("People", null, h("p.muted", null, "A personal workspace is just you. Create a team to invite people and see their totals together."));
  const m = await ctx.get<{ members: MemberRow[]; me: string }>(`teams/${team.id}/members`, {}, { range: false });
  const out = h("div");
  const invite = team.role === "owner" ? h("button.btn.sm", { onclick: async () => {
    try {
      const r = await ctx.post<{ url: string; expiresInDays: number }>(`/api/teams/${team.id}/invites`);
      out.replaceChildren(h("p.muted.small", null, `Send this link. It works for ${r.expiresInDays} days; whoever opens it signs in and joins.`), codeLine(r.url));
    } catch (e) {
      ctx.toast((e as Error).message, "bad");
    }
  } }, "Invite link") : null;
  return h("section.card", null,
    h("header.card-h", null, h("div", null, h("h3", null, "People"), h("p.sub", null, `${m.members.length} in ${team.name}`)), h("div.card-r", null, invite)),
    table([{ label: "Person" }, { label: "Role" }, { label: "Last sync", cls: "r" }],
      m.members.map((p) => [h("span.cell-logo", null, p.avatar ? h("img.avatar", { src: p.avatar, width: 24, height: 24, alt: "" }) : h("span.avatar", null, (p.login[0] ?? "?").toUpperCase()), h("span", null, p.login, p.id === m.me ? h("small", null, "you") : null)), p.role, p.lastSync ? ago(p.lastSync) : "never"])),
    out);
}
