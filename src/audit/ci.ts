/**
 * CI audit: the AI agents a repository runs in GitHub Actions (the Claude Code and Codex actions, and
 * `claude -p` / `codex exec` in run steps), what triggers each one, its model and limits, and the
 * settings that make it run, and pay, more often than anyone meant: a review on every push to a PR,
 * a run on every comment, no turn limit, no cancel when a newer push arrives, drafts and bot PRs.
 *
 * Local only: it reads .github/workflows and the instruction files each run loads (via the context
 * audit). It never calls GitHub or a model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { asList, asMap, asStr, parseYaml, type Yaml } from "./yaml.js";
import { auditContext, totals } from "./context.js";

export type CiFlagCode = "every-push" | "every-comment" | "no-limit" | "no-concurrency" | "drafts" | "bot-prs" | "frequent-schedule" | "top-model";

export interface CiFlag {
  code: CiFlagCode;
  reason: string;
  /** The change that fixes it, as workflow YAML or a one-line instruction. */
  fix: string;
}

export interface CiTrigger {
  event: string;
  /** Types, branches, cron: what narrows the event, as written. */
  detail: string;
}

export interface AiStep {
  workflow: string;
  job: string;
  step: string;
  agent: "claude" | "codex";
  via: "action" | "cli";
  /** Claude Code action: "tag" answers @mentions, assignments and labels; "automation" runs its prompt on every trigger. */
  mode: "tag" | "automation";
  model: string | null;
  maxTurns: number | null;
  budgetUsd: number | null;
  effort: string | null;
  plugins: string[];
  triggers: CiTrigger[];
  /** Estimated scheduled runs per month, when the workflow runs on a cron. */
  scheduledPerMonth: number | null;
  flags: CiFlag[];
}

export interface CiAudit {
  projectDir: string;
  workflows: number;
  steps: AiStep[];
  /** Instruction tokens each run loads before any work, per agent (root CLAUDE.md, AGENTS.md, rules, skill descriptions). */
  loadedPerRun: { claude: number; codex: number };
  unreadable: { file: string; error: string }[];
}

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
const COMMENT_EVENTS = new Set(["issue_comment", "pull_request_review_comment", "pull_request_review", "discussion_comment"]);
const PR_DEFAULT_TYPES = ["opened", "synchronize", "reopened"];

function triggersOf(on: Yaml): { triggers: CiTrigger[]; events: Record<string, Record<string, Yaml>> } {
  const events: Record<string, Record<string, Yaml>> = {};
  if (typeof on === "string") events[on] = {};
  else if (Array.isArray(on)) for (const e of on) events[asStr(e)] = {};
  else for (const [k, v] of Object.entries(asMap(on))) events[k] = k === "schedule" ? { cron: asList(v).map((c) => asStr(asMap(c).cron)) as Yaml } : asMap(v);
  const triggers = Object.entries(events).map(([event, cfg]) => {
    const parts: string[] = [];
    if (cfg.types) parts.push(`types: ${asList(cfg.types).map(asStr).join(", ")}`);
    else if (PR_EVENTS.has(event)) parts.push("types: opened, synchronize, reopened (default)");
    if (cfg.branches) parts.push(`branches: ${asList(cfg.branches).map(asStr).join(", ")}`);
    if (cfg.paths) parts.push("paths filter");
    if (event === "schedule") parts.push(asList(cfg.cron).map(asStr).join(", "));
    return { event, detail: parts.join("; ") };
  });
  return { triggers, events };
}

