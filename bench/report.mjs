#!/usr/bin/env node
/**
 * Publication report for an A/B results file: every attempt as CSV, the paired comparison with
 * its pre-registered rules, and a chart of cost per attempt against solved attempts. Reads only
 * saved results, so anyone can rebuild a published number without a key or a paid call.
 *
 *   node bench/report.mjs bench/ab-results/run-1790779257454.json --margin 5 --out docs/results/<name>
 *
 * Options:
 *   --base ARM      the arm the others are compared with (default: "off", else the first arm)
 *   --margin PTS    the no-quality-loss margin fixed in docs/benchmark-protocol.md before the run.
 *                   Required: a margin chosen after seeing the result is not a test.
 *   --out DIR       write attempts.csv, summary.json and chart.svg there (default: print only)
 *   --tasks A,B     only these tasks (a published subset, such as the bulk-path tasks)
 *   --metric KEY    what "cost" is: costUsd (default), effTokens, or apiEquivalentUsd from
 *                   bench/price-codex.mjs (an API-list-price estimate, not an actual bill)
 *
 * Accepts the row-per-attempt files of bench/swe.mjs, bench/ab.mjs and bench/long.mjs, and the
 * row-per-session files of bench/swelong.mjs (one attempt per issue in the session). Rows marked
 * `infra`, and rows with an `error` (the agent never ran: a usage limit, a crash before the first
 * turn), are excluded from every number and counted, never dropped silently.
 *
 * Statistics: tasks are the unit. A bootstrap resamples tasks with replacement (seeded, so a
 * rebuild prints the same interval); within a task, all of its attempts in each arm count.
 *   solved difference   arm minus base, in points; "no quality loss" if the lower bound
 *                       is above −margin. When all paired tasks pass in both arms, a
 *                       one-sided exact zero-harm bound prevents a degenerate [0, 0] bootstrap.
 *   cost per solved     total cost / total solved, arm vs base; "saving" if the interval's upper
 *                       end is below zero
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const B = 4000;
const SEED = 20261013;

/** One attempt per row: a task, an arm, solved or not, and what it cost. */
export function attempts(saved, source = "", metric = "costUsd") {
  const out = [];
  const reps = new Map();
  for (const r of saved.rows ?? []) {
    if (Array.isArray(r.tasks)) {
      // A long session: each issue it worked on is an attempt at that issue.
      r.tasks.forEach((t, i) => out.push({
        source, task: String(t.task), arm: String(r.arm), rep: r.rep ?? 0, session: `${r.chain ?? ""}#${r.rep ?? 0}`,
        solved: t.resolved ?? null, costUsd: r.perIssueUsd?.[i] ?? null, inputTokens: null, outputTokens: null, turns: null, excluded: !!r.infra,
      }));
      continue;
    }
    const key = `${r.task}\u0000${r.arm}`;
    const rep = r.rep ?? (reps.get(key) ?? 0);
    reps.set(key, rep + 1);
    out.push({
      source, task: String(r.task), arm: String(r.arm), rep, session: "",
      solved: r.resolved ?? r.pass ?? null, costUsd: r[metric] ?? null, inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null, turns: r.turns ?? null, excluded: !!(r.infra || r.error),
    });
  }
  return out;
}

