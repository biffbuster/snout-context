/**
 * Shared A/B statistics for bench/long.mjs and bench/swe.mjs (docs/benchmark-protocol.md).
 *
 * Reliability, not just the mean: compression and trimming tend to turn always-solved tasks
 * into sometimes-solved ones before they make anything unsolvable (Min et al., 2026,
 * arXiv:2609.36526), so every summary reports Pass^k (solved in every run) next to the pass rate,
 * and an exact sign test on the tasks where the two arms disagree.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per task: did it pass in every run, and in any run. `ok(row)` says whether one run passed. */
export function reliability(rows, ok) {
  const byTask = new Map();
  for (const r of rows) byTask.set(r.task, [...(byTask.get(r.task) ?? []), ok(r)]);
  const tasks = [...byTask.entries()];
  return {
    tasks: tasks.length,
    passAll: tasks.filter(([, v]) => v.every(Boolean)).length,
    passAny: tasks.filter(([, v]) => v.some(Boolean)).length,
    allOf: new Map(tasks.map(([t, v]) => [t, v.every(Boolean)])),
  };
}

/** Exact two-sided sign test: wins and losses among discordant pairs, ties dropped. */
export function signTest(wins, losses) {
  const n = wins + losses;
  if (!n) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}
function choose(n, k) {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

/** Pass^k for both arms, and the sign test on tasks solved every run in one arm but not the other. */
export function reliabilityLines(off, on, ok) {
  const a = reliability(off, ok), b = reliability(on, ok);
  let wins = 0, losses = 0;
  for (const [t, offAll] of a.allOf) {
    const onAll = b.allOf.get(t);
    if (onAll === undefined || onAll === offAll) continue;
    if (onAll) wins++; else losses++;
  }
  return [
    `  solved every run off ${a.passAll}/${a.tasks} · enforce ${b.passAll}/${b.tasks}   (Pass^k; solved at least once: off ${a.passAny} · enforce ${b.passAny})`,
    `  sign test       enforce better on ${wins} task(s), worse on ${losses}; exact two-sided p = ${signTest(wins, losses).toFixed(3)}`,
  ];
}

/**
 * Largest context of any single model call in a session, from its transcript: the input,
 * cache-read and cache-write tokens of the call that carried the most. Null when the
 * transcript can't be found.
 */
export function peakContext(sessionId) {
  if (!sessionId) return null;
  const root = join(homedir(), ".claude/projects");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    let peak = 0, calls = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      try {
        const u = JSON.parse(line).message?.usage;
        if (!u) continue;
        calls++;
        peak = Math.max(peak, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
      } catch { /* a partial line */ }
    }
    return { peak, calls };
  }
  return null;
}

/**
 * Snout's side of a session from its ledger: what it kept out, and what that cost afterwards.
 * A follow-up is any later read of a file Snout trimmed or denied, the recovery a trim causes
 * (Min et al. call it interaction burden). Jev is Snout's own model spend, added to the arm's cost.
 */
export function ledgerFacts(ledgerFile) {
  const facts = { withheld: 0, byRule: {}, followUps: 0, followUpTokens: 0, jevUsd: 0 };
  if (!existsSync(ledgerFile)) return facts;
  const cut = new Set();
  for (const l of readFileSync(ledgerFile, "utf8").split("\n")) {
    if (!l.trim()) continue;
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    facts.jevUsd += ((d.jevInputTokens ?? 0) / 1e6) * 0.042;
    const isFile = d.path && !String(d.path).includes(": ");
    if (isFile && cut.has(d.path) && d.decision !== "deny") {
      facts.followUps++;
      facts.followUpTokens += d.tokensReadEst ?? 0;
    }
    const kept = d.trimmed || d.decision === "deny" ? d.tokensAvoidedEst || 0 : 0;
    if (!kept) continue;
    if (isFile) cut.add(d.path);
    facts.withheld += kept;
    facts.byRule[d.rule] = (facts.byRule[d.rule] ?? 0) + kept;
  }
  return facts;
}

/** Peak-context and follow-up lines, for arms whose rows carry `peak`, `followUps` and `followUpTokens`. */
export function costLines(off, on, sum) {
  const mean = (rs, k) => { const v = rs.map((r) => r[k]).filter((x) => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const lines = [];
  const po = mean(off, "peak"), pn = mean(on, "peak");
  if (po && pn) lines.push(`  peak context    ${Math.round(po / 1000)}k → ${Math.round(pn / 1000)}k tokens (mean of each session's largest call)`);
  if (on.some((r) => typeof r.followUps === "number")) lines.push(`  follow-ups      ${sum(on, "followUps")} later read(s) of trimmed files, ~${Math.round(sum(on, "followUpTokens") / 1000)}k tokens (recovery cost, already inside the totals)`);
  const jev = sum(on, "jevUsd");
  if (jev) lines.push(`  Snout's own model spend $${jev.toFixed(4)} (Jev), included in cost`);
  return lines;
}

/**
 * What the repo map offered in a session and whether the agent used it: suggestions made, their
 * tokens, and the share of suggested files the agent then opened (from Snout's ledger).
 */
export function mapFacts(snoutDir) {
  const file = join(snoutDir, "map-suggestions.jsonl");
  if (!existsSync(file)) return { suggestions: 0, suggestedTokens: 0, suggested: 0, opened: 0 };
  const offered = new Set();
  let suggestions = 0, suggestedTokens = 0;
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { const d = JSON.parse(l); suggestions++; suggestedTokens += d.tokensEst ?? 0; for (const p of d.paths ?? []) offered.add(p); } catch { /* partial line */ }
  }
  const read = new Set();
  const ledger = join(snoutDir, "ledger.jsonl");
  if (existsSync(ledger)) for (const l of readFileSync(ledger, "utf8").split("\n")) {
    try { const d = JSON.parse(l); if (d.path) read.add(d.path); } catch { /* skip */ }
  }
  return { suggestions, suggestedTokens, suggested: offered.size, opened: [...offered].filter((p) => read.has(p)).length };
}

