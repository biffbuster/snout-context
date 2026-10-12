/**
 * Latency benchmark, in two layers, because they fail for different reasons and have
 * different fixes.
 *
 *   LAYER 1 — classification, measured in-process. This is what `src/gate/` costs. If it
 *   regresses, the fix is in our code. Budget: 1 ms p95.
 *
 *   LAYER 2 — the whole hook process, measured by spawning it the way Claude Code does.
 *   Dominated by Node start-up, which no work inside src/ can remove, so it is gated on
 *   the *difference* from a floor measured the same way rather than on the total.
 *
 *   Layer 2 only applies to the OPT-IN blocking hook. The shipped default installs no
 *   PreToolUse hook at all: recording runs through PostToolUse with `async: true`, which
 *   does not block the agent, so observe mode pays none of this. The real fix for the
 *   blocking path is an http-hook sidecar.
 *
 * Two earlier versions of this file measured the wrong thing, in the same direction both
 * times — blaming the environment on the classifier:
 *
 *   - Reporting `total - node floor` as "our own work". That difference is mostly ESM
 *     parse and module init of the bundle, not classification, and it made a 0.065 ms
 *     classifier look like an 18 ms one.
 *   - Gating the shell-wrapped total against a 600 ms absolute ceiling while measuring the
 *     floor without the shell. Starting a Node process costs ~120 ms spawned directly and
 *     ~355 ms through `sh -c` on the same machine, so the gate charged a 235 ms property
 *     of the OS to this plugin and failed a build over it. The numbers move with the
 *     machine; what we control is the delta, so that is what is gated.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tier0, DEFAULTS } from "../dist/lib.mjs";

const N = Number(process.env.BENCH_N || 40);
const ITERS = Number(process.env.BENCH_ITERS || 5000);

/**
 * What the plugin may add to a hook process, over a Node process that does nothing.
 *
 * This replaced a 600 ms ceiling on the total, which failed on any machine slower than the
 * one it was calibrated on and would have passed a genuine regression on a faster one.
 * Measured overhead is ~10-30 ms (bundle parse, config load, classification); the budget
 * leaves room for CI noise while still catching anything that doubles it.
 */
const OVERHEAD_MS = 75;

const root = mkdtempSync(join(tmpdir(), "snout-bench-"));
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src/app.ts"), "export const a = 1;\n".repeat(400));
writeFileSync(join(root, "src/gen.ts"), "// @generated\n" + "x\n".repeat(5000));
writeFileSync(join(root, "package-lock.json"), JSON.stringify({ d: "x".repeat(200_000) }));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

// ---------------------------------------------------------- layer 1: classification

function micro(label, rel) {
  const absPath = join(root, rel);
  const cfg = DEFAULTS;
  for (let i = 0; i < 2000; i++) tier0({ absPath, projectDir: root, cfg }); // warm the JIT
  const times = [];
  for (let i = 0; i < ITERS; i++) {
    const t = process.hrtime.bigint();
    tier0({ absPath, projectDir: root, cfg });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { label, p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99) };
}

const layer1 = [
  micro("lockfile   (name match, no read)", "package-lock.json"),
  micro("source     (2 KB head read, falls through)", "src/app.ts"),
  micro("generated  (2 KB head read, marker hit)", "src/gen.ts"),
];

// ---------------------------------------------------------- layer 2: the hook process

function payload(rel) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "bench",
    cwd: root,
    tool_name: "Read",
    tool_use_id: "toolu_bench",
    tool_input: { file_path: join(root, rel) },
  });
}

