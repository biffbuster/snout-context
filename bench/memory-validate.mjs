#!/usr/bin/env node
/**
 * Validates the memory study's candidate tasks (docs/benchmark-protocol.md, "Memory study") on this
 * machine, and freezes what each task gives the agent and grades it with.
 *
 *   node bench/memory-validate.mjs --tasks bench/memory-tasks-vite.json --clone ~/.snout-bench/clones/vite
 *   node bench/memory-validate.mjs --tasks bench/memory-tasks-hugo.json --clone ../study-hugo [--only 15234,15253]
 *
 * For each candidate, at its base commit (a git worktree of the clone): only the PR's test files
 * applied, the tests must load and at least one must fail; with the whole PR, every one passes. Each
 * condition runs twice and must give the same results, or the task is excluded as flaky.
 * FAIL_TO_PASS: tests that fail before and pass after. PASS_TO_PASS: tests that pass in all four runs.
 *
 * Go: `go test -json` on the packages of the PR's _test.go files. TypeScript (vite): dependencies
 * installed offline-first and the workspace's `vite` package built, then vitest's JSON reporter on the
 * PR's spec files; the package is rebuilt after the fix is applied, as grading does.
 *
 * Writes, under bench/memory/<repo>/: <issue>.patch (the PR's diff, never shown to an agent) and
 * <issue>.issue.md (the issue as it read before the fix PR was opened, links to PRs, commits and
 * branches removed). Updates each task in the tasks file with its outcome; drops none.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { freemem, homedir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const TASKS_FILE = resolve(REPO_ROOT, String(args.tasks));
const CLONE = resolve(String(args.clone).replace(/^~/, homedir()));
const WORK = resolve(typeof args.work === "string" ? args.work : join(homedir(), ".snout-bench", "mem-validate"));
const ONLY = typeof args.only === "string" ? new Set(args.only.split(",").map(Number)) : null;
// Stops before a task or a test run when free memory falls below this (an earlier run was killed for low memory).
const MIN_FREE = Number(args["min-free-gb"] ?? 2) * 2 ** 30;
class LowMemory extends Error {}
const memoryCheck = () => { if (freemem() < MIN_FREE) throw new LowMemory(`free memory ${(freemem() / 2 ** 30).toFixed(1)} GB is below ${MIN_FREE / 2 ** 30} GB`); };
const spec = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
const NAME = spec.repo.split("/")[1];
const GO = spec.repo === "gohugoio/hugo";
// pnpm through a corepack shim (`corepack enable --install-directory ~/.snout-bench/bin pnpm`): vite's scripts call `pnpm` by name.
const BIN = join(homedir(), ".snout-bench", "bin");
const ENV = { ...process.env, GOTOOLCHAIN: "local", PATH: `${BIN}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`, CI: "1" };
const OUT = join(REPO_ROOT, "bench", "memory", NAME);
mkdirSync(OUT, { recursive: true });

const sh = (cmd, a, cwd, timeout = 1_800_000) => spawnSync(cmd, a, { cwd, encoding: "utf8", maxBuffer: 512 << 20, timeout, env: ENV, shell: process.platform === "win32" && cmd === "pnpm" });
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || "").slice(-400)}`); return r; };
const gh = (a) => must(spawnSync("gh", a, { encoding: "utf8", maxBuffer: 64 << 20 }), `gh ${a[0]}`).stdout;

export const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|spec|testdata)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-d\.ts$|_test\.go$/;
/** A file vitest runs as a test (not a fixture or a type test). */
const SPEC = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function splitPatch(full) {
  const blocks = full.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  const file = (b) => /^diff --git a\/\S+ b\/(\S+)$/m.exec(b)?.[1] ?? "";
  return { test: blocks.filter((b) => TEST_FILE.test(file(b))).join(""), source: blocks.filter((b) => !TEST_FILE.test(file(b))).join(""), testFiles: blocks.map(file).filter((f) => TEST_FILE.test(f)) };
}

