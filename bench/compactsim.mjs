#!/usr/bin/env node
/**
 * Compaction policies, replayed on recorded Claude Code sessions. Free and offline.
 *
 *   node bench/compactsim.mjs <transcript.jsonl>... [--json]
 *
 * What it answers: if compaction had happened at other moments, how many input tokens would the
 * session have used, and how much would it have had to read again? Policies:
 *
 *   real           what happened (Claude Code's own auto-compaction)
 *   fixed:<N>      compact whenever context passes N tokens
 *   smart:<F>      compact only at a break in the work (a commit, a passing test run, or the user's
 *                  next prompt) once context is above F; a compaction is forced at the session's
 *                  own ceiling, and those forced ones count as mid-task
 *
 * The model, kept simple on purpose:
 *   - Context grows by what each request added in the real session (its growth since the
 *     previous request); a real compaction's drop is ignored, since the policy decides instead.
 *   - After a compaction, context restarts at the session's measured post-compaction size
 *     (summary plus the fixed prompt), plus the memory block (--block, default 600 tokens).
 *   - Each compaction costs one extra request that reads the whole context (the summary call).
 *   - Forgetting costs re-reads: a file read before a compaction and read or edited again after
 *     it comes back into context at the size its earlier read had. This undercounts mid-task
 *     loss (lost reasoning is not modelled), so `smart` and `fixed` are compared on the same terms.
 *
 * An estimate of input tokens, not of outcomes: an agent that forgot something acts differently.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const blockAt = args.indexOf("--block");
const BLOCK = blockAt >= 0 ? Number(args[blockAt + 1]) : 600;
const files = args.filter((a, i) => a.endsWith(".jsonl") && args[i - 1] !== "--block");
if (!files.length) {
  process.stderr.write("usage: node bench/compactsim.mjs <transcript.jsonl>... [--json] [--block 600]\n");
  process.exit(2);
}

const COMMIT = /\bgit\b[^|;&]*\b(commit|merge)\b/;
const TEST = /\b(npm (run )?(test|verify)|pnpm (run )?test|yarn test|pytest|go test|cargo test|node --test|vitest|jest|make test)\b/;
const FAIL = /\b(fail(ed|ures?)?|error|✖|not ok|traceback)\b/i;

/** One session as a list of main-thread requests, each with its context size and what happened before it. */
function load(file) {
  const reqs = [];
  const seen = new Set();
  const pending = new Map(); // tool_use id -> { name, path, command }
  let events = []; // since the previous request: { kind, path?, tokens? }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.type === "system" && e.subtype === "compact_boundary") { events.push({ kind: "real-compact" }); continue; }
    const m = e.message;
    if (!m) continue;
    if (e.type === "user") {
      if (typeof m.content === "string") {
        if (!e.isMeta && !m.content.startsWith("<command-") && !e.isCompactSummary) events.push({ kind: "prompt" });
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      // A person's prompt: a user turn with no tool results (system reminders often ride along in front).
      let human = !e.isMeta && !e.isCompactSummary && !m.content.some((b) => b.type === "tool_result") && m.content.some((b) => b.type === "text" && !/^<(command-|local-command)/.test(String(b.text)));
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const t = pending.get(b.tool_use_id);
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.filter((x) => x?.type === "text").map((x) => x.text).join("") : "";
          const tokens = Math.ceil(text.length / 4);
          if (!t) continue;
          if (t.path && (t.name === "Read" || t.name === "Edit" || t.name === "Write" || t.name === "NotebookEdit")) events.push({ kind: t.name === "Read" ? "read" : "edit", path: t.path, tokens });
          if (t.command && COMMIT.test(t.command) && !b.is_error) events.push({ kind: "commit" });
          if (t.command && TEST.test(t.command) && !b.is_error && !FAIL.test(text.slice(-2000))) events.push({ kind: "green" });
        }
      }
      if (human && !e.isCompactSummary) events.push({ kind: "prompt" });
      continue;
    }
    if (e.type !== "assistant") continue;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === "tool_use") pending.set(b.id, { name: b.name, path: b.input?.file_path ?? b.input?.notebook_path ?? null, command: typeof b.input?.command === "string" ? b.input.command : null });
    }
    if (!m.usage || (m.id && seen.has(m.id))) continue;
    if (m.id) seen.add(m.id);
    const u = m.usage;
    reqs.push({ ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), events });
    events = [];
  }
  return reqs;
}

/** Where Claude Code compacted on its own: the median context just before each real compaction, else the session's peak. */
function autoPoint(reqs) {
  const before = [];
  for (let i = 1; i < reqs.length; i++) if (reqs[i].events.some((x) => x.kind === "real-compact") || reqs[i].ctx < reqs[i - 1].ctx * 0.5) before.push(reqs[i - 1].ctx);
  if (!before.length) return Math.max(...reqs.map((r) => r.ctx));
  before.sort((a, b) => a - b);
  return before[Math.floor(before.length / 2)];
}

