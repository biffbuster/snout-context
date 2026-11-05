#!/usr/bin/env node
/**
 * Draws the real-repo task set by the rule in docs/benchmark-protocol.md ("Real-repo study"), so
 * anyone can rebuild bench/realrepo-hugo-tasks.json from GitHub and a clone:
 *
 *   1. issues closed as completed since SINCE, labeled Bug, closed by a merged PR into master that
 *      changed a _test.go or testdata/ file, at most MAX_SRC non-test Go files and MAX_LINES lines;
 *   2. on this machine, with only the PR's test files applied at the base commit, the tests compile
 *      and at least one fails; with the whole PR it passes and none fails;
 *   3. the newest COUNT that qualify.
 *
 * Writes each PR's diff to bench/realrepo/<repo>/<issue>.patch and the tasks with their
 * fail-to-pass and pass-to-pass tests. Reads GitHub through `gh` (read-only); runs `go test`.
 *
 * Usage: node bench/realrepo-draw.mjs --clone C:/Users/me/Desktop/study-hugo [--work <dir>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { splitPatch } from "./realrepo.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const REPO = "gohugoio/hugo";
const NAME = "Hugo";
const SINCE = "2026-08-01";
const MAX_SRC = 4;
const MAX_LINES = 400;
const COUNT = 10;
const CLONE = args.clone;
if (typeof CLONE !== "string" || !existsSync(CLONE)) throw new Error("--clone <path to a clone of gohugoio/hugo>");
const WORK = typeof args.work === "string" ? args.work : `${CLONE}-work`;

const gh = (a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 << 20 });
const TEST_FILE = (f) => f.endsWith("_test.go") || f.includes("/testdata/");

function candidates() {
  const q = `query($cursor:String){ search(type:ISSUE, first:50, after:$cursor, query:"repo:${REPO} is:issue is:closed reason:completed closed:>=${SINCE} linked:pr label:Bug"){
    pageInfo{hasNextPage endCursor}
    nodes{ ... on Issue { number title closedAt timelineItems(itemTypes:[CLOSED_EVENT], last:1){ nodes{ ... on ClosedEvent { closer { __typename ... on PullRequest { number merged baseRefName baseRefOid files(first:100){ nodes{ path additions deletions } } } } } } } } } } }`;
  const out = [];
  let cursor = null;
  do {
    const r = JSON.parse(gh(["api", "graphql", "-f", `query=${q}`, ...(cursor ? ["-f", `cursor=${cursor}`] : [])])).data.search;
    for (const i of r.nodes) {
      const c = i.timelineItems.nodes[0]?.closer;
      if (c?.__typename !== "PullRequest" || !c.merged || c.baseRefName !== "master") continue;
      const files = c.files.nodes;
      const src = files.filter((f) => f.path.endsWith(".go") && !TEST_FILE(f.path)).length;
      const lines = files.reduce((a, f) => a + f.additions + f.deletions, 0);
      if (!files.some((f) => TEST_FILE(f.path)) || !src || src > MAX_SRC || lines > MAX_LINES) continue;
      out.push({ issue: i.number, title: i.title, closed: i.closedAt, pr: c.number, base: c.baseRefOid });
    }
    cursor = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (cursor);
  return out.sort((a, b) => b.closed.localeCompare(a.closed) || b.issue - a.issue);
}

function goTest(cwd, pkgs) {
  const r = spawnSync("go", ["test", "-count=1", "-json", ...pkgs], { cwd, encoding: "utf8", maxBuffer: 512 << 20, timeout: 1_200_000, env: { ...process.env, GOTOOLCHAIN: "local" } });
  const res = {};
  for (const l of (r.stdout || "").split("\n")) {
    try { const e = JSON.parse(l); if (e.Test && ["pass", "fail", "skip"].includes(e.Action)) res[`${e.Package}.${e.Test}`] = e.Action; } catch { /* not a test event */ }
  }
  return { res, built: !/\[build failed\]|\[setup failed\]/.test(r.stdout || "") };
}

/** Fail-to-pass and pass-to-pass tests for one candidate, or why it does not qualify. */
function validate(c) {
  const dir = join(WORK, String(c.issue));
  if (existsSync(dir)) git(CLONE, "worktree", "remove", "--force", dir);
  git(CLONE, "worktree", "add", "-q", "--detach", dir, c.base);
  try {
    const full = gh(["pr", "diff", String(c.pr), "--repo", REPO]);
    const { test, source, testFiles } = splitPatch(full);
    const pkgs = [...new Set(testFiles.filter((f) => f.endsWith(".go")).map((f) => `./${f.split("/").slice(0, -1).join("/")}`.replace(/^\.\/$/, ".")))];
    if (!pkgs.length) return { why: "no Go test files" };
    writeFileSync(join(dir, ".test.patch"), test);
    writeFileSync(join(dir, ".source.patch"), source);
    git(dir, "apply", ".test.patch");
    const before = goTest(dir, pkgs);
    // Tests that only fail to compile name code the fix adds: they would grade a guess at its names.
    if (!before.built) return { why: "the PR's tests do not compile before the fix" };
    git(dir, "apply", ".source.patch");
    const after = goTest(dir, pkgs);
    if (!after.built) return { why: "does not build with the PR" };
    const tests = Object.keys(after.res);
    const failAfter = tests.filter((t) => after.res[t] === "fail");
    if (failAfter.length) return { why: `${failAfter.length} test(s) fail with the PR on this machine` };
    const f2p = tests.filter((t) => after.res[t] === "pass" && before.res[t] === "fail");
    if (!f2p.length) return { why: "no test fails before the fix on this machine" };
    const p2p = tests.filter((t) => after.res[t] === "pass" && before.res[t] === "pass");
    return { full, testFiles, pkgs, f2p, p2p };
  } finally {
    git(CLONE, "worktree", "remove", "--force", dir);
  }
}

const tasks = [];
const rejected = [];
for (const c of candidates()) {
  if (tasks.length >= COUNT) break;
  const v = validate(c);
  if (v.why) { rejected.push({ issue: c.issue, why: v.why }); console.error(`#${c.issue} no: ${v.why}`); continue; }
  const patch = `bench/realrepo/hugo/${c.issue}.patch`;
  mkdirSync(join(REPO_ROOT, "bench/realrepo/hugo"), { recursive: true });
  writeFileSync(join(REPO_ROOT, patch), v.full);
  tasks.push({ id: `hugo-${c.issue}`, issue: c.issue, title: c.title, closed: c.closed.slice(0, 10), pr: c.pr, base: c.base, patch, testFiles: v.testFiles, pkgs: v.pkgs, f2p: v.f2p, p2p: v.p2p });
  console.error(`#${c.issue} yes: ${v.f2p.length} fail-to-pass, ${v.p2p.length} pass-to-pass`);
}
const spec = {
  repo: REPO, name: NAME, clone: relative(REPO_ROOT, CLONE).replace(/\\/g, "/"),
  rule: `Bug issues closed as completed since ${SINCE} by a merged PR into master that changed a test file, <= ${MAX_SRC} non-test Go files and <= ${MAX_LINES} lines; the PR tests compile and at least one fails before, passes after on this machine, none fails after; newest ${COUNT}.`,
  drawnAt: new Date().toISOString(),
  go: execFileSync("go", ["version"], { encoding: "utf8" }).trim(),
  tasks, rejected,
};
writeFileSync(join(REPO_ROOT, "bench/realrepo-hugo-tasks.json"), JSON.stringify(spec, null, 2) + "\n");
console.log(`${tasks.length} task(s), ${rejected.length} rejected → bench/realrepo-hugo-tasks.json`);
