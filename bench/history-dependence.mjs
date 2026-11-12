#!/usr/bin/env node
/**
 * Which tasks the project's history could help with, measured before any session (free, local, read
 * only). The replay pilot (2026-11-10) drew separate bug fixes whose cause sits in the code the issue
 * points at; Claude Code never searched memory and never ran git log. Memory can only matter on a task
 * whose answer is in the history the agent would get, so the full run's tasks should be drawn by that.
 *
 * A task depends on recent history when a source line its fix changes was last changed, at the task's
 * base, by a commit inside the import window (SINCE_DAYS before the base's date): that commit is among
 * the records `snout import` gives the search arm. Lines a fix removes or rewrites are blamed; a hunk
 * that only adds lines blames its context lines instead. Only source files count: the PR's test files,
 * docs, manifests and lockfiles are left out. Reported
 * beside it, never used as the rule: whether the issue's own words say something used to work.
 *
 *   node bench/history-dependence.mjs --tasks bench/memory-tasks-hugo.json [--clone ~/.snout-bench/clones/hugo] [--out file.json]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []));
if (typeof args.tasks !== "string") throw new Error("--tasks <file> is required");
const spec = JSON.parse(readFileSync(resolve(REPO, args.tasks), "utf8"));
const name = spec.repo.split("/")[1];
const clone = typeof args.clone === "string" ? resolve(args.clone.replace(/^~/, homedir())) : join(homedir(), ".snout-bench", "clones", name);
if (!existsSync(clone)) throw new Error(`no clone at ${clone}`);

/** The import's window: the same six months `snout import` reads back from the base (src/memory/history.ts SINCE_DAYS). */
const SINCE_DAYS = 183;
const DAY = 86_400_000;
const REGRESSION = /\b(regression|regressed|used to work|worked (?:fine |well )?(?:in|before|with|until)|no longer|stopped working|since (?:v?\d|version|upgrading|updating)|after (?:upgrading|updating)|broke(?:n)? (?:in|since|after))\b/i;

/** Source code only: a fix's edits to go.mod, lockfiles, docs or config say nothing about where the bug came from. */
const SOURCE = /\.(go|ts|tsx|mts|cts|js|mjs|cjs|jsx|py|rs|java|kt|rb|c|cc|cpp|h|hpp|cs|swift|php)$/;

const git = (a) => spawnSync("git", ["-C", clone, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });

/** Per source file of a patch: old-side line numbers the fix removes, or, for a hunk that only adds, its context lines. */
function changedLines(patch, testFiles) {
  const out = new Map();
  let file = null, old = 0, removed = [], context = [];
  const flush = () => { if (file) out.set(file, [...(out.get(file) ?? []), ...(removed.length ? removed : context)]); removed = []; context = []; };
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) { flush(); file = null; continue; }
    if (l.startsWith("--- ")) { const p = l.slice(4).replace(/^a\//, ""); file = p === "/dev/null" || testFiles.includes(p) || !SOURCE.test(p) || /(^|\/)docs?\//.test(p) ? null : p; continue; }
    if (l.startsWith("+++ ")) continue;
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(l);
    if (h) { flush(); old = Number(h[1]); continue; }
    if (!file) continue;
    if (l.startsWith("-")) removed.push(old++);
    else if (l.startsWith(" ")) context.push(old++);
  }
  flush();
  return out;
}

/** The commit that last changed each line at the base: {sha, at (ms), subject}. */
function blame(base, file, lines) {
  const ranges = [];
  for (const n of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n; else ranges.push([n, n]);
  }
  const r = git(["blame", "--porcelain", ...ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]), base, "--", file]);
  if (r.status !== 0) return [];
  const commits = new Map(), out = [];
  let cur = null;
  for (const l of r.stdout.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
    if (head) { cur = head[1]; if (!commits.has(cur)) commits.set(cur, {}); out.push(cur); continue; }
    if (l.startsWith("committer-time ")) commits.get(cur).at = Number(l.slice(15)) * 1000;
    if (l.startsWith("summary ")) commits.get(cur).subject = l.slice(8);
  }
  return out.map((sha) => ({ sha, ...commits.get(sha) }));
}

const design = (() => { try { return JSON.parse(readFileSync(join(REPO, "bench", "replay-design.json"), "utf8")); } catch { return null; } })();
const setOf = (id) => {
  const key = args.tasks.replace(/\\/g, "/").replace(/^\.\//, "");
  return design?.tasks?.[key]?.includes(id) ? "pilot" : design?.heldOut?.[key]?.includes(id) ? "held out" : null;
};

const rows = [];
for (const t of spec.tasks.filter((x) => x.validated)) {
  const baseAt = Number(git(["log", "-1", "--format=%ct", t.base]).stdout.trim()) * 1000;
  const lines = changedLines(readFileSync(join(REPO, t.patch), "utf8"), t.testFiles ?? []);
  const blamed = [...lines].flatMap(([file, ls]) => blame(t.base, file, ls).map((b) => ({ ...b, file })));
  const ages = blamed.filter((b) => b.at).map((b) => ({ ...b, days: (baseAt - b.at) / DAY }));
  const youngest = ages.reduce((a, b) => (!a || b.days < a.days ? b : a), null);
  const recent = ages.filter((b) => b.days <= SINCE_DAYS);
  const issue = existsSync(join(REPO, t.issueSnapshot ?? "")) ? readFileSync(join(REPO, t.issueSnapshot), "utf8") : "";
  rows.push({
    id: t.id, set: setOf(t.id) ?? (t.usedBefore ? "used before" : "other"),
    lines: ages.length, recentLines: recent.length, dependsOnHistory: recent.length > 0,
    youngest: youngest ? { sha: youngest.sha.slice(0, 10), days: Math.round(youngest.days), subject: youngest.subject, file: youngest.file } : null,
    regressionWords: (REGRESSION.exec(issue) ?? [null])[0],
  });
}

console.log(`${spec.repo}: ${rows.length} validated tasks; a fix line last changed within ${SINCE_DAYS} days before the base = depends on recent history\n`);
console.log("  task           set          depends   lines (recent)   youngest change                               issue says");
for (const r of rows) {
  const y = r.youngest ? `${String(r.youngest.days).padStart(4)} d  ${r.youngest.subject.slice(0, 38)}` : "   -";
  console.log(`  ${r.id.padEnd(14)} ${r.set.padEnd(12)} ${(r.dependsOnHistory ? "yes" : "no").padEnd(9)} ${`${r.lines} (${r.recentLines})`.padEnd(16)} ${y.padEnd(45)} ${r.regressionWords ?? ""}`);
}
const by = (f) => rows.filter(f).length;
console.log(`\n  depends on recent history: ${by((r) => r.dependsOnHistory)} of ${rows.length} (pilot ${by((r) => r.set === "pilot" && r.dependsOnHistory)} of ${by((r) => r.set === "pilot")}, held out ${by((r) => r.set === "held out" && r.dependsOnHistory)} of ${by((r) => r.set === "held out")}); issue words say it used to work: ${by((r) => r.regressionWords)}`);
if (typeof args.out === "string") writeFileSync(resolve(REPO, args.out), JSON.stringify({ repo: spec.repo, sinceDays: SINCE_DAYS, at: new Date().toISOString(), rows }, null, 2) + "\n");
