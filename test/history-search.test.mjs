// History search (memory/history-search.ts): every visible record is ranked, and admission is a
// separate decision that needs evidence. Synthetic records; no model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exactIn, rankHistory } from "../dist/lib.mjs";

const rec = (sha, title, { body = "", files = [], at = "2026-10-01T00:00:00Z" } = {}) =>
  ({ v: 1, id: `commit:${sha.padEnd(40, "0")}`, kind: "commit", at, title, body, files, link: `git show ${sha}`, sha: sha.padEnd(40, "0") });
const none = () => false;
const admitted = (ranked) => ranked.filter((x) => x.admitted).map((x) => x.r.title);

const releases = Array.from({ length: 12 }, (_, i) => rec(`a${i}`, `release: v1.${i}.0`, { files: ["CHANGELOG.md", "package.json"] }));
const fix = rec("b1", "fix(sourcemap): skip URL source roots when injecting sources", { files: ["src/sourcemap.ts"] });

test("words most of the history shares answer nothing; the question's rarer words do", () => {
  const all = [...releases, fix];
  assert.deepEqual(admitted(rankHistory(all, { text: "Snout 0.3.2: changelog dated for release", exact: none, eligible: 5 })), []);
  assert.deepEqual(admitted(rankHistory(all, { text: "sourcemap source roots are wrong", exact: none, eligible: 5 })), [fix.title]);
});

test("a file the agent names ranks a record but never admits it on its own", () => {
  const refactor = rec("c1", "refactor internals of the scheduler", { files: ["src/sched/core.rs"] });
  const ranked = rankHistory([refactor, fix], { text: "why does login fail for some users", exact: none, eligible: 5, files: ["src/sched/core.rs"] });
  assert.equal(ranked[0].r, refactor, "the file lifts it to the top");
  assert.equal(ranked[0].fileHit, 1);
  assert.deepEqual(admitted(ranked), [], "but shares nothing with the question, so it answers nothing");
});

test("meaning admits a record alone only when close; a fair meaning needs the question's rarer words too", () => {
  const unit = (xs) => { const v = Float32Array.from(xs); const n = Math.hypot(...v); return v.map((x) => x / n); };
  const q = unit([1, 0, 0]);
  const close = rec("d1", "Avoid reinitializing the watcher once the server closed");
  const fair = rec("d2", "watcher restarts after close");
  const far = rec("d3", "Tidy the docs build");
  const vecs = new Map([[close.id, unit([0.8, 0.6, 0])], [fair.id, unit([0.7, 0.71, 0])], [far.id, unit([0.2, 0.98, 0])]]);
  const ranked = rankHistory([close, fair, far], { text: "file watcher keeps running after shutdown", exact: none, eligible: 5, qvec: q, vecOf: (r) => vecs.get(r.id) });
  const by = (r) => ranked.find((x) => x.r === r);
  assert.ok(by(close).cos >= 0.74 && by(close).admitted, "cosine 0.8: answers on meaning");
  assert.ok(by(fair).cos < 0.74 && by(fair).cos >= 0.68, "cosine about 0.70");
  assert.equal(by(fair).admitted, by(fair).cover >= 0.3, "a fair meaning answers only with enough of the question's rarer words");
  assert.equal(by(far).admitted, false);
});

test("only the first `eligible` ranked records can be admitted", () => {
  const many = Array.from({ length: 10 }, (_, i) => rec(`e${i}`, `sourcemap source roots fix part ${i}`));
  const ranked = rankHistory(many, { text: "sourcemap source roots", exact: none, eligible: 3 });
  assert.equal(ranked.filter((x) => x.admitted).length, 3);
});

test("a version, sha, PR or path the question gives answers exactly", () => {
  const all = [...releases, fix];
  assert.deepEqual(admitted(rankHistory(all, { text: "release v1.11.0 notes", exact: exactIn("release v1.11.0 notes"), eligible: 5 })).slice(0, 1), ["release: v1.11.0"]);
  assert.ok(admitted(rankHistory(all, { text: "what changed in src/sourcemap.ts", exact: exactIn("what changed in src/sourcemap.ts"), eligible: 5 })).includes(fix.title));
  assert.equal(exactIn("release v1.11.0 notes")(releases[1]), false, "v1.1.0 is not v1.11.0");
  // A bare two-part number is no version: "YAML 1.2" names no release (found on astropy, 2026-11-09).
  const dataOrigin = rec("g1", "Refactoring to class + DataOrigin v1.2");
  assert.equal(exactIn("Why does the ECSV writer now emit YAML 1.2 headers?")(dataOrigin), false);
  assert.equal(exactIn("what changed in v1.2")(dataOrigin), true, "with a v it is one");
  assert.equal(exactIn("what changed in 2.4.1")(rec("g2", "release 2.4.1")), true, "three parts are one");
});

test("a sha whose first seven characters are all digits still names its commit, and only that commit", () => {
  // About one random sha in 27 starts this way; test/import.test.mjs hit it as a flaky failure (2026-11-10).
  const digits = rec("98933634", "fix shard rollover");
  const mentioning = rec("c0ffee1", "bump", { body: "ticket 9893363 in the tracker" });
  assert.equal(exactIn("what did 9893363 change")(digits), true);
  assert.equal(exactIn("what did 9893363 change")(mentioning), false, "a long number in another record's text is no mention of a commit");
  assert.equal(exactIn("what did c0ffee1 change")(rec("e1", "x", { body: "reverts c0ffee1" })), true, "a sha with a letter still counts as a mention");
});

test("records after the as-of date change nothing: not the ranking statistics, not the result", () => {
  const before = [...releases.slice(0, 3), fix];
  const later = Array.from({ length: 30 }, (_, i) => rec(`f${i}`, `sourcemap roots rework ${i}`, { at: "2026-11-01T00:00:00Z" }));
  const cut = "2026-10-15T00:00:00Z";
  const visible = [...before, ...later].filter((r) => r.at <= cut);
  const a = rankHistory(before, { text: "sourcemap source roots are wrong", exact: none, eligible: 5 });
  const b = rankHistory(visible, { text: "sourcemap source roots are wrong", exact: none, eligible: 5 });
  assert.deepEqual(b.map((x) => [x.r.id, x.cover, x.admitted]), a.map((x) => [x.r.id, x.cover, x.admitted]));
});
