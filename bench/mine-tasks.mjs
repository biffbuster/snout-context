#!/usr/bin/env node
/**
 * Draws candidate tasks for the memory study (docs/benchmark-protocol.md, "Memory study") from a
 * GitHub repository by the frozen rule, through the GitHub API (`gh`). Read-only; nothing is run.
 *
 *   node bench/mine-tasks.mjs --repo colinhacks/zod --since 2026-07-30 [--out bench/memory-tasks-zod.json]
 *
 * An issue is a candidate when it was opened and closed (as completed) on or after --since, and a
 * PR that closed it was merged on or after --since into the default branch, changes at least one
 * test file, 1 to 4 source files, and at most 400 lines. Whether the PR's tests fail before the fix
 * and pass after it is checked by running them, a separate step (the harness's --validate).
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const REPO = arg("--repo");
const SINCE = arg("--since") ?? "2026-07-30";
if (!REPO) throw new Error("--repo owner/name");
const [owner, name] = REPO.split("/");
const gh = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};
export const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|spec|testdata)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-d\.ts$|_test\.go$/;
export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|go)$/;

const repo = gh(["api", `repos/${REPO}`]);
const query = `repo:${REPO} is:issue is:closed reason:completed linked:pr created:>=${SINCE} closed:>=${SINCE}`;
const issues = [];
for (let page = 1; page <= 10; page++) {
  const r = gh(["api", "-X", "GET", "search/issues", "-f", `q=${query}`, "-f", "per_page=100", "-f", `page=${page}`]);
  issues.push(...r.items);
  if (r.items.length < 100) break;
}
const GQL = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){
  createdAt closedAt title labels(first:20){nodes{name}}
  closedByPullRequestsReferences(first:5,includeClosedPrs:false){nodes{number merged mergedAt baseRefName baseRefOid mergeCommit{oid} additions deletions changedFiles files(first:100){nodes{path additions deletions}}}}}}}`;
const tasks = [], rejected = [];
for (const it of issues) {
  const d = gh(["api", "graphql", "-f", `query=${GQL}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${it.number}`]).data.repository.issue;
  const prs = d.closedByPullRequestsReferences.nodes.filter((p) => p.merged && p.mergedAt >= SINCE && p.baseRefName === repo.default_branch);
  const why = [];
  const pr = prs.find((p) => {
    const files = p.files.nodes.map((f) => f.path);
    const tests = files.filter((f) => TEST_FILE.test(f));
    const source = files.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f));
    const lines = p.additions + p.deletions;
    if (!tests.length) { why.push(`#${p.number}: no test file`); return false; }
    if (source.length < 1 || source.length > 4) { why.push(`#${p.number}: ${source.length} source files`); return false; }
    if (lines > 400) { why.push(`#${p.number}: ${lines} lines`); return false; }
    if (p.changedFiles > 100) { why.push(`#${p.number}: over 100 files`); return false; }
    return true;
  });
  if (!prs.length) why.push("no PR merged into the default branch in the window");
  if (!pr) { rejected.push({ issue: it.number, why }); continue; }
  tasks.push({
    id: `${name}-${it.number}`, issue: it.number, title: d.title, opened: d.createdAt, closed: d.closedAt,
    labels: d.labels.nodes.map((l) => l.name), pr: pr.number, merged: pr.mergedAt, base: pr.baseRefOid, mergeCommit: pr.mergeCommit?.oid,
    lines: pr.additions + pr.deletions, files: pr.files.nodes.map((f) => f.path),
  });
}
tasks.sort((a, b) => a.merged.localeCompare(b.merged));
console.log(`${REPO}: ${issues.length} issues in the window, ${tasks.length} candidates, ${rejected.length} rejected`);
const out = arg("--out");
if (out) writeFileSync(out, JSON.stringify({ repo: REPO, defaultBranch: repo.default_branch, since: SINCE, drawnAt: new Date().toISOString(), rule: "docs/benchmark-protocol.md#memory-study", tasks, rejected }, null, 2) + "\n");