function rng(seed) {
  let x = seed % 2147483647 || 1;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/** The paired comparison of one arm with the base, over tasks both arms attempted. */
export function compare(all, base, arm, margin) {
  const rows = all.filter((a) => !a.excluded && a.solved !== null);
  const byTask = new Map();
  for (const a of rows) {
    if (a.arm !== base && a.arm !== arm) continue;
    const t = byTask.get(a.task) ?? { base: [], arm: [] };
    t[a.arm === base ? "base" : "arm"].push(a);
    byTask.set(a.task, t);
  }
  const tasks = [...byTask.values()].filter((t) => t.base.length && t.arm.length);
  if (!tasks.length) return null;
  const totals = (ts) => {
    const s = { base: { n: 0, solved: 0, cost: 0, costN: 0 }, arm: { n: 0, solved: 0, cost: 0, costN: 0 } };
    for (const t of ts) for (const side of ["base", "arm"]) for (const a of t[side]) {
      s[side].n++;
      if (a.solved) s[side].solved++;
      if (a.costUsd !== null) { s[side].cost += a.costUsd; s[side].costN++; }
    }
    return s;
  };
  // Tasks weigh equally in the solved difference, whatever their number of attempts.
  const solvedDiff = (ts) => ts.reduce((d, t) => d + mean(t.arm.map((a) => +a.solved)) - mean(t.base.map((a) => +a.solved)), 0) / ts.length;
  const cps = (s) => (s.solved && s.costN === s.n ? s.cost / s.solved : null);
  const cpsChange = (ts) => {
    const s = totals(ts);
    const b = cps(s.base), a = cps(s.arm);
    return b && a ? a / b - 1 : null;
  };
  const rand = rng(SEED);
  const diffs = [], changes = [];
  for (let k = 0; k < B; k++) {
    const sample = tasks.map(() => tasks[Math.floor(rand() * tasks.length)]);
    diffs.push(solvedDiff(sample));
    const c = cpsChange(sample);
    if (c !== null) changes.push(c);
  }
  diffs.sort((x, y) => x - y);
  changes.sort((x, y) => x - y);
  const s = totals(tasks);
  const change = cpsChange(tasks);
  const diff = solvedDiff(tasks);
  const diffCi = [quantile(diffs, 0.025) * 100, quantile(diffs, 0.975) * 100];
  // With zero observed harmed tasks, resampling those same tasks always returns zero. Bound
  // the unseen per-task harm rate using unique tasks, not repeated attempts on those tasks.
  // P(zero harms | harm rate p) = (1-p)^n; solve at 0.05 for a one-sided 95% bound.
  const allPass = tasks.every((t) => [...t.base, ...t.arm].every((a) => a.solved));
  if (allPass) diffCi[0] = Math.min(diffCi[0], (Math.pow(0.05, 1 / tasks.length) - 1) * 100);
  const costCi = changes.length === B ? [quantile(changes, 0.025) * 100, quantile(changes, 0.975) * 100] : null;
  return {
    base, arm, tasks: tasks.length,
    attempts: { [base]: s.base.n, [arm]: s.arm.n },
    solved: { [base]: s.base.solved, [arm]: s.arm.solved },
    meanCostPerAttempt: { [base]: s.base.costN ? s.base.cost / s.base.costN : null, [arm]: s.arm.costN ? s.arm.cost / s.arm.costN : null },
    costPerSolved: { [base]: cps(s.base), [arm]: cps(s.arm) },
    solvedDiffPts: diff * 100,
    solvedDiffCi: diffCi,
    qualityLowerBoundMethod: allPass ? "one-sided exact zero-harm bound by unique task" : "paired task bootstrap",
    costPerSolvedChangePct: change === null ? null : change * 100,
    costPerSolvedCi: costCi,
    marginPts: margin,
    noQualityLoss: diffCi[0] > -margin,
    saving: costCi ? costCi[1] < 0 : false,
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function toCsv(rows) {
  const cols = ["source", "task", "arm", "rep", "session", "solved", "costUsd", "inputTokens", "outputTokens", "turns", "excluded"];
  const cell = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** Cost per attempt (x) against solved attempts (y), one point per arm. Plain SVG, no dependencies. */
export function chartSvg(points, title, metric = "costUsd") {
  const money = metric === "costUsd" || metric === "apiEquivalentUsd";
  const fmt = (v) => (money ? `$${v.toFixed(4)}` : `${Math.round(v / 1000)}k`);
  const W = 640, H = 400, L = 72, R = 24, T = 48, Bm = 56;
  const xs = points.map((p) => p.cost), ys = points.map((p) => p.solvedPct);
  // Both axes start at zero, so the picture can't make a small difference look large.
  const xMax = Math.max(...xs) * 1.15 || 1, xMin = 0;
  const yMin = 0, yMax = 100;
  const x = (v) => L + ((v - xMin) / (xMax - xMin || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - T - Bm);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="12">
<style>.fg{fill:#1f2328}.mu{fill:#59636e}.ax{stroke:#d1d9e0}.pt{fill:#0969da}.bs{fill:#59636e}@media (prefers-color-scheme:dark){.fg{fill:#e6edf3}.mu{fill:#9198a1}.ax{stroke:#3d444d}.pt{fill:#4493f8}.bs{fill:#9198a1}}</style>
<text class="fg" x="${L}" y="24" font-size="14" font-weight="600">${esc(title)}</text>
${ticks.map((t) => { const v = yMin + t * (yMax - yMin); return `<line class="ax" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="mu" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(0)}%</text>`; }).join("\n")}
${ticks.map((t) => { const v = xMin + t * (xMax - xMin); return `<text class="mu" x="${x(v)}" y="${H - Bm + 18}" text-anchor="middle">${fmt(v)}</text>`; }).join("\n")}
<text class="mu" x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle">${metric === "apiEquivalentUsd" ? "Mean API-equivalent cost" : money ? "Mean API cost" : `Mean ${esc(metric)}`} per attempt (lower is better)</text>
<text class="mu" transform="translate(16 ${(T + H - Bm) / 2}) rotate(-90)" text-anchor="middle">Solved attempts</text>
${points.map((p) => `<circle class="${p.base ? "bs" : "pt"}" cx="${x(p.cost)}" cy="${y(p.solvedPct)}" r="6"/><text class="fg" x="${x(p.cost) + 10}" y="${y(p.solvedPct) + (p.solvedPct > 90 ? 20 : -8)}">${esc(p.label)} · ${p.solved}/${p.n}</text>`).join("\n")}
</svg>
`;
}

function report(files, { base, margin, out, tasks, metric = "costUsd" }) {
  const only = tasks ? new Set(tasks.split(",")) : null;
  const all = files.flatMap((f) => attempts(JSON.parse(readFileSync(f, "utf8")), basename(f), metric)).filter((a) => !only || only.has(a.task));
  const arms = [...new Set(all.map((a) => a.arm))];
  const baseArm = base ?? (arms.includes("off") ? "off" : arms[0]);
  const comparisons = arms.filter((a) => a !== baseArm).map((a) => compare(all, baseArm, a, margin)).filter(Boolean);
  const excluded = all.filter((a) => a.excluded);
  const unscored = all.filter((a) => !a.excluded && a.solved === null);
  const pct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
  const amount = (v) => (metric === "costUsd" ? `$${v.toFixed(4)}` : metric === "apiEquivalentUsd" ? `$${v.toFixed(4)} API-equivalent` : `${Math.round(v).toLocaleString("en-US")} ${metric}`);
  console.log(`\n${files.map((f) => basename(f)).join(", ")}: ${all.length} attempts, ${arms.length} arms, base ${baseArm}, margin ${margin} pts${only ? `, tasks ${[...only].join(",")}` : ""}${metric !== "costUsd" ? `, cost = ${metric}` : ""}\n`);
  for (const c of comparisons) {
    console.log(`  ${c.arm} vs ${c.base} (${c.tasks} tasks)`);
    const qualityInterval = c.qualityLowerBoundMethod === "paired task bootstrap"
      ? `95% CI ${pct(c.solvedDiffCi[0])} to ${pct(c.solvedDiffCi[1])}`
      : `one-sided 95% lower bound ${pct(c.solvedDiffCi[0])} pts; bootstrap upper ${pct(c.solvedDiffCi[1])} pts`;
    console.log(`    solved          ${c.solved[c.base]}/${c.attempts[c.base]} → ${c.solved[c.arm]}/${c.attempts[c.arm]}   difference ${pct(c.solvedDiffPts)} pts (${qualityInterval}) → no quality loss ${c.noQualityLoss ? "MET" : "NOT MET"}`);
    if (c.costPerSolvedChangePct !== null) console.log(`    cost per solved ${amount(c.costPerSolved[c.base])} → ${amount(c.costPerSolved[c.arm])}   ${pct(c.costPerSolvedChangePct)}%${c.costPerSolvedCi ? ` (95% CI ${pct(c.costPerSolvedCi[0])}% to ${pct(c.costPerSolvedCi[1])}%)` : ""} → saving ${c.saving ? "MET" : "NOT MET"}`);
  }
  if (excluded.length) console.log(`  excluded (infrastructure): ${excluded.length} attempts`);
  if (unscored.length) console.log(`  not graded: ${unscored.length} attempts`);
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "attempts.csv"), toCsv(all));
  const summary = { files: files.map((f) => basename(f)), base: baseArm, marginPts: margin, tasks: only ? [...only] : "all", metric, bootstrap: { resamples: B, seed: SEED, unit: "task" }, comparisons, excluded: excluded.length, unscored: unscored.length };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const points = arms.map((a) => {
    const rs = all.filter((r) => r.arm === a && !r.excluded && r.solved !== null && r.costUsd !== null);
    return { label: a, base: a === baseArm, n: rs.length, solved: rs.filter((r) => r.solved).length, solvedPct: (100 * rs.filter((r) => r.solved).length) / Math.max(1, rs.length), cost: rs.reduce((s, r) => s + r.costUsd, 0) / Math.max(1, rs.length) };
  }).filter((p) => p.n);
  if (points.length) writeFileSync(join(out, "chart.svg"), chartSvg(points, `Solved attempts vs. cost · ${summary.files.join(", ")}`, metric));
  console.log(`\n  wrote ${join(out, "attempts.csv")}, summary.json${points.length ? ", chart.svg" : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const files = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--margin") opts.margin = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--tasks") opts.tasks = argv[++i];
    else if (a === "--metric") opts.metric = argv[++i];
    else files.push(a);
  }
  if (!files.length || !(opts.margin > 0)) {
    console.error("usage: node bench/report.mjs <results.json>... --margin <pts fixed before the run> [--base ARM] [--tasks A,B] [--metric costUsd|effTokens|apiEquivalentUsd] [--out DIR]");
    process.exit(2);
  }
  report(files, opts);
}
