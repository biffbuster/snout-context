#!/usr/bin/env node
/**
 * The handoff benchmark's result (spec-benchmark.json, spec-benchmark-codex.json), scored as its spec says: the
 * stage files merged, every handoff and arm, controls apart, cost per success, and sign tests on handoffs where
 * two arms differ. Files of both receiving agents may be given together: each agent is scored on its own, then
 * side by side.
 *
 *   node bench/benchmark-report.mjs bench/handoff/results-2026-11-13-benchmark.json bench/handoff/results-2026-11-13-benchmark-2.json
 *   node bench/benchmark-report.mjs bench/handoff/results-2026-11-13-benchmark*.json bench/handoff/results-2026-11-14-benchmark-codex.json
 */
import { readFileSync } from "node:fs";

// The results don't carry which directions are controls; the spec does (the Codex spec keeps the same ids).
const SPEC = JSON.parse(readFileSync(new URL("handoff/spec-benchmark.json", import.meta.url), "utf8"));
const isControl = new Set(SPEC.directions.filter((d) => d.control).map((d) => d.id));
const ARMS = ["leftoff", "trim", "off"];
// Claude Code: the higher of its transcript price and its own. Codex: list price, billed to the ChatGPT plan.
const cost = (s) => Math.max(s?.costUsd ?? 0, s?.cliCostUsd ?? 0);
const keysOf = (d, arm) => Object.keys(d.receivers).filter((k) => k.replace(/-\d+$/, "") === arm);
const agentOf = (f) => f.directions.find((d) => d.receiverAgent)?.receiverAgent ?? "claude";
const NAME = { claude: "Claude Code", codex: "Codex" };

const binomTwoSided = (k, n) => {
  if (!n) return 1;
  const c = (n, r) => { let x = 1; for (let i = 1; i <= r; i++) x = (x * (n - r + i)) / i; return x; };
  const lo = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= lo; i++) p += c(n, i);
  return Math.min(1, (2 * p) / 2 ** n);
};