function goTest(cwd, pkgs) {
  const r = sh("go", ["test", "-count=1", "-json", ...pkgs], cwd);
  const res = {};
  for (const l of (r.stdout || "").split("\n")) {
    try { const e = JSON.parse(l); if (e.Test && ["pass", "fail", "skip"].includes(e.Action)) res[`${e.Package}.${e.Test}`] = e.Action; } catch { /* not a test event */ }
  }
  return { res, loaded: !/\[build failed\]|\[setup failed\]/.test(r.stdout || "") };
}

function vitest(cwd, files) {
  const out = join(cwd, "..", `vitest-${Date.now()}.json`);
  sh("pnpm", ["exec", "vitest", "run", ...files, "--reporter=json", `--outputFile=${out}`], cwd);
  if (!existsSync(out)) return { res: {}, loaded: false };
  const r = JSON.parse(readFileSync(out, "utf8"));
  rmSync(out, { force: true });
  const res = {};
  let loaded = r.testResults.length === files.length;
  for (const f of r.testResults) {
    // A file that failed with no test run did not load (an import the fix adds, a syntax error).
    if (!f.assertionResults.length && f.status === "failed") loaded = false;
    const rel = relative(cwd, f.name).replace(/\\/g, "/");
    for (const a of f.assertionResults) res[`${rel}::${a.fullName}`] = a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip";
  }
  return { res, loaded };
}

const same = (a, b) => JSON.stringify(Object.entries(a.res).sort()) === JSON.stringify(Object.entries(b.res).sort()) && a.loaded === b.loaded;

/** The issue as it read before the fix PR was opened: title, body, earlier comments; no links to PRs, commits or branches. */
function snapshot(t, prOpened) {
  const issue = JSON.parse(gh(["api", `repos/${spec.repo}/issues/${t.issue}`]));
  const comments = JSON.parse(gh(["api", "--paginate", `repos/${spec.repo}/issues/${t.issue}/comments`]));
  const strip = (s) => String(s ?? "")
    .replace(/https?:\/\/github\.com\/[^\s)\]]+\/(?:pull|commit|commits|compare|tree|blob)\/[^\s)\]]+/g, "[link removed]")
    .replace(/(?<![\w/])#(\d+)\b/g, (m, n) => (Number(n) === t.pr ? "[link removed]" : m))
    .replace(/\b[0-9a-f]{40}\b/g, "[commit removed]");
  const before = comments.filter((c) => c.created_at < prOpened);
  return [`# ${strip(issue.title)} (issue #${t.issue})`, "", strip(issue.body).trim(), ...before.map((c) => `\n---\n\nComment by ${c.user?.login ?? "someone"}:\n\n${strip(c.body).trim()}`)].join("\n") + "\n";
}