/** The session's measured restart size: median context of the first request after each real compaction. */
function restartSize(reqs) {
  const after = [];
  for (let i = 1; i < reqs.length; i++) if (reqs[i].events.some((x) => x.kind === "real-compact") || reqs[i].ctx < reqs[i - 1].ctx * 0.5) after.push(reqs[i].ctx);
  if (!after.length) return Math.min(...reqs.slice(0, 3).map((r) => r.ctx));
  after.sort((a, b) => a - b);
  return after[Math.floor(after.length / 2)];
}

function simulate(reqs, policy) {
  const base = restartSize(reqs);
  const ceiling = autoPoint(reqs);
  let ctx = reqs[0]?.ctx ?? 0;
  let input = 0;
  let compactions = 0;
  let forced = 0;
  let rereadTokens = 0;
  let since = new Map(); // path -> tokens of its read since the last compaction
  let forgotten = new Map(); // read before the last compaction, not yet back in context
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    if (i > 0) {
      const grew = r.events.some((x) => x.kind === "real-compact") || r.ctx < reqs[i - 1].ctx * 0.5 ? 0 : Math.max(0, r.ctx - reqs[i - 1].ctx);
      ctx += grew;
    }
    for (const ev of r.events) {
      if ((ev.kind === "read" || ev.kind === "edit") && forgotten.has(ev.path)) {
        // Needed again after it was compacted away: it comes back at its earlier size.
        const t = forgotten.get(ev.path);
        if (ev.kind === "edit") { ctx += t; rereadTokens += t; }
        forgotten.delete(ev.path);
      }
      if (ev.kind === "read") since.set(ev.path, ev.tokens);
    }
    const atBreak = r.events.some((x) => x.kind === "commit" || x.kind === "green" || x.kind === "prompt");
    let compact = false;
    if (policy.kind === "real") compact = false;
    else if (policy.kind === "fixed") compact = ctx >= policy.at;
    else if (policy.kind === "smart") {
      if (ctx >= ceiling) { compact = true; forced++; }
      else compact = atBreak && ctx >= policy.floor;
    }
    if (policy.kind === "real") {
      input += r.ctx;
      if (r.events.some((x) => x.kind === "real-compact")) compactions++;
      continue;
    }
    if (compact) {
      input += ctx; // the summary request reads everything once
      compactions++;
      for (const [p, t] of since) forgotten.set(p, t);
      since = new Map();
      ctx = base + BLOCK;
    }
    input += ctx;
  }
  return { input, compactions, forced, rereadTokens };
}

const POLICIES = [
  { name: "real", kind: "real" },
  { name: "fixed 150k", kind: "fixed", at: 150_000 },
  { name: "fixed 100k", kind: "fixed", at: 100_000 },
  { name: "smart, floor 120k", kind: "smart", floor: 120_000 },
  { name: "smart, floor 100k", kind: "smart", floor: 100_000 },
  { name: "smart, floor 80k", kind: "smart", floor: 80_000 },
];

const results = [];
for (const f of files) {
  const reqs = load(f);
  if (reqs.length < 20) continue;
  const real = simulate(reqs, POLICIES[0]);
  const rows = POLICIES.map((p) => ({ policy: p.name, ...simulate(reqs, p) })).map((r) => ({ ...r, change: r.input / real.input - 1 }));
  const breaks = reqs.filter((r) => r.events.some((x) => x.kind === "commit" || x.kind === "green" || x.kind === "prompt")).length;
  results.push({ file: f.split(/[\\/]/).pop(), requests: reqs.length, restart: restartSize(reqs), ceiling: autoPoint(reqs), breaks, rows });
}

if (json) {
  process.stdout.write(JSON.stringify({ block: BLOCK, results }, null, 2) + "\n");
} else {
  const k = (n) => `${(n / 1000).toFixed(0)}k`;
  const m = (n) => `${(n / 1e6).toFixed(1)}M`;
  for (const s of results) {
    process.stdout.write(`\n${s.file.slice(0, 12)}  ${s.requests} requests · restart ${k(s.restart)} · auto-compacts at ${k(s.ceiling)} · ${s.breaks} breaks in the work\n`);
    process.stdout.write(`  ${"policy".padEnd(20)} ${"input".padStart(8)} ${"change".padStart(8)} ${"compactions".padStart(12)} ${"forced".padStart(7)} ${"re-read".padStart(8)}\n`);
    for (const r of s.rows) process.stdout.write(`  ${r.policy.padEnd(20)} ${m(r.input).padStart(8)} ${(r.policy === "real" ? "" : `${(r.change * 100).toFixed(1)}%`).padStart(8)} ${String(r.compactions).padStart(12)} ${String(r.forced).padStart(7)} ${k(r.rereadTokens).padStart(8)}\n`);
  }
  process.stdout.write(`\nInput tokens only (cache reads included), memory block ${BLOCK} tokens after each compaction. Re-reads model what a compaction forgot; lost reasoning is not modelled.\n`);
}