/** Rough runs per month of a 5-field cron. */
export function cronPerMonth(cron: string): number | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const count = (field: string, size: number): number => {
    let n = 0;
    for (const part of field.split(",")) {
      const [range, step] = part.split("/");
      const s = Number(step ?? 1) || 1;
      if (range === "*") n += Math.ceil(size / s);
      else if (range!.includes("-")) { const [a, b] = range!.split("-").map(Number); n += Math.floor(((b ?? 0) - (a ?? 0)) / s) + 1; }
      else n += 1;
    }
    return n;
  };
  const perDay = count(f[0]!, 60) * count(f[1]!, 24);
  const days = f[4] !== "*" ? (30 * count(f[4]!, 7)) / 7 : f[2] !== "*" ? count(f[2]!, 31) : 30;
  const months = f[3] !== "*" ? count(f[3]!, 12) / 12 : 1;
  return Math.round(perDay * days * months);
}

/** --model, --max-turns, --max-budget-usd from a command line or claude_args. */
function cliOptions(s: string) {
  const opt = (re: RegExp) => re.exec(s)?.[1] ?? null;
  const turns = opt(/--max-turns[= ]+["']?(\d+)/);
  const budget = opt(/--max-budget-usd[= ]+["']?([\d.]+)/);
  return {
    model: opt(/(?:--model|(?:^|\s)-m)[= ]+["']?([\w.:\/-]+)/),
    maxTurns: turns ? Number(turns) : null,
    budgetUsd: budget ? Number(budget) : null,
    effort: opt(/model_reasoning_effort[= ]*["']?=?["']?(\w+)/) ?? opt(/--effort[= ]+["']?(\w+)/),
  };
}

const CLAUDE_CLI = /(^|[\s;&|(`$])(?:npx\s+(?:-y\s+)?@anthropic-ai\/claude-code|claude)\s+(?:[^\n|;&]*\s)?(?:-p|--print)\b/m;
const CODEX_CLI = /(^|[\s;&|(`$])(?:npx\s+(?:-y\s+)?@openai\/codex|codex)\s+exec\b/m;

export function auditCi(projectDir: string, opts: { home?: string } = {}): CiAudit {
  const dir = resolve(projectDir);
  const wfDir = join(dir, ".github", "workflows");
  const steps: AiStep[] = [];
  const unreadable: CiAudit["unreadable"] = [];
  const files = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/i.test(f)).sort() : [];
  for (const file of files) {
    let doc: Record<string, Yaml>;
    try { doc = asMap(parseYaml(readFileSync(join(wfDir, file), "utf8"))); } catch (e) { unreadable.push({ file, error: String((e as Error).message ?? e) }); continue; }
    const { triggers, events } = triggersOf(doc.on ?? doc.true ?? null);
    const wfConcurrency = doc.concurrency;
    const sched = asList(events.schedule?.cron).map((c) => cronPerMonth(asStr(c))).filter((n): n is number => n !== null);
    for (const [jobId, jobY] of Object.entries(asMap(doc.jobs))) {
      const job = asMap(jobY);
      const jobIf = asStr(job.if);
      const concurrency = job.concurrency ?? wfConcurrency;
      asList(job.steps).forEach((stepY, i) => {
        const step = asMap(stepY);
        const uses = asStr(step.uses);
        const run = asStr(step.run);
        const w = asMap(step.with);
        const name = asStr(step.name) || asStr(step.id) || uses.split("@")[0] || `step ${i + 1}`;
        let found: Omit<AiStep, "workflow" | "job" | "step" | "triggers" | "scheduledPerMonth" | "flags"> | null = null;
        if (/^anthropics\/claude-code(-base)?-action@/i.test(uses)) {
          const o = cliOptions(asStr(w.claude_args));
          const prompt = asStr(w.prompt) || asStr(w.direct_prompt) || asStr(w.override_prompt);
          found = {
            agent: "claude", via: "action",
            mode: /base-action/i.test(uses) || prompt ? "automation" : "tag",
            model: o.model ?? (asStr(w.model) || asStr(w.anthropic_model) || null),
            maxTurns: o.maxTurns ?? (Number(asStr(w.max_turns)) || null),
            budgetUsd: o.budgetUsd, effort: null,
            plugins: asStr(w.plugins).split(/[\s,]+/).filter(Boolean),
          };
        } else if (/^openai\/codex-action@/i.test(uses)) {
          const o = cliOptions(asStr(w["codex-args"]));
          found = { agent: "codex", via: "action", mode: "automation", model: asStr(w.model) || o.model, maxTurns: null, budgetUsd: null, effort: asStr(w.effort) || o.effort, plugins: [] };
        } else if (CLAUDE_CLI.test(run)) {
          const o = cliOptions(run);
          found = { agent: "claude", via: "cli", mode: "automation", model: o.model, maxTurns: o.maxTurns, budgetUsd: o.budgetUsd, effort: null, plugins: [] };
        } else if (CODEX_CLI.test(run)) {
          const o = cliOptions(run);
          found = { agent: "codex", via: "cli", mode: "automation", model: o.model, maxTurns: null, budgetUsd: null, effort: o.effort, plugins: [] };
        }
        if (!found) return;
        const conditions = [jobIf, asStr(step.if)].join(" ");
        const s: AiStep = { workflow: file, job: jobId, step: name, ...found, triggers, scheduledPerMonth: sched.length ? sched.reduce((a, b) => a + b, 0) : null, flags: [] };
        flagStep(s, events, conditions, concurrency, Number(asStr(job["timeout-minutes"])) || null);
        // GitHub agentic workflows compile a .md into this .lock.yml: the fix goes in the source.
        if (/\.lock\.ya?ml$/i.test(file)) for (const f of s.flags) f.fix += ` (in ${file.replace(/\.lock\.ya?ml$/i, ".md")}, then recompile)`;
        steps.push(s);
      });
    }
  }
  let loadedPerRun = { claude: 0, codex: 0 };
  if (steps.length) {
    const t = totals(auditContext(dir, { home: opts.home ?? join(dir, ".snout", "no-home"), noUsage: true, noGit: true }));
    // A CI runner has no user-level files: only the repository's own instructions load.
    loadedPerRun = { claude: (t.always.byAgent.claude ?? 0) + t.described.perSession, codex: t.always.byAgent.codex ?? 0 };
  }
  return { projectDir: dir, workflows: files.length, steps, loadedPerRun, unreadable };
}

function flagStep(s: AiStep, events: Record<string, Record<string, Yaml>>, conditions: string, concurrency: Yaml | undefined, timeoutMin: number | null): void {
  const flag = (code: CiFlagCode, reason: string, fix: string) => s.flags.push({ code, reason, fix });
  const runsOnEverything = s.mode === "automation";
  const prEvents = Object.keys(events).filter((e) => PR_EVENTS.has(e));
  if (runsOnEverything && prEvents.length) {
    const types = prEvents.flatMap((e) => (events[e]!.types ? asList(events[e]!.types).map(asStr) : PR_DEFAULT_TYPES));
    if (types.includes("synchronize"))
      flag("every-push", "runs again on every push to an open PR, so a PR pushed 6 times pays for 6 runs", "on: pull_request: types: [opened, ready_for_review]  (or trigger on a label or an @mention)");
    if (!/draft/.test(conditions) && !types.every((t) => t === "ready_for_review"))
      flag("drafts", "also runs on draft PRs, which usually change again before review", "if: github.event.pull_request.draft == false");
    if (!/github\.actor|user\.(login|type)|\bbots?\b|\[bot\]|dependabot|renovate/i.test(conditions))
      flag("bot-prs", "also runs on PRs opened by bots (Dependabot, Renovate), which rarely need an AI review", "if: \"!endsWith(github.actor, '[bot]')\"");
    const conc = asMap(concurrency);
    if (!concurrency || !/true/.test(asStr(conc["cancel-in-progress"]) || ""))
      flag("no-concurrency", "a new push doesn't cancel the run still going for the previous one; both are billed", "concurrency: { group: ${{ github.workflow }}-${{ github.event.pull_request.number }}, cancel-in-progress: true }");
  }
  const commentEvents = Object.keys(events).filter((e) => COMMENT_EVENTS.has(e));
  if (runsOnEverything && commentEvents.length && !/comment\.body|review\.body|contains\(/.test(conditions))
    flag("every-comment", `runs on every ${commentEvents.join(" / ")}, not only the ones that ask for it`, "if: contains(github.event.comment.body, '@claude')");
  if (s.agent === "claude" && s.maxTurns === null && s.budgetUsd === null)
    flag("no-limit", `no turn or budget limit: one confused run can loop until the job times out (${timeoutMin ? `${timeoutMin} min here` : "6 hours by default"})`, s.via === "action" ? "claude_args: --max-turns 15" : "add --max-turns 15 (or --max-budget-usd 2)");
  if (s.scheduledPerMonth !== null && s.scheduledPerMonth > 31)
    flag("frequent-schedule", `scheduled about ${s.scheduledPerMonth} times a month`, "run it daily or weekly unless each run finds new work");
  if (s.model && /opus/i.test(s.model))
    flag("top-model", `uses ${s.model}, the most expensive tier; reviews and triage usually run as well on a Sonnet model`, "try --model with a Sonnet model on a few PRs and compare");
}

export function renderCi(a: CiAudit): string {
  if (!a.steps.length) return `No AI agents run in this repository's GitHub Actions (${a.workflows} workflow${a.workflows === 1 ? "" : "s"} checked).${a.unreadable.length ? `\nCould not read: ${a.unreadable.map((u) => u.file).join(", ")}` : ""}`;
  const lines = [`AI agents in GitHub Actions for ${a.projectDir} · ${a.steps.length} step${a.steps.length === 1 ? "" : "s"} in ${new Set(a.steps.map((s) => s.workflow)).size} workflow${a.steps.length === 1 ? "" : "s"}`, ""];
  const agentName = { claude: "Claude Code", codex: "Codex" };
  for (const s of a.steps) {
    const limits = [s.maxTurns !== null ? `max ${s.maxTurns} turns` : "", s.budgetUsd !== null ? `$${s.budgetUsd} cap` : "", s.effort ? `effort ${s.effort}` : ""].filter(Boolean).join(", ");
    lines.push(`  ${s.workflow} › ${s.job} › ${s.step}`);
    lines.push(`    ${agentName[s.agent]} ${s.via === "action" ? "action" : "CLI"}${s.agent === "claude" && s.via === "action" ? ` (${s.mode} mode)` : ""} · model ${s.model ?? "default"}${limits ? ` · ${limits}` : ""}${s.plugins.length ? ` · plugins: ${s.plugins.join(", ")}` : ""}`);
    lines.push(`    runs on: ${s.triggers.map((t) => (t.detail ? `${t.event} (${t.detail})` : t.event)).join(", ")}`);
    for (const f of s.flags) lines.push(`    ✗ ${f.reason}`, `      fix: ${f.fix}`);
    if (!s.flags.length) lines.push("    ✓ nothing to change");
    lines.push("");
  }
  const per = [a.loadedPerRun.claude && a.steps.some((s) => s.agent === "claude") ? `Claude Code ~${Math.round(a.loadedPerRun.claude).toLocaleString("en-US")}` : "", a.loadedPerRun.codex && a.steps.some((s) => s.agent === "codex") ? `Codex ~${Math.round(a.loadedPerRun.codex).toLocaleString("en-US")}` : ""].filter(Boolean);
  if (per.length) lines.push(`Every run starts by loading the repository's instructions: ${per.join(", ")} tokens. \`snout audit context\` shows what to trim; each token saved there is saved on every CI run too.`);
  if (a.unreadable.length) lines.push(`Could not read: ${a.unreadable.map((u) => u.file).join(", ")}`);
  return lines.join("\n").trimEnd();
}