function validate(t) {
  const dir = join(WORK, `${NAME}-${t.issue}`);
  if (existsSync(dir)) sh("git", ["worktree", "remove", "--force", dir], CLONE);
  rmSync(dir, { recursive: true, force: true });
  sh("git", ["worktree", "prune"], CLONE);
  must(sh("git", ["worktree", "add", "-q", "--detach", dir, t.base], CLONE), "worktree");
  try {
    const full = gh(["pr", "diff", String(t.pr), "--repo", spec.repo]);
    const { test, source, testFiles } = splitPatch(full);
    writeFileSync(join(dir, "..", `${NAME}-${t.issue}.test.patch`), test);
    writeFileSync(join(dir, "..", `${NAME}-${t.issue}.source.patch`), source);
    const apply = (p) => must(sh("git", ["apply", "--whitespace=nowarn", join(dir, "..", `${NAME}-${t.issue}.${p}.patch`)], dir), `apply ${p}`);
    let run, files, pkgs;
    if (GO) {
      pkgs = [...new Set(testFiles.filter((f) => f.endsWith(".go")).map((f) => `./${f.split("/").slice(0, -1).join("/")}`.replace(/^\.\/$/, ".")))];
      if (!pkgs.length) return { why: "no Go test files" };
      run = () => goTest(dir, pkgs);
    } else {
      files = testFiles.filter((f) => SPEC.test(f) && !/(?:^|\/)fixtures?\//.test(f));
      if (!files.length) return { why: "no spec file vitest runs" };
      must(sh("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], dir), "pnpm install");
      const build = () => must(sh("pnpm", ["--filter", "vite", "run", "build"], dir), "build vite");
      build();
      run = () => vitest(dir, files);
      // The fix is built before the after-runs, as grading builds the agent's work.
      t._rebuild = build;
    }
    apply("test");
    const checked = run;
    run = () => { memoryCheck(); return checked(); };
    const b1 = run(), b2 = run();
    if (!b1.loaded) return { why: GO ? "the PR's tests do not compile before the fix" : "the PR's tests do not load before the fix" };
    if (!same(b1, b2)) return { why: "flaky before the fix (two runs differ)" };
    apply("source");
    t._rebuild?.();
    const a1 = run(), a2 = run();
    if (!a1.loaded) return { why: "the tests do not load with the PR" };
    if (!same(a1, a2)) return { why: "flaky with the PR (two runs differ)" };
    const names = Object.keys(a1.res);
    const failAfter = names.filter((n) => a1.res[n] === "fail");
    if (failAfter.length) return { why: `${failAfter.length} test(s) fail with the PR on this machine` };
    const f2p = names.filter((n) => a1.res[n] === "pass" && b1.res[n] === "fail");
    if (!f2p.length) return { why: "no test fails before the fix on this machine" };
    const p2p = names.filter((n) => a1.res[n] === "pass" && b1.res[n] === "pass");
    return { full, testFiles, ...(GO ? { pkgs } : { specFiles: files }), f2p, p2p };
  } finally {
    delete t._rebuild;
    sh("git", ["worktree", "remove", "--force", dir], CLONE);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const started = Date.now();
for (const t of spec.tasks) {
  if (ONLY && !ONLY.has(t.issue)) continue;
  // Settled tasks (validated or excluded) are skipped unless --again rechecks them.
  if (t.validated !== null && t.validated !== undefined && !args.again) continue;
  let v;
  try {
    memoryCheck();
    v = validate(t);
  } catch (e) {
    if (e instanceof LowMemory) { console.error(`stopped before finishing ${t.id}: ${e.message}; nothing recorded for it`); break; }
    v = { why: `could not check: ${String(e.message).slice(0, 300)}` };
  }
  if (v.why) {
    Object.assign(t, { validated: false, why: v.why });
    console.error(`${t.id} no: ${v.why}`);
  } else {
    const pr = JSON.parse(gh(["api", `repos/${spec.repo}/pulls/${t.pr}`]));
    const patch = `bench/memory/${NAME}/${t.issue}.patch`;
    const issue = `bench/memory/${NAME}/${t.issue}.issue.md`;
    writeFileSync(join(REPO_ROOT, patch), v.full);
    writeFileSync(join(REPO_ROOT, issue), snapshot(t, pr.created_at));
    Object.assign(t, { validated: true, why: undefined, prOpened: pr.created_at, patch, issueSnapshot: issue, testFiles: v.testFiles, ...(v.pkgs ? { pkgs: v.pkgs } : { specFiles: v.specFiles }), f2p: v.f2p, p2p: v.p2p });
    console.error(`${t.id} yes: ${v.f2p.length} fail-to-pass, ${v.p2p.length} pass-to-pass`);
  }
  spec.validatedAt = new Date().toISOString();
  spec.status = `validated on this machine (${process.platform}, node ${process.version}); ${spec.tasks.filter((x) => x.validated).length} pass so far`;
  writeFileSync(TASKS_FILE, JSON.stringify(spec, null, 2) + "\n");
}
const ok = spec.tasks.filter((t) => t.validated).length;
console.log(`${spec.repo}: ${ok} of ${spec.tasks.length} candidates validated in ${Math.round((Date.now() - started) / 60000)} min → ${relative(REPO_ROOT, TASKS_FILE)}`);
