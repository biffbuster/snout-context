// bench/report.mjs: the publication report every public benchmark number is rebuilt with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attempts, compare, toCsv } from "../bench/report.mjs";

const REPORT = fileURLToPath(new URL("../bench/report.mjs", import.meta.url));
const row = (task, arm, pass, costUsd, extra = {}) => ({ task, arm, pass, costUsd, inputTokens: 1000, outputTokens: 10, turns: 3, ...extra });

test("attempts: one per row, one per issue of a long session, infrastructure failures marked", () => {
  const a = attempts({ rows: [row("t1", "off", true, 0.1), row("t1", "off", false, 0.2), row("t1", "on", true, 0.05, { infra: true })] }, "f.json");
  assert.deepEqual(a.map((x) => [x.task, x.arm, x.rep, x.solved, x.excluded]), [["t1", "off", 0, true, false], ["t1", "off", 1, false, false], ["t1", "on", 0, true, true]]);
  const long = attempts({ rows: [{ chain: "c", arm: "on", rep: 1, tasks: [{ task: "i1", resolved: true }, { task: "i2", resolved: false }], perIssueUsd: [0.3, 0.4] }] });
  assert.deepEqual(long.map((x) => [x.task, x.solved, x.costUsd, x.session]), [["i1", true, 0.3, "c#1"], ["i2", false, 0.4, "c#1"]]);
});

test("compare: paired tasks only, the margin decides quality, the interval decides the saving", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(row(`t${i}`, "off", true, 0.1), row(`t${i}`, "on", i !== 0, 0.07));
  }
  rows.push(row("only-off", "off", true, 9));
  const c = compare(attempts({ rows }), "off", "on", 5);
  assert.equal(c.tasks, 20, "a task only one arm attempted is not paired");
  assert.equal(c.solvedDiffPts, -5);
  assert.equal(c.noQualityLoss, false, "losing 1 of 20 tasks cannot rule out a 5-point loss");
  assert.ok(c.costPerSolvedChangePct < -20 && c.saving);
  assert.deepEqual(compare(attempts({ rows }), "off", "on", 5), c, "seeded: a rebuild prints the same interval");
  const wide = compare(attempts({ rows }), "off", "on", 20);
  assert.equal(wide.noQualityLoss, true);
});

test("excluded and ungraded attempts count in no number", () => {
  const c = compare(attempts({ rows: [row("t", "off", true, 0.1), row("t", "on", true, 0.1), row("t", "on", false, 5, { infra: true }), row("t", "on", null, 5)] }), "off", "on", 5);
  assert.deepEqual(c.attempts, { off: 1, on: 1 });
  assert.equal(c.costPerSolvedChangePct, 0);
});

test("CSV quotes what needs quoting; the CLI refuses to run without a margin and writes all three files", () => {
  assert.match(toCsv([{ task: 'a,"b"', arm: "off" }]), /^.*\n,"a,""b""",off,/);
  const dir = mkdtempSync(join(tmpdir(), "snout-report-"));
  const file = join(dir, "run.json");
  writeFileSync(file, JSON.stringify({ rows: [row("t", "off", true, 0.1), row("t", "on", true, 0.08)] }));
  assert.equal(spawnSync(process.execPath, [REPORT, file], { encoding: "utf8" }).status, 2);
  const r = spawnSync(process.execPath, [REPORT, file, "--margin", "5", "--out", join(dir, "out")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "out", "attempts.csv"), "utf8").trim().split("\n").length, 3);
  assert.equal(JSON.parse(readFileSync(join(dir, "out", "summary.json"), "utf8")).comparisons[0].marginPts, 5);
  assert.match(readFileSync(join(dir, "out", "chart.svg"), "utf8"), /^<svg[\s\S]*on · 1\/1/);
});