function spawned(label, argv, rel, env = {}) {
  const times = [];
  let out = "";
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(argv[0], argv.slice(1), {
      input: payload(rel),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    // A hook that failed to load would otherwise benchmark as if it were fast.
    if (r.status !== 0) throw new Error(`${label} exited ${r.status}: ${r.stderr}`);
    out = r.stdout ?? "";
  }
  times.sort((a, b) => a - b);
  return { label, p50: pct(times, 50), p95: pct(times, 95), max: times.at(-1), out };
}

/**
 * Two forms sampled round-robin, so both see the same machine conditions. Returns them in
 * the order given, each shaped like a `spawned()` result.
 */
function paired(a, b) {
  const times = { a: [], b: [] };
  let outA = "";
  for (let i = 0; i < N; i++) {
    for (const [key, spec] of [["a", a], ["b", b]]) {
      const t = process.hrtime.bigint();
      const r = spawnSync(spec.argv[0], spec.argv.slice(1), {
        input: payload(spec.rel),
        encoding: "utf8",
        env: { ...process.env, ...spec.env },
      });
      times[key].push(Number(process.hrtime.bigint() - t) / 1e6);
      if (r.status !== 0) throw new Error(`${spec.label} exited ${r.status}: ${r.stderr}`);
      if (key === "a") outA = r.stdout ?? "";
    }
  }
  return [a, b].map((spec, i) => {
    const t = times[i === 0 ? "a" : "b"].sort((x, y) => x - y);
    return { label: spec.label, p50: pct(t, 50), p95: pct(t, 95), max: t.at(-1), out: i === 0 ? outA : "" };
  });
}

const enforce = { SNOUT_MODE: "enforce" };
const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

// Each form is paired with a floor measured the *same* way, because the cost of starting a
// process is a property of the environment, not of this code. Measured here: bare `node -e
// 0` costs ~120 ms spawned directly from Node and ~355 ms when the same command goes
// through `sh -c` — a 3x swing that has nothing to do with the classifier, and which an
// absolute ceiling silently charges to us. The floors make the comparison honest.
// Interleaved, one sample each per round: a background process that lands halfway through
// the run must not inflate the plugin's number while leaving the floor's untouched. An
// earlier version sampled them separately and charged that difference to the classifier.
const [shipped, shellFloor] = paired(
  { label: "shipped form (shell)", argv: ["sh", "-c", `node "${CLI}" pre-tool`], rel: "package-lock.json", env: enforce },
  { label: "  floor: bare node via shell", argv: ["sh", "-c", "node -e 0"], rel: "src/app.ts", env: {} },
);
const layer2 = [
  spawned("allow path  (exec)", ["node", CLI, "pre-tool"], "src/app.ts", enforce),
  spawned("deny path   (exec)", ["node", CLI, "pre-tool"], "package-lock.json", enforce),
  shipped,
];
const floor = spawned("  floor: bare node, exec", ["node", "-e", "0"], "src/app.ts");

// ---------------------------------------------------------- report

console.log(`\n${process.version} on ${process.platform}\n`);
console.log(`LAYER 1 — classification, in-process, n=${ITERS}. Budget: 1 ms p95.\n`);
for (const r of layer1) {
  console.log(`  ${r.label.padEnd(44)} p50 ${r.p50.toFixed(3).padStart(7)}   p95 ${r.p95.toFixed(3).padStart(7)}   p99 ${r.p99.toFixed(3).padStart(7)} ms`);
}
// Median, not p95: the tail of a spawn measurement is the OS scheduler, not our code, and
// a budget set on it measures how busy the machine was rather than what the plugin costs.
const overhead = shipped.p50 - shellFloor.p50;

console.log(`\nLAYER 2 — whole hook process, spawned, n=${N}. OPT-IN path only.`);
console.log(`Gate: our own overhead over an identically spawned floor, ${OVERHEAD_MS} ms median.\n`);
for (const r of [...layer2, shellFloor, floor]) {
  console.log(`  ${r.label.padEnd(44)} p50 ${r.p50.toFixed(1).padStart(7)}   p95 ${r.p95.toFixed(1).padStart(7)}   max ${r.max.toFixed(1).padStart(7)} ms`);
}
console.log(`\n  Of the shipped form's ${shipped.p50.toFixed(0)} ms, ${shellFloor.p50.toFixed(0)} ms is starting a Node process that`);
console.log(`  does nothing at all, ${(shipped.p50 - shellFloor.p50).toFixed(0)} ms is this plugin, and ${layer1[0].p50.toFixed(3)} ms of that is`);
console.log(`  classification. Optimising the classifier further would be optimising`);
console.log(`  ${((layer1[0].p50 / shipped.p50) * 100).toFixed(2)}% of the cost.\n`);
console.log(`  deny response: ${shipped.out.slice(0, 120)}…\n`);

const CLASSIFY_MS = 1;
let failed = false;
for (const r of layer1) {
  if (r.p95 > CLASSIFY_MS) {
    console.error(`FAIL: ${r.label} p95 ${r.p95.toFixed(3)} ms exceeds the ${CLASSIFY_MS} ms classification budget`);
    failed = true;
  }
}
if (overhead > OVERHEAD_MS) {
  console.error(`FAIL: the plugin adds ${overhead.toFixed(1)} ms over a bare Node process, above the ${OVERHEAD_MS} ms budget`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`  PASS: classification within ${CLASSIFY_MS} ms p95; plugin overhead ${overhead.toFixed(1)} ms median, within ${OVERHEAD_MS} ms.\n`);
