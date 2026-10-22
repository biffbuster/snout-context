/**
 * Sample data for the Snout Cloud preview. Snout Cloud is not connected yet, so every number
 * here is made up and every page that shows it says so. Nothing in this file is read from, or
 * sent to, anywhere.
 */
import type { TeamClient, TeamMember, TeamSpend, TeamTotals, TeamView } from "../api.js";

export interface SampleEnv {
  id: string;
  name: string;
  surface: string;
  client: string;
  status: "running" | "idle" | "off";
  sessions: number;
  spendUsd: number;
  keptOut: number;
  region: string;
  last: number; // minutes ago
}

export interface SampleDev {
  name: string;
  email: string;
  clients: string[];
  sessions: number;
  spendUsd: number;
  keptOut: number;
  last: number;
}

export interface SampleIntegration {
  id: string;
  name: string;
  kind: "agent" | "model" | "mcp" | "app";
  status: "connected" | "available";
  detail: string;
  calls: number;
}

/** Fourteen days of team spend, deterministic so screenshots stay stable. */
export const SAMPLE_DAYS: { day: string; spendUsd: number; keptOut: number }[] = (() => {
  const out: { day: string; spendUsd: number; keptOut: number }[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const spend = (weekend ? 18 : 64) + rnd() * (weekend ? 10 : 38);
    out.push({ day: d.toISOString().slice(0, 10), spendUsd: Math.round(spend * 100) / 100, keptOut: Math.round(spend * 41_000 + rnd() * 300_000) });
  }
  return out;
})();

export const SAMPLE_ENVS: SampleEnv[] = [
  { id: "web", name: "Claude Code on the web", surface: "Cloud sandbox", client: "claude", status: "running", sessions: 38, spendUsd: 212.4, keptOut: 8_420_000, region: "us-east", last: 2 },
  { id: "codex-cloud", name: "Codex cloud", surface: "Cloud tasks", client: "codex", status: "running", sessions: 21, spendUsd: 96.1, keptOut: 3_150_000, region: "us-east", last: 6 },
  { id: "ci", name: "GitHub Actions", surface: "CI · headless", client: "github", status: "idle", sessions: 64, spendUsd: 141.8, keptOut: 5_980_000, region: "runner", last: 47 },
  { id: "laptops", name: "Developer laptops", surface: "Local CLI, synced totals", client: "snout", status: "idle", sessions: 112, spendUsd: 318.2, keptOut: 12_700_000, region: "5 machines", last: 11 },
  { id: "staging", name: "Staging agent", surface: "Scheduled · SDK", client: "openai", status: "off", sessions: 0, spendUsd: 0, keptOut: 0, region: "eu-west", last: 4320 },
];

export const SAMPLE_DEVS: SampleDev[] = [
  { name: "Ana", email: "ana@example.com", clients: ["claude", "codex"], sessions: 61, spendUsd: 188.3, keptOut: 7_900_000, last: 2 },
  { name: "Ben", email: "ben@example.com", clients: ["claude"], sessions: 44, spendUsd: 131.5, keptOut: 5_100_000, last: 14 },
  { name: "Chen", email: "chen@example.com", clients: ["codex"], sessions: 37, spendUsd: 97.0, keptOut: 3_600_000, last: 32 },
  { name: "Dara", email: "dara@example.com", clients: ["claude", "cursor"], sessions: 29, spendUsd: 84.6, keptOut: 2_950_000, last: 75 },
  { name: "Eli", email: "eli@example.com", clients: ["claude", "gemini"], sessions: 19, spendUsd: 51.2, keptOut: 1_800_000, last: 260 },
];

const mcp = (id: string, name: string, status: SampleIntegration["status"], detail: string, calls: number): SampleIntegration => ({ id, name, kind: "mcp", status, detail, calls });

export const SAMPLE_INTEGRATIONS: SampleIntegration[] = [
  { id: "claude", name: "Claude Code", kind: "agent", status: "connected", detail: "Hooks report to the team workspace", calls: 1840 },
  { id: "codex", name: "Codex", kind: "agent", status: "connected", detail: "Hooks report to the team workspace", calls: 920 },
  { id: "cursor", name: "Cursor", kind: "agent", status: "connected", detail: "MCP client, totals only", calls: 310 },
  { id: "gemini", name: "Gemini CLI", kind: "agent", status: "available", detail: "Add Snout's hooks to report here", calls: 0 },
  { id: "claude-model", name: "Claude", kind: "model", status: "connected", detail: "Opus, Sonnet and Haiku, priced at list", calls: 5210 },
  { id: "openai", name: "GPT", kind: "model", status: "connected", detail: "GPT and Codex models, priced at list", calls: 2380 },
  mcp("github", "GitHub", "connected", "Issues, pull requests, code search", 2140),
  mcp("figma", "Figma", "connected", "Frames and variables for design-to-code", 380),
  mcp("slack", "Slack", "connected", "Channel history and threads", 760),
  mcp("linear", "Linear", "connected", "Issues and projects", 540),
  mcp("notion", "Notion", "connected", "Pages and databases", 410),
  mcp("sentry", "Sentry", "connected", "Errors and stack traces", 290),
  mcp("hubspot", "HubSpot", "available", "Contacts, deals and tickets", 0),
  mcp("telegram", "Telegram", "available", "Bot messages and chats", 0),
  mcp("stripe", "Stripe", "available", "Customers, invoices and events", 0),
  mcp("jira", "Jira", "available", "Issues and sprints", 0),
  mcp("confluence", "Confluence", "available", "Spaces and pages", 0),
  mcp("googledrive", "Google Drive", "connected", "Docs, Sheets and files", 220),
  mcp("gmail", "Gmail", "available", "Threads and drafts", 0),
  mcp("googlecalendar", "Google Calendar", "available", "Events and availability", 0),
  mcp("supabase", "Supabase", "connected", "Tables, SQL and logs", 330),
  mcp("postgresql", "PostgreSQL", "connected", "Read-only queries", 470),
  mcp("vercel", "Vercel", "available", "Deployments and logs", 0),
  mcp("airtable", "Airtable", "available", "Bases and records", 0),
  mcp("asana", "Asana", "available", "Tasks and projects", 0),
  mcp("zapier", "Zapier", "available", "Actions across apps", 0),
  mcp("discord", "Discord", "available", "Server channels", 0),
];

