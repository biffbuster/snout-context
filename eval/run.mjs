/**
 * The eval runner. `npm run eval`
 *
 * Prints overall accuracy, a calibration table binned identically, the "unsure"
 * subset, macro P/R/F1, ms/item, and $/1k. Plus the two the benchmark does not need and we
 * cannot ship without: false-deny rate and token reduction.
 *
 * Everything runs locally against the deterministic tier. There is no API key and no
 * network call, which is also why the cost column is zero and the calibration table is
 * degenerate — both stated plainly rather than dressed up.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tier0, DEFAULTS, estimateTokens, PINNED_MODEL } from "../dist/lib.mjs";
import { repos, cases, CLASSES, assertClassesCoverGold } from "./dataset.mjs";
import { writeRepo, cleanup } from "./fixtures.mjs";
import * as M from "./metrics.mjs";

const jsonOut = process.argv.includes("--json");
const REPEATS = Number(process.env.EVAL_REPEATS || 3);

function buildRepos() {
  const roots = {};
  for (const [name, repo] of Object.entries(repos)) {
    roots[name] = writeRepo(mkdtempSync(join(tmpdir(), `snout-eval-${name}-`)), repo.files);
  }
  return roots;
}

/**
 * Runs the classifier over every case. `REPEATS` passes, reporting the median per-item
 * time: a single pass on a laptop is mostly filesystem noise.
 */
function runAll(roots) {
  const all = cases();
  const perItemMs = [];
  let results = [];

  for (let pass = 0; pass < REPEATS; pass++) {
    const out = [];
    const t0 = process.hrtime.bigint();
    for (const c of all) {
      const absPath = join(roots[c.repo], c.path);
      const d = tier0({ absPath, projectDir: roots[c.repo], cfg: DEFAULTS });
      // No rule fired: the file falls through to a semantic tier that Phase 0 does not
      // have. Scored as "worth reading, no opinion" — value 2, confidence 0 — because
      // that is exactly what the shipped code does with it.
      const pred = d ?? { value: 2, confidence: 0, rule: "unclassified", verdict: "allow" };
      out.push({
        ...c,
        gold: { value: c.value, cls: c.cls },
        pred: { value: pred.value, confidence: pred.confidence, rule: pred.rule, verdict: pred.verdict },
        estTokens: estimateTokens(sizeOf(absPath), c.path),
      });
    }
    perItemMs.push(Number(process.hrtime.bigint() - t0) / 1e6 / all.length);
    results = out;
  }
  perItemMs.sort((a, b) => a - b);
  return { results, msPerItem: perItemMs[Math.floor(perItemMs.length / 2)] };
}

function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

// Before anything is measured: prove the metric can see every label in the dataset.
assertClassesCoverGold();

const roots = buildRepos();
let report;
try {
  const { results, msPerItem } = runAll(roots);

  report = {
    measuredAt: new Date().toISOString().slice(0, 10),
    tier: "tier-0 (deterministic rules)",
    model: null,
    pinnedModelForPhase1: PINNED_MODEL,
    node: process.version,
    cases: results.length,
    repos: Object.keys(repos),
    single: M.singleLabel(results),
    exact: M.exactValue(results),
    calibration: M.calibration(results),
    unsure: M.unsure(results),
    multi: M.macroPRF(results, CLASSES),
    falseDeny: M.falseDeny(results),
    flagPrecision: M.flagPrecision(results),
    wasteRecall: M.wasteRecall(results),
    reduction: M.tokenReduction(results),
    msPerItem,
    usdPer1k: 0,
    misses: results
      .filter((r) => M.isLow(r.pred.value) !== M.isLow(r.gold.value))
      .map((r) => ({ repo: r.repo, path: r.path, gold: r.gold.value, pred: r.pred.value, rule: r.pred.rule })),
  };
} finally {
  for (const r of Object.values(roots)) cleanup(r);
}

if (jsonOut) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  print(report);
}

