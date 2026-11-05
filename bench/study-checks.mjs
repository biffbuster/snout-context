/**
 * The memory study's accounting and validity rules, kept apart from the harness so tests can hold
 * them to the protocol (docs/benchmark-protocol.md, "Validity" and "Budgets and limits"). Gate 1 of
 * docs/memory-gates.md: each rule here was wrong once in a real run.
 */

/**
 * Commands that reach, or try to reach, the network. `npx`, `pnpm dlx`, `yarn dlx` and `bunx` count
 * only when they would fetch a package: `npx vitest` runs the installed copy (and npm is offline).
 */
const NETWORK = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|gh\s|git\s+(?:fetch|pull|clone|push|ls-remote)|npm\s+(?:i|install|add)\b|pnpm\s+(?:i|install|add|dlx)\b|yarn\s+dlx\b|bunx\s|go\s+(?:get|install|mod\s+download))/i;
/** A URL counts only next to code that fetches it; a URL in an edited string or a message is text. */
const REMOTE_URL = /https?:\/\/(?!localhost|127\.0\.0\.1)/i;
const FETCH_CALL = /\b(?:fetch\s*\(|urlopen|requests\.(?:get|post)|https?\.get\s*\(|http\.Get\s*\(|axios|XMLHttpRequest|WebClient|socket\.connect)/i;
/** npx fetches when told to (`-y`, `--package`) or when the command names a version (`tool@1`); its own options come before the command. */
function npxFetches(command) {
  for (const m of command.matchAll(/\bnpx\s+([^|;&]*)/g)) {
    for (const word of m[1].trim().split(/\s+/)) {
      if (/^(?:-y|--yes|-p|--package)(?:=|$)/.test(word)) return true;
      if (word.startsWith("-")) continue;
      if (/^(?:@[\w.-]+\/)?[\w.-]+@\S+/.test(word)) return true;
      break;
    }
  }
  return false;
}

export function networkCommands(commands) {
  return commands.filter((c) => NETWORK.test(c) || npxFetches(c) || (REMOTE_URL.test(c) && FETCH_CALL.test(c)));
}

/**
 * Ledger rows that record a decision in the configured mode. Snout also writes rows it measures
 * but never judges (`tool-output`: a listing or a search's unattributed lines; `reversal`: a
 * decision the user overrode); those carry `mode: "observe"` whatever the config says, so they say
 * nothing about the mode Snout ran in.
 */
const UNJUDGED = new Set(["tool-output", "reversal"]);

/** The modes other than enforce that a `trim` or `memory` session's judged rows show. */
export function modeProblems(ledgerRows) {
  return [...new Set(ledgerRows.filter((r) => r.mode && !UNJUDGED.has(r.rule)).map((r) => r.mode).filter((m) => m !== "enforce"))];
}

/**
 * What is wrong with an arm's Snout config for the arm it is labeled: the memory arm must turn
 * automatic notes on by name (memoryNotes, off by default since 2026-10-27), or it runs trimming only
 * under the memory label; no other arm may have them on.
 */
export function armProblems(arm, config) {
  const notes = config?.memoryNotes === true && config?.memory !== false;
  if (arm === "memory" && !notes) return ["the memory arm has automatic notes off (memoryNotes is not true): it would run trimming only"];
  if (arm !== "memory" && config?.memoryNotes === true) return [`the ${arm} arm has automatic notes on`];
  // The search arm keeps memory (sessions are recorded, search answers) without automatic notes.
  if (arm === "search" && config?.memory !== true) return ["the search arm has memory off: there would be nothing to search"];
  // The session-start hint (memoryHint, on by default) tells an agent records exist. Only the search arm has
  // it; in another arm with memory on it would point at a search tool the agent was not given.
  if (arm === "search" && config?.memoryHint === false) return ["the search arm has the session-start hint off"];
  if (arm !== "search" && config?.memory === true && config?.memoryHint !== false) return [`the ${arm} arm has the session-start hint on`];
  return [];
}

/**
 * A session that hit a limit counts as attempted, not solved, even if its patch would pass. Its
 * patch is still graded, and kept as `gradedResolved`, so the record shows what the cut cost.
 */
export function scoreStep(step, graded) {
  const limited = step.timedOut || step.cut;
  return limited ? { ...graded, resolved: false, gradedResolved: graded.resolved, limitHit: step.timedOut ? "time" : "budget" } : graded;
}

/** Claude Code's own cost line against the transcript's: the step is flagged past 2%. */
export function costMismatch(transcriptUsd, cliUsd) {
  if (typeof cliUsd !== "number" || typeof transcriptUsd !== "number") return null;
  const base = Math.max(transcriptUsd, cliUsd);
  return base > 0 && Math.abs(transcriptUsd - cliUsd) / base > 0.02 ? { transcriptUsd, cliUsd } : null;
}

/** The tools Claude Code sends to Snout's PostToolUse hook (bench/memory-study.mjs `setArm`, the shipped hooks file). */
const POST_TOOL = /^(?:Read|NotebookRead|Bash|Grep|Glob|WebFetch|WebSearch|mcp__.*)$/;

/**
 * Did Snout's hooks see every call they should have? `toolUses` are the transcript's tool calls
 * ({id, name}; a call can appear in more than one transcript entry), `heartbeats` the session's
 * rows in Snout's hooks.jsonl, each written before its handler runs.
 */
export function hookCoverage(toolUses, heartbeats, { event = "post-tool", tools = POST_TOOL } = {}) {
  const ids = new Set(toolUses.filter((u) => tools.test(u.name)).map((u) => u.id));
  const seen = heartbeats.filter((h) => h.event === event).length;
  return { expected: ids.size, seen, missing: Math.max(0, ids.size - seen), started: heartbeats.some((h) => h.event === "session-start"), prompted: heartbeats.some((h) => h.event === "prompt-submit") };
}

/**
 * Codex: its PreToolUse hook fires once per shell command (PostToolUse also fires for file edits),
 * so each command the session ran is matched against a pre-tool heartbeat. Checked on two live
 * sessions 2026-10-24: 10 of 10 and 11 of 11.
 */
export const codexHookCoverage = (commands, heartbeats) =>
  hookCoverage(commands.map((c, i) => ({ id: i, name: "shell" })), heartbeats, { event: "pre-tool", tools: /^shell$/ });

/** Spend a run is answerable for: every finished session, plus any it started and lost. */
export function spentUsd(rows, interrupted = []) {
  return rows.reduce((a, r) => a + r.steps.reduce((x, s) => x + (s.costUsd ?? 0), 0), 0) + interrupted.reduce((a, s) => a + (s.costUsd ?? 0), 0);
}

/**
 * The Gate 4 pilot's go/no-go (bench/memory-pilot.json, docs/benchmark-protocol.md), per agent over
 * both repositories. No verdict when a chain is invalid, an arm is short of sessions, or the
 * session-start hint missed a search session that had earlier records (all but each chain's first).
 * Otherwise each comparison passes when the arm solves at least as many tasks as its base at a lower
 * cost per solved task: memory (search vs trim), the complete workflow (search vs plain), trimming
 * (trim vs plain). Ten tasks can show a large effect, not estimate one.
 */
export function pilotVerdict(rows, arms = ["plain", "trim", "search"], labels = null) {
  if (rows.some((r) => r.invalid)) return { valid: false, why: `invalid: ${rows.filter((r) => r.invalid).map((r) => r.invalid).join("; ")}` };
  const steps = (a) => rows.filter((r) => r.arm === a).flatMap((r) => r.steps);
  const counts = arms.map((a) => steps(a).length);
  if (!counts[0] || counts.some((n) => n !== counts[0])) return { valid: false, why: `incomplete: ${arms.map((a, i) => `${a} ${counts[i]}`).join(", ")} sessions` };
  const missed = rows.filter((r) => r.arm === "search").flatMap((r) => r.steps.slice(1).filter((s) => !s.hint).map((s) => s.task));
  if (missed.length) return { valid: false, why: `the session-start hint did not reach ${missed.join(", ")}` };
  const arm = (a) => {
    const st = steps(a), solved = st.filter((s) => s.resolved).length, cost = st.reduce((x, s) => x + (s.costUsd ?? 0), 0);
    const tokens = st.reduce((x, s) => x + (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0), 0);
    return { sessions: st.length, solved, costUsd: cost, perSolved: solved ? cost / solved : Infinity, tokens, tokensPerSolved: solved ? Math.round(tokens / solved) : Infinity };
  };
  const cmp = (base, a) => { const B = arm(base), A = arm(a); return { base: B, arm: A, pass: A.solved >= B.solved && A.perSolved < B.perSolved }; };
  // Reported, not gating: how the search arm used memory, and its wrong recalls.
  const st = steps("search");
  const use = { sessions: st.length, searched: st.filter((s) => s.memory?.searches).length, opened: st.filter((s) => s.memory?.opened?.length).length, actedOn: st.filter((s) => s.memory?.actedOn?.length).length, emptySearches: st.reduce((a, s) => a + (s.memory?.empty ?? 0), 0) };
  const verdict = { valid: true, memory: cmp("trim", "search"), workflow: cmp("plain", "search"), trimming: cmp("plain", "trim"), use, wrongRecalls: wrongRecalls(rows) };
  if (!labels) return verdict;
  // Reported, not gating: each search session's path through memory, the arms split by label, and what to work on next.
  const recordTask = (id) => rows.filter((r) => r.arm === "search").flatMap((r) => r.steps).find((s) => s.records?.includes(recordName(id)))?.task;
  const path = st.map((s) => memoryPath(s, labels[s.task], recordTask));
  return { ...verdict, path, byLabel: byLabel(rows, labels, arms), diagnosis: memoryDiagnosis(path, verdict.memory) };
}

/**
 * The arms of a repeat, interleaved by task (bench/memory-study.mjs): oldest task first, each task in
 * every arm before the next, the order rotating by task and repeat. Run arm after arm instead, the
 * second arm's first session would start on a prompt cache the first arm warmed, and on these tasks a
 * cache write is a real part of a session's cost.
 */
export const armOrder = (arms, rep, i) => { const k = (rep + i) % arms.length; return [...arms.slice(k), ...arms.slice(0, k)]; };

/**
 * What memory gave a session and whether the agent acted on it, from Snout's own log of the
 * session's memory calls (recall.jsonl "search" and "fetch" rows, written by `snout mcp`).
 * `touched` is every path and command the session used; `filesOf(id)` the files a session record
 * names. A record is acted on when the session then used a file it names: a proxy, reported as one.
 * Null when the session made no memory call.
 */
export function memoryUse(rows, touched, filesOf) {
  const calls = rows.filter((r) => r.kind === "search" || r.kind === "fetch");
  if (!calls.length) return null;
  const searches = calls.filter((r) => r.kind === "search");
  const fetched = calls.filter((r) => r.kind === "fetch" && !r.missed);
  const opened = [...new Set(fetched.flatMap((r) => r.shown ?? []))];
  const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  const used = touched.map(norm);
  const actedOn = opened.filter((id) => id.startsWith("session:") && filesOf(id).some((f) => used.some((u) => u.includes(norm(f)))));
  const shown = [...new Set(searches.flatMap((r) => r.shown ?? []))];
  return { searches: searches.length, empty: searches.filter((r) => !r.shown?.length).length, shown, opened, missed: calls.filter((r) => r.kind === "fetch" && r.missed).length, tokens: calls.reduce((a, r) => a + (r.tokensEst ?? 0), 0), actedOn };
}

/** The file a session record is kept in, under the chain's `memory` folder, for record id `session:<id>`. */
export const recordName = (id) => String(id).slice(8).replace(/[^\w.-]/g, "_").slice(0, 80);

/**
 * Wrong recalls, the pilot's frozen rule: a `search` session that opened a record, acted on it
 * (memoryUse), and failed a task `trim` solved in the same repeat. Each is listed by name.
 */
export function wrongRecalls(rows) {
  const solved = (arm, task, rep) => rows.some((r) => r.arm === arm && r.rep === rep && r.steps.some((s) => s.task === task && s.resolved));
  return rows.filter((r) => r.arm === "search").flatMap((r) => r.steps.filter((s) => s.memory?.actedOn?.length && !s.resolved && solved("trim", s.task, r.rep)).map((s) => ({ task: s.task, rep: r.rep, records: s.memory.actedOn })));
}

/**
 * The pilot's task labels, fixed before any session (bench/memory-pilot.json "labels"): a task is a
 * `candidate` when an earlier task in its chain changed files in a related folder, so that task's
 * record could help: the same folder, its parent, or a sibling under a folder other than the root.
 * Everything else is a `control`, the first task always (nothing is on record yet). Folders come from
 * the reference fixes, which no agent sees. `tasks` are in chain order, each `{ id, files }`.
 */
export function labelTasks(tasks) {
  const dirsOf = (files) => [...new Set(files.map((f) => f.split("/").slice(0, -1).join("/")).filter(Boolean))];
  const parent = (d) => d.split("/").slice(0, -1).join("/");
  const related = (a, b) => a === b || parent(a) === b || parent(b) === a || (parent(a) !== "" && parent(a) === parent(b));
  const out = {};
  tasks.forEach((t, i) => {
    const mine = dirsOf(t.files);
    const from = tasks.slice(0, i).filter((e) => dirsOf(e.files).some((d) => mine.some((m) => related(d, m)))).map((e) => e.id);
    out[t.id] = { label: from.length ? "candidate" : "control", from };
  });
  return out;
}

/** The pilot may start a task's group (one session per arm) only if it fits the cap at the costliest session so far, so groups finish whole. */
export const groupFits = (spent, maxSession, arms, cap) => !cap || spent + arms * maxSession <= cap;

/**
 * One search-arm session's path through memory: hint → search → a record from a labeled earlier task
 * shown, opened, acted on → result. `recordTask(id)` names the task whose session left record `id`.
 * `reached` is the furthest step. A control has no labeled record, so its path stops at the search;
 * the records it opened are still listed.
 */
export function memoryPath(step, label, recordTask) {
  const m = step.memory ?? {};
  const from = label?.from ?? [];
  const tasksOf = (ids) => [...new Set((ids ?? []).map(recordTask).filter(Boolean))];
  const useful = (ids) => tasksOf(ids).filter((t) => from.includes(t));
  const p = { task: step.task, label: label?.label ?? "unlabeled", from, hint: Boolean(step.hint), searched: (m.searches ?? 0) > 0, shown: useful(m.shown), opened: tasksOf(m.opened), openedUseful: useful(m.opened), actedOn: useful(m.actedOn), resolved: Boolean(step.resolved), costUsd: step.costUsd ?? 0, memoryTokens: m.tokens ?? 0 };
  p.reached = !p.hint ? "no hint" : !p.searched ? "hint, no search" : !p.shown.length ? "searched, no labeled record shown" : !p.openedUseful.length ? "labeled record shown, not opened" : !p.actedOn.length ? "labeled record opened, not acted on" : "acted on a labeled record";
  return p;
}

/**
 * What the pilot says to work on next, per agent (the owner's rules, fixed before the run): agents
 * never searched → discovery; searched but no labeled record helped → what memory captures, or the
 * tasks; used a record but search cost more per solved task than trim → retrieval overhead.
 */
export function memoryDiagnosis(paths, memory) {
  const hinted = paths.filter((p) => p.hint), candidates = paths.filter((p) => p.label === "candidate");
  if (!hinted.length) return "no session got the hint: nothing to diagnose";
  if (!hinted.some((p) => p.searched)) return "discovery: agents got the hint and never searched";
  if (!candidates.some((p) => p.actedOn.length)) return `capture or tasks: agents searched, but no candidate acted on a labeled record (${candidates.map((p) => `${p.task}: ${p.reached}`).join("; ") || "no candidates"})`;
  if (memory && memory.arm.perSolved >= memory.base.perSolved) return "overhead: agents used memory, and search cost more per solved task than trim";
  return "memory used, and search cost no more per solved task than trim";
}

/** Solved and cost per arm, split by label (reported, not gating). */
export function byLabel(rows, labels, arms = ["plain", "trim", "search"]) {
  const out = {};
  for (const label of ["candidate", "control"]) out[label] = Object.fromEntries(arms.map((a) => {
    const st = rows.filter((r) => r.arm === a).flatMap((r) => r.steps).filter((s) => labels[s.task]?.label === label);
    return [a, { sessions: st.length, solved: st.filter((s) => s.resolved).length, costUsd: st.reduce((x, s) => x + (s.costUsd ?? 0), 0) }];
  }));
  return out;
}