/** One receiving agent's stage files, merged and scored; returns the per-arm summary for the side-by-side table. */
function report(files, agent) {
  const byId = new Map();
  for (const f of files) for (const d of f.directions) {
    const had = byId.get(d.id);
    if (!had) byId.set(d.id, { ...d, receivers: { ...(d.receivers ?? {}) } });
    else for (const [k, r] of Object.entries(d.receivers ?? {})) {
      if (had.receivers[k]) throw new Error(`${d.id} ${k} ran in two files`);
      had.receivers[k] = r;
    }
  }
  const dirs = [...byId.values()].map((d) => ({ ...d, control: isControl.has(d.id) }));
  const handoffs = dirs.filter((d) => !d.control), controls = dirs.filter((d) => d.control);
  const invalid = dirs.flatMap((d) => [d.giver, ...Object.values(d.receivers)].filter((s) => s?.invalid?.length).map((s) => `${d.id} ${s.arm ?? s.role}: ${s.invalid[0]}`));
  const stopped = dirs.filter((d) => d.stopped).map((d) => `${d.id}: ${d.stopped}`);
  const counted = handoffs.filter((d) => !d.stopped);
  const claude = agent === "claude";
  const version = claude ? files[0].versions?.claude ?? "" : files[0].versions?.codex ?? "";

  console.log(`Handoff benchmark, ${NAME[agent]} receivers · ${handoffs.length} handoffs, ${controls.length} controls · ${files.map((f) => f.measuredAt?.slice(0, 10)).join(", ")} · ${version}`);
  console.log(`Invalid sessions: ${invalid.length ? invalid.join("; ") : "none"} · stopped directions: ${stopped.length ? stopped.join("; ") : "none"}\n`);

  console.log("Handoffs (step 2 done with both decisions; per repeat)");
  // Claude Code's own memory reaches only Claude Code receivers.
  console.log(`  ${"handoff".padEnd(22)}${ARMS.map((a) => a.padEnd(12)).join("")}${claude ? "own memory had the decision" : ""}`);
  for (const d of counted) {
    const cell = (arm) => keysOf(d, arm).map((k) => { const r = d.receivers[k]; return r.solved ? "Y" : r.taskPassed ? "t" : "n"; }).join(" ");
    console.log(`  ${d.id.replace("bench-", "").padEnd(22)}${ARMS.map((a) => cell(a).padEnd(12)).join("")}${claude ? (d.giverMemory?.decision ? "yes" : "no") : ""}`);
  }
  console.log("  (Y solved · t step 2 done, a decision missed · n step 2 not done)\n");

  const sessions = (arm) => counted.flatMap((d) => keysOf(d, arm).map((k) => d.receivers[k]));
  const givers = counted.reduce((a, d) => a + (d.giver?.reused ? 0 : cost(d.giver)), 0);
  // Givers reused from another run (the Codex spec reuses the Claude Code givers) were paid there.
  const reused = counted.length > 0 && counted.every((d) => d.giver?.reused?.from && !files.some((f) => f.runId === d.giver.reused.runId));
  const summary = {};
  for (const arm of ARMS) {
    const s = sessions(arm);
    const solved = s.filter((r) => r.solved).length, task = s.filter((r) => r.taskPassed).length, dec = s.filter((r) => r.decisionHonored).length;
    const recv = s.reduce((a, r) => a + cost(r), 0);
    const edit = s.map((r) => r.beforeFirstEdit?.tokens).filter(Number.isFinite).sort((a, b) => a - b);
    const tokens = s.map((r) => r.tokens?.total).filter(Number.isFinite).sort((a, b) => a - b);
    const mid = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)].toLocaleString("en-US") : "n/a");
    summary[arm] = { solved, n: s.length, recv, perSuccess: solved ? (givers + recv) / solved : null, tokens: mid(tokens) };
    if (!s.length) continue;
    console.log(`${arm.padEnd(8)} solved ${solved}/${s.length} · step 2 done ${task}/${s.length} · decisions honored ${dec}/${s.length} · receivers $${recv.toFixed(2)}${claude ? "" : " (plan, list price)"} · cost per success ${solved ? `$${summary[arm].perSuccess.toFixed(3)}` : "n/a"} (givers $${givers.toFixed(2)}${reused ? ", reused: paid in the Claude Code run" : " shared"}) · median tokens ${mid(tokens)}${claude ? ` · before first edit ${mid(edit)}` : ""}`);
  }

  // Sign test on handoffs: each handoff's repeats per arm summed; a handoff counts where the arms differ.
  const pair = (a, b) => {
    let win = 0, loss = 0;
    for (const d of counted) {
      const n = (arm) => keysOf(d, arm).filter((k) => d.receivers[k].solved).length;
      if (n(a) > n(b)) win++; else if (n(a) < n(b)) loss++;
    }
    return `${a} vs ${b}: ${a} ahead in ${win} handoff(s), behind in ${loss}, tied in ${counted.length - win - loss} · sign test p = ${binomTwoSided(win, win + loss).toPrecision(2)}`;
  };
  const ran = ARMS.filter((a) => sessions(a).length);
  console.log("");
  for (const [a, b] of [["leftoff", "off"], ["leftoff", "trim"], ["trim", "off"]]) if (ran.includes(a) && ran.includes(b)) console.log(pair(a, b));

  console.log("\nControls (asked change done · step 2 left alone; per repeat)");
  if (!controls.length) console.log("  none in these files");
  for (const d of controls) {
    const cell = (arm) => keysOf(d, arm).map((k) => { const r = d.receivers[k]; return `${r.askedDone ? "done" : "NOT done"}/${r.inScope ? "alone" : "STARTED"}`; }).join(" ");
    console.log(`  ${d.id.replace("control-", "").padEnd(14)}${d.stopped ? `stopped: ${d.stopped}` : ARMS.filter((a) => keysOf(d, a).length).map((a) => `${a} ${cell(a)}`).join(" · ")}`);
  }

  if (claude) {
    const own = handoffs.filter((d) => d.giverMemory);
    console.log(`\nClaude Code's own memory after the giver: files in ${own.filter((d) => d.giverMemory.files.length).length}/${own.length}, the decision in ${own.filter((d) => d.giverMemory.decision).length}/${own.length}`);
  }
  const api = files.reduce((a, f) => a + (f.spend?.claudeUsd ?? 0), 0), plan = files.reduce((a, f) => a + (f.spend?.codexUsd ?? 0), 0);
  console.log(`Spend: $${api.toFixed(2)} API${plan ? ` · $${plan.toFixed(2)} Codex list price (ChatGPT plan)` : ""} · ${dirs.filter((d) => d.giver && !d.giver.reused).length} givers run, ${dirs.reduce((a, d) => a + Object.keys(d.receivers).length, 0)} receivers\n`);
  return summary;
}

const all = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")));
const agents = [...new Set(all.map(agentOf))];
const summaries = Object.fromEntries(agents.map((a) => [a, report(all.filter((f) => agentOf(f) === a), a)]));
if (agents.length > 1) {
  console.log("Side by side (handoffs solved per arm · receivers' cost · median tokens per receiver)");
  for (const arm of ARMS) console.log(`  ${arm.padEnd(8)}${agents.map((a) => { const s = summaries[a][arm]; return `${NAME[a]} ${s.n ? `${s.solved}/${s.n} · $${s.recv.toFixed(2)} · ${s.tokens}` : "not run"}`.padEnd(44); }).join("")}`);
}