// A regression gate, not a vanity check. These are the two numbers that decide whether
// enforcement can be trusted at all.
// Gates, chosen for what each failure would mean to a user.
//
// Overall accuracy is deliberately NOT gated: it is a coverage measure, and gating it
// would pressure the rules to guess on files they should stay silent about — which is how
// a context gate starts denying things people need.
const FALSE_DENY_MAX = 0.02;   // withholding a file the task needed
const FLAG_PRECISION_MIN = 0.95; // flagging something that was actually useful
const COVERED_ACC_MIN = 0.95;  // being wrong when we did claim an answer
let failed = false;
if (report.falseDeny.rate > FALSE_DENY_MAX) {
  console.error(`FAIL: false-deny ${M.pct(report.falseDeny.rate)} exceeds ${M.pct(FALSE_DENY_MAX)}`);
  for (const c of report.falseDeny.cases) console.error(`       withheld a needed file: ${c.repo}/${c.path} (${c.pred.rule})`);
  failed = true;
}
if (report.flagPrecision.precision !== null && report.flagPrecision.precision < FLAG_PRECISION_MIN) {
  console.error(`FAIL: flag precision ${M.pct(report.flagPrecision.precision)} below ${M.pct(FLAG_PRECISION_MIN)}`);
  failed = true;
}
if (report.single.onCovered !== null && report.single.onCovered < COVERED_ACC_MIN) {
  console.error(`FAIL: accuracy on covered cases ${M.pct(report.single.onCovered)} below ${M.pct(COVERED_ACC_MIN)}`);
  failed = true;
}
process.exit(failed ? 1 : 0);