/**
 * The sample as a team view: the same shape Snout Cloud returns (api.ts TeamView), so the preview
 * and the hosted page render one structure and the preview cannot show what the cloud never has.
 */
export function sampleTeam(): TeamView {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString().slice(0, 10);
  const spend = (costUsd: number): TeamSpend => ({ requests: Math.round(costUsd * 9), tokens: Math.round(costUsd * 310_000), cacheRead: Math.round(costUsd * 250_000), costUsd });
  const snout = (keptOut: number): TeamTotals => ({ reads: Math.round(keptOut / 2600), gated: Math.round(keptOut / 9000), inContext: keptOut * 2, keptOut, couldKeepOut: 0 });
  const byMember: TeamMember[] = SAMPLE_DEVS.map((d) => ({ key: d.email.split("@")[0]!, name: d.name, avatar: null, agent: false, clients: d.clients, snout: snout(d.keptOut), spend: spend(d.spendUsd), last: minutesAgo(d.last) }));
  const clients = new Map<string, TeamClient>();
  for (const d of SAMPLE_DEVS) {
    const share = 1 / d.clients.length;
    for (const c of d.clients) {
      const a = clients.get(c) ?? { key: c, name: c, members: 0, models: [], snout: snout(0), spend: spend(0), last: null };
      const s = spend(d.spendUsd * share);
      const k = snout(Math.round(d.keptOut * share));
      a.members += 1;
      for (const f of ["requests", "tokens", "cacheRead", "costUsd"] as const) a.spend[f] += s[f];
      for (const f of ["reads", "gated", "inContext", "keptOut"] as const) a.snout[f] += k[f];
      clients.set(c, a);
    }
  }
  const sum = (f: (d: SampleDev) => number) => SAMPLE_DEVS.reduce((a, d) => a + f(d), 0);
  const models: [string, string, number][] = [["claude-sonnet-5-5", "claude", 0.46], ["claude-opus-5-5", "claude", 0.27], ["gpt-5.1-codex", "codex", 0.19], ["gemini-3-pro", "gemini", 0.08]];
  const total = sum((d) => d.spendUsd);
  const kept = sum((d) => d.keptOut);
  const projects: [string, number][] = [["web-app", 0.41], ["api", 0.29], ["mobile", 0.18], ["infra", 0.12]];
  const mcp = SAMPLE_INTEGRATIONS.filter((i) => i.kind === "mcp" && i.calls).map((i) => ({ key: i.id, reads: i.calls, inContext: i.calls * 900, keptOut: i.calls * 1400 }));
  return {
    team: { id: "sample", name: "Sample team", personal: false, plan: "team", role: "owner", members: SAMPLE_DEVS.length },
    days: SAMPLE_DAYS.length,
    capped: null,
    totals: snout(kept),
    spend: { ...spend(total), unpriced: [] },
    series: SAMPLE_DAYS.map((d) => ({ day: d.day, inContext: d.keptOut * 2, keptOut: d.keptOut, costUsd: d.spendUsd, tokens: Math.round(d.spendUsd * 310_000) })),
    byMember,
    byClient: [...clients.values()].sort((a, b) => b.spend.costUsd - a.spend.costUsd),
    byModel: models.map(([m, c, share]) => ({ key: m, name: m, client: c, snout: snout(Math.round(kept * share)), spend: spend(total * share), last: minutesAgo(5) })),
    byProject: projects.map(([p, share]) => ({ key: p, name: p, snout: snout(Math.round(kept * share)), spend: spend(total * share), last: minutesAgo(30) })),
    byLabel: [["logs", 0.34], ["generated", 0.22], ["lockfile", 0.16], ["mcp", 0.18], ["docs", 0.1]].map(([k, share]) => ({ key: k as string, reads: Math.round(4000 * (share as number)), inContext: Math.round(kept * 0.2 * (share as number)), keptOut: Math.round(kept * (share as number)) })),
    byMcp: mcp,
    machines: [],
    lastSyncAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    now: new Date().toISOString(),
  };
}
