/**
 * Metrics for the classifier eval.
 *
 * The one that decides whether enforcement ships is `falseDeny`: the share of files the
 * developer actually needed that we would have blocked. Everything else can look good
 * while that number makes the product unusable.
 */

/** Confidence bins, matching the benchmark exactly so the tables are comparable. */
export const BINS = [
  { label: "[0.9, 1.0]", lo: 0.9, hi: 1.0001 },
  { label: "[0.7, 0.9)", lo: 0.7, hi: 0.9 },
  { label: "[0.5, 0.7)", lo: 0.5, hi: 0.7 },
  { label: "[0.0, 0.5)", lo: 0.0, hi: 0.5 },
];

/** The benchmark's "unsure" cut: the only items an escalation tier would touch. */
export const UNSURE_BELOW = 0.7;

/**
 * Was the predicted value right? Exact match on the 0-3 scale is harsh and not what the
 * product does, so we score the decision the product makes: low value (0-1, a candidate
 * for withholding) versus worth reading (2-3).
 */
export const isLow = (v) => v <= 1;

/** A case the deterministic tier actually has an opinion about. */
export const isCovered = (r) => r.pred.rule !== "unclassified";

/**
 * Accuracy, decomposed.
 *
 * Reporting one number here would be misleading.
 * A rule-based tier is silent on most files by design: `cls: null` in the gold set
 * means no rule SHOULD fire. Scoring that silence as a wrong answer conflates two
 * different things — how often the classifier is wrong, and how often it declines to
 * answer — and produces a headline that reads like a quarter of its answers are bad when
 * every answer it gave was right.
 *
 *   covered   what fraction of files the tier has an opinion on
 *   onCovered accuracy restricted to those. This is the correctness number.
 *   overall   accuracy across everything, counting a fallthrough as "worth reading".
 *             This is a COVERAGE number, and it is what a semantic tier improves.
 */
export function singleLabel(results) {
  const covered = results.filter(isCovered);
  const right = (rs) => rs.filter((r) => isLow(r.pred.value) === isLow(r.gold.value)).length;
  return {
    n: results.length,
    covered: covered.length,
    coverage: covered.length / results.length,
    onCovered: covered.length ? right(covered) / covered.length : null,
    overall: right(results) / results.length,
  };
}

/** Exact agreement on the full 0-3 scale, reported alongside as the stricter number. */
export function exactValue(results) {
  let correct = 0;
  for (const r of results) if (r.pred.value === r.gold.value) correct++;
  return { n: results.length, accuracy: correct / results.length };
}

export function calibration(results) {
  return BINS.map(({ label, lo, hi }) => {
    const inBin = results.filter((r) => r.pred.confidence >= lo && r.pred.confidence < hi);
    const correct = inBin.filter((r) => isLow(r.pred.value) === isLow(r.gold.value)).length;
    return { bin: label, n: inBin.length, accuracy: inBin.length ? correct / inBin.length : null };
  });
}

export function unsure(results) {
  const items = results.filter((r) => r.pred.confidence < UNSURE_BELOW);
  const correct = items.filter((r) => isLow(r.pred.value) === isLow(r.gold.value)).length;
  return { n: items.length, accuracy: items.length ? correct / items.length : null };
}

/**
 * Macro-averaged precision / recall / F1 over the rule classes, as the benchmark's
 * multi-label table does. A class with no gold instances is skipped rather than scored 0:
 * averaging in an absent class flatters or punishes the mean for no reason.
 */
export function macroPRF(results, classes) {
  const per = [];
  for (const cls of classes) {
    let tp = 0, fp = 0, fn = 0;
    for (const r of results) {
      const g = r.gold.cls === cls;
      const p = r.pred.rule === cls;
      if (g && p) tp++;
      else if (p) fp++;
      else if (g) fn++;
    }
    if (tp + fn === 0) continue; // class absent from the gold set
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp / (tp + fn);
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    per.push({ cls, tp, fp, fn, precision, recall, f1 });
  }
  const mean = (k) => per.reduce((a, x) => a + x[k], 0) / (per.length || 1);
  return { per, macro: { precision: mean("precision"), recall: mean("recall"), f1: mean("f1") } };
}

/**
 * The gating metric. A "needed" file is gold value 3: the goal cannot be met without it.
 * A deny is any prediction of value 0 — what enforce mode blocks.
 */
export function falseDeny(results) {
  const needed = results.filter((r) => r.gold.value === 3);
  const wrongly = needed.filter((r) => r.pred.value === 0);
  return { needed: needed.length, denied: wrongly.length, rate: needed.length ? wrongly.length / needed.length : 0, cases: wrongly };
}

/** Of everything we flagged as low value, how much really was. Precision of withholding. */
export function flagPrecision(results) {
  const flagged = results.filter((r) => isLow(r.pred.value));
  const right = flagged.filter((r) => isLow(r.gold.value));
  return { flagged: flagged.length, correct: right.length, precision: flagged.length ? right.length / flagged.length : null };
}

/** Of everything that really was low value, how much we caught. Recall of withholding. */
export function wasteRecall(results) {
  const low = results.filter((r) => isLow(r.gold.value));
  const caught = low.filter((r) => isLow(r.pred.value));
  return { low: low.length, caught: caught.length, recall: low.length ? caught.length / low.length : null };
}

export function tokenReduction(results) {
  let offered = 0, avoided = 0;
  for (const r of results) {
    offered += r.estTokens;
    if (isLow(r.pred.value)) avoided += r.estTokens;
  }
  return { offered, avoided, fraction: offered ? avoided / offered : 0 };
}

export const pct = (x) => (x === null || x === undefined ? "  n/a" : `${(x * 100).toFixed(1)}%`);
export const f3 = (x) => (x === null || x === undefined ? "n/a" : x.toFixed(3));