function print(r) {
  const L = [];
  L.push("");
  L.push(`snout eval — ${r.cases} cases across ${r.repos.length} repository shapes`);
  L.push(`measured ${r.measuredAt} · ${r.tier} · node ${r.node} · no API key, no network calls`);
  L.push("");
  L.push("SINGLE LABEL");
  L.push("");
  L.push("  Is this file worth reading for the stated goal? (low value 0-1 vs worth reading 2-3)");
  L.push("");
  L.push("  classifier              coverage   acc/covered   acc/overall   ms/item   $/1k");
  L.push("  --------------------------------------------------------------------------------");
  L.push(
    `  snout tier 0    ${M.pct(r.single.coverage).padStart(7)}       ${M.pct(r.single.onCovered).padStart(7)}       ${M.pct(r.single.overall).padStart(7)}   ${r.msPerItem.toFixed(3).padStart(7)}  ${r.usdPer1k.toFixed(3)}`,
  );
  L.push("");
  L.push("  Three columns, not one, because they answer different questions.");
  L.push("");
  L.push(`  coverage      the tier has an opinion on ${r.single.covered} of ${r.single.n} files. Deterministic rules are`);
  L.push("                silent on ordinary source by design.");
  L.push("  acc/covered   correctness where it does answer. This is the accuracy number.");
  L.push("  acc/overall   counts silence as \"worth reading\". This is a COVERAGE number, and");
  L.push("                it is the one a semantic tier improves — not the one above it.");
  L.push("");
  L.push(`  exact agreement on the full 0-3 scale: ${M.pct(r.exact.accuracy)}`);
  L.push("");
  L.push("  ms/item is local CPU, median of " + REPEATS + " passes. $/1k is zero because tier 0");
  L.push("  makes no API call. Phase 1 adds " + r.pinnedModelForPhase1 + " and both columns become real.");
  L.push("");
  L.push("CALIBRATION");
  L.push("");
  L.push("  Accuracy by the confidence the classifier attached to its own answer.");
  L.push("");
  L.push("  confidence          n     accuracy");
  L.push("  ---------------------------------");
  for (const b of r.calibration) {
    L.push(`  ${b.bin.padEnd(14)} ${String(b.n).padStart(5)}      ${M.pct(b.accuracy)}`);
  }
  L.push("");
  L.push("  Read this table as a null result, not a good one. Deterministic rules are not");
  L.push("  probabilistic: they return 1.0 or 0.8 by construction, so the bins are empty by");
  L.push("  design and nothing here says how much to believe an answer. This is the table");
  L.push("  is the one to trust, and populating it honestly is the main");
  L.push("  reason Phase 1 exists.");
  L.push("");
  L.push(`  unsure subset (confidence < ${M.UNSURE_BELOW}): n=${r.unsure.n}  accuracy ${M.pct(r.unsure.accuracy)}`);
  L.push("  The unsure subset is the only set an escalation tier would touch.");
  L.push("");
  L.push("MULTI LABEL");
  L.push("");
  L.push("  One class per file across " + r.multi.per.length + " rule classes present in the gold set. Macro P/R/F1,");
  L.push("  per class. Absent classes are");
  L.push("  skipped rather than scored zero.");
  L.push("");
  L.push("  class            n    P       R       F1");
  L.push("  ----------------------------------------");
  for (const p of r.multi.per) {
    L.push(`  ${p.cls.padEnd(14)} ${String(p.tp + p.fn).padStart(3)}  ${M.f3(p.precision)}   ${M.f3(p.recall)}   ${M.f3(p.f1)}`);
  }
  L.push(`  ${"MACRO".padEnd(14)}      ${M.f3(r.multi.macro.precision)}   ${M.f3(r.multi.macro.recall)}   ${M.f3(r.multi.macro.f1)}`);
  L.push("");
  if (r.multi.macro.f1 > 0.98) {
    L.push("  A macro F1 this high is a reason for suspicion, not satisfaction. These cases were");
    L.push("  written alongside the rules and have no held-out split, so the table measures");
    L.push("  REGRESSION PROTECTION — that a rule which worked still works — and not");
    L.push("  generalisation to repositories nobody here has seen. A new file shape that fools");
    L.push("  a rule is invisible to this number until someone adds it as a case.");
    L.push("");
  }
  L.push("WITHHOLDING QUALITY");
  L.push("");
  L.push(`  false-deny rate        ${M.pct(r.falseDeny.rate).padStart(7)}   (${r.falseDeny.denied} of ${r.falseDeny.needed} essential files withheld)`);
  L.push(`  flag precision         ${M.pct(r.flagPrecision.precision).padStart(7)}   (${r.flagPrecision.correct} of ${r.flagPrecision.flagged} flags were right)`);
  L.push(`  waste recall           ${M.pct(r.wasteRecall.recall).padStart(7)}   (caught ${r.wasteRecall.caught} of ${r.wasteRecall.low} low-value files)`);
  L.push(`  token reduction        ${M.pct(r.reduction.fraction).padStart(7)}   (~${(r.reduction.avoided / 1000).toFixed(1)}k of ~${(r.reduction.offered / 1000).toFixed(1)}k tokens)`);
  L.push("");
  L.push("  false-deny is the number that decides whether enforce mode may ship. It counts");
  L.push("  only gold-value-3 files: ones the goal cannot be met without.");
  if (r.misses.length) {
    L.push("");
    L.push("DISAGREEMENTS WITH THE GOLD LABELS");
    L.push("");
    for (const m of r.misses) {
      L.push(`  ${m.repo}/${m.path}`);
      L.push(`    gold ${m.gold}  predicted ${m.pred}  via ${m.rule}`);
    }
  }
  L.push("");
  L.push("LIMITATIONS");
  L.push("");
  L.push("  One annotator, no adjudication, no held-out split: these cases informed the");
  L.push("  rules, so accuracy is an upper bound and says nothing about generalisation.");
  L.push("  Content is synthetic, realistic in shape rather than sampled. n=" + r.cases + ", so");
  L.push("  treat gaps under ~5 points as noise.");
  L.push("  See eval/README.md before quoting any of this.");
  L.push("");
  process.stdout.write(L.join("\n") + "\n");
}
