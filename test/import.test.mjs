// First-run import: git log, PRs and CI runs through gh, and past Claude Code and Codex sessions,
// read into dated records that search cites and --as-of cuts. A stand-in gh; nothing touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimImport, githubNudge, importHistory, readHistory, readImportState, scrub, REDACTED, REFRESH_MS } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
// Fake credentials, split so secret scanners don't flag the source.
const GH_TOKEN_TEXT = "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789";
const ANT_KEY = "sk-ant" + "-api03-abcdefghijklmnopqrstuvwx";

function git(cwd, args, env = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function commit(cwd, file, text, message, daysAgo) {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, ["add", "-A"]);
  const when = iso(daysAgo);
  git(cwd, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * A project with two commits, a stand-in gh, and one Claude Code and one Codex session that worked on it.
 * `linked`: the sessions ran in another spelling of the folder, through a symlink (macOS /var is /private/var).
 */
function fixture({ linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "snout-import-"));
  const proj = join(root, "proj");
  mkdirSync(proj);
  let seen = proj;
  if (linked) {
    mkdirSync(join(root, "via"));
    seen = join(root, "via", "proj");
    symlinkSync(proj, seen, "junction");
  }
  git(proj, ["init", "-q", "-b", "main"]);
  git(proj, ["config", "user.email", "dev@example.com"]);
  git(proj, ["config", "user.name", "Dev"]);
  commit(proj, ".github/workflows/ci.yml", "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n", "Add CI workflow", 20);
  const shard = commit(proj, ".github/workflows/ci.yml", "name: ci\non: push\njobs:\n  test:\n    strategy:\n      matrix:\n        shard: [1, 2]\n", `Shard tests 4 to 2\n\nFewer shards. Deploy token=${GH_TOKEN_TEXT} was in the old config.`, 10);

  // gh stand-in: answers the read commands import makes, and logs each one.
  const log = join(root, "gh-calls.log");
  const gh = join(root, "gh.mjs");
  const prs = [{
    number: 12, title: "Shard CI tests 4 to 2", body: "Cuts CI time. The suite now runs in 2 shards.", author: { login: "dev" },
    createdAt: iso(10.5), mergedAt: iso(9), closedAt: iso(9), updatedAt: iso(9), url: "https://github.com/acme/proj/pull/12",
    files: { nodes: [{ path: ".github/workflows/ci.yml" }] }, headRefName: "shard", baseRefName: "main", state: "MERGED",
    reviews: { nodes: [{ author: { login: "lead" }, state: "APPROVED", body: "Watch the timeout: each shard now runs twice as long." }] },
    comments: { nodes: [] }, commits: { nodes: [{ commit: { oid: shard } }] }, mergeCommit: { oid: shard }, closingIssuesReferences: { nodes: [{ number: 7 }] },
  }, {
    // Last changed before the import's window: the page stops here.
    number: 3, title: "Old work", body: "", url: "https://github.com/acme/proj/pull/3", state: "CLOSED", createdAt: iso(300), closedAt: iso(299), updatedAt: iso(299),
  }];
  const page = { data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: prs } } } };
  const runs = [
    { databaseId: 501, workflowName: "ci", displayTitle: "Shard CI tests 4 to 2", conclusion: "timed_out", createdAt: iso(5), updatedAt: iso(5), headBranch: "main", headSha: shard, event: "push", url: "https://github.com/acme/proj/actions/runs/501" },
    { databaseId: 502, workflowName: "ci", displayTitle: "Docs", conclusion: "success", createdAt: iso(4), updatedAt: iso(4), headBranch: "main", headSha: shard, event: "push", url: "https://github.com/acme/proj/actions/runs/502" },
  ];
  const jobs = { jobs: [{ name: "test (2)", conclusion: "failure", startedAt: iso(5), completedAt: new Date(NOW - 5 * DAY + 30 * 60_000).toISOString(), steps: [{ name: "Run tests", conclusion: "cancelled" }, { name: "Set up job", conclusion: "success" }] }] };
  writeFileSync(gh, `import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (a[0] === "repo" && a[1] === "view") console.log(JSON.stringify({ owner: { login: "acme" }, name: "proj" }));
else if (a[0] === "api" && a[1] === "graphql" && a.includes("owner=acme") && a.includes("name=proj")) console.log(${JSON.stringify(JSON.stringify(page))});
else if (a[0] === "run" && a[1] === "list") console.log(${JSON.stringify(JSON.stringify(runs))});
else if (a[0] === "run" && a[1] === "view") console.log(${JSON.stringify(JSON.stringify(jobs))});
else { console.error("unexpected gh call"); process.exit(2); }
`);

  // A Claude Code session that made the shard commit, and asked with a key pasted in.
  const claude = join(root, "claude");
  const slugDir = join(claude, "projects", resolve(seen).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(slugDir, { recursive: true });
  const claudeId = "5df00e86-f2da-438b-a97b-2d88a133483f";
  const row = (o, daysAgo) => JSON.stringify({ ...o, timestamp: iso(daysAgo), sessionId: claudeId, cwd: seen, gitBranch: "shard" });
  writeFileSync(join(slugDir, `${claudeId}.jsonl`), [
    row({ type: "user", message: { role: "user", content: `Shard the CI tests from 4 to 2 to cut queue time. My key is ${ANT_KEY} if needed.` } }, 10.6),
    row({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git commit -am 'Shard tests 4 to 2'" } }] } }, 10.55),
    row({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `[shard ${shard.slice(0, 7)}] Shard tests 4 to 2\n 1 file changed` }] } }, 10.5),
    row({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Sharded the CI tests into 2 shards and committed it." }] } }, 10.5),
  ].join("\n") + "\n");

  // A Codex session in the same folder, and one in another folder that must be left out.
  const codex = join(root, "codex");
  const day = join(codex, "sessions", "2026", "10", "20");
  mkdirSync(day, { recursive: true });
  const cx = (type, payload, daysAgo) => JSON.stringify({ timestamp: iso(daysAgo), type, payload });
  const codexId = "01a1479a-b229-7ee1-bb55-6b1cb6e6e05a";
  writeFileSync(join(day, `rollout-2026-10-20T08-00-00-${codexId}.jsonl`), [
    cx("session_meta", { id: codexId, cwd: seen }, 3),
    cx("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Raise the CI job timeout to 45 minutes" }] }, 3),
  ].join("\n") + "\n");
  writeFileSync(join(day, "rollout-2026-10-20T09-00-00-01a1479a-0000-7ee1-bb55-6b1cb6e6e05b.jsonl"), [
    cx("session_meta", { id: "01a1479a-0000-7ee1-bb55-6b1cb6e6e05b", cwd: join(root, "elsewhere") }, 2),
    cx("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Unrelated work in another repo" }] }, 2),
  ].join("\n") + "\n");

  const cfg = join(root, "cfg");
  const env = { ...process.env, SNOUT_CONFIG_DIR: cfg, SNOUT_GH: gh, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, SNOUT_IMPORT: "off", CI: "" };
  delete env.SNOUT_TOKEN;
  return { root, proj, cfg, env, log, shard, claudeId, codexId };
}

const snout = (f, args, env = f.env) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: f.proj, encoding: "utf8", env, input: "" });
  return { out: r.stdout + r.stderr, status: r.status };
};

/** The gh stand-in's calls, each as its arguments. */
const ghCalls = (f) => readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Every file under a folder, as bytes: the index too, where SQLite keeps the text it holds. */
function allBytes(dir) {
  let out = "";
  for (const e of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(e));
    try { if (statSync(p).isFile()) out += readFileSync(p, "latin1"); } catch { /* gone */ }
  }
  return out;
}

test("import reads commits, PRs, failed runs and past sessions, linked, and search cites them", () => {
  const f = fixture();
  const first = snout(f, ["import"]);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /Imported this project's history/);
  assert.match(first.out, /2 commits, 1 PR, 1 failed CI run, 2 past sessions new/);
  assert.match(first.out, /2 credentials found in that text and replaced/);

  // gh was only asked to read.
  const calls = ghCalls(f);
  assert.ok(calls.every((c) => ["repo view", "api graphql", "run list", "run view"].includes(c.slice(0, 2).join(" "))), JSON.stringify(calls));
  const queries = calls.filter((c) => c[1] === "graphql");
  assert.equal(queries.length, 1, "the page with a PR older than the window is the last one read");
  assert.ok(queries.every((c) => c[3].startsWith("query=query(") && !/\bmutation\b/.test(c[3])), "a query, never a mutation");

  const ci = snout(f, ["memory", "search", "why is CI timing out"]);
  assert.match(ci.out, /run:501 {2}CI run timed out/);
  const shard = snout(f, ["memory", "search", "shard tests"]);
  assert.match(shard.out, /pr:12 {2}PR #12 merged/);
  assert.match(shard.out, new RegExp(`commit:${f.shard.slice(0, 10)}`));
  assert.match(shard.out, new RegExp(`session:${f.claudeId}`));

  // The PR names the session that made its commit; the run names its job and workflow file.
  const pr = snout(f, ["memory", "fetch", "pr:12"]);
  assert.match(pr.out, new RegExp(`Made in: session:${f.claudeId}`));
  assert.match(pr.out, /Watch the timeout/);
  assert.match(pr.out, /Closes #7/);
  assert.match(pr.out, /Source: https:\/\/github.com\/acme\/proj\/pull\/12/);
  const run = snout(f, ["memory", "fetch", "run:501"]);
  assert.match(run.out, /Job "test \(2\)" failed after 30 min: "Run tests" cancelled/);
  assert.match(run.out, /\.github\/workflows\/ci\.yml/);
  // What changed it: the run's commit, that commit's PR and session, and the earlier change to the workflow file.
  assert.ok(run.out.includes(`Commit: ${f.shard.slice(0, 7)} `) && run.out.includes(`"Shard tests 4 to 2" (PR #12) · made in session:${f.claudeId}`), run.out);
  assert.match(run.out, /Last changes to \.github\/workflows\/ci\.yml before this run: .*; \w{7} \S+ "Add CI workflow"/);

  // The Claude session's card holds the commit it made; the other folder's Codex session is not here.
  const card = JSON.parse(readFileSync(join(f.proj, ".snout", "memory", `${f.claudeId}.json`), "utf8"));
  assert.equal(card.via, "import");
  assert.equal(card.branch, "shard");
  assert.deepEqual(card.commits.map((k) => k.sha), [f.shard]);
  assert.deepEqual(readdirSync(join(f.proj, ".snout", "memory")).sort(), [`${f.codexId}.json`, `${f.claudeId}.json`].sort());
});

test("a PR number or a sha is a question on its own", () => {
  const f = fixture();
  snout(f, ["import"]);
  const byNumber = snout(f, ["memory", "search", "PR #12"]);
  assert.match(byNumber.out, /^1 of 1 match/);
  assert.match(byNumber.out, /- pr:12 /);
  assert.match(snout(f, ["memory", "search", `what did ${f.shard.slice(0, 7)} change`]).out, new RegExp(`- commit:${f.shard.slice(0, 10)} `));
  // A record that names the PR answers too: the run's title is the PR's, not its number, so it does not.
  assert.doesNotMatch(byNumber.out, /run:501/);
  assert.match(snout(f, ["memory", "search", "PR #99"]).out, /Nothing in memory matches/);
});

test("no credential reaches a record, a session card or the index", () => {
  const f = fixture();
  snout(f, ["import"]);
  snout(f, ["memory", "search", "shard tests"]); // builds the index
  for (const dir of [f.cfg, join(f.proj, ".snout")]) {
    const bytes = allBytes(dir);
    assert.ok(!bytes.includes(GH_TOKEN_TEXT), `token in ${dir}`);
    assert.ok(!bytes.includes(ANT_KEY), `key in ${dir}`);
  }
  assert.match(snout(f, ["memory", "fetch", `commit:${f.shard.slice(0, 10)}`]).out, /token=\[redacted\]/);
});

test("--as-of hides what came later: the PR before its merge, the run, a session not yet started", () => {
  const f = fixture();
  snout(f, ["import"]);
  const before = snout(f, ["memory", "search", "shard tests", "--as-of", iso(9.5)]);
  assert.doesNotMatch(before.out, /pr:12/, "the PR merged after the cut");
  assert.match(before.out, new RegExp(`commit:${f.shard.slice(0, 10)}`));
  assert.doesNotMatch(snout(f, ["memory", "search", "why is CI timing out", "--as-of", iso(6)]).out, /run:501/);
  assert.doesNotMatch(snout(f, ["memory", "search", "shard tests", "--as-of", iso(15)]).out, /session:|pr:12|commit:/);
  assert.match(snout(f, ["memory", "fetch", "pr:12", "--as-of", iso(9.5)]).out, /No pr:12 on record/);
});

test("a rerun reads only what is new, and a record seen twice is one record", () => {
  const f = fixture();
  snout(f, ["import"]);
  const again = snout(f, ["import"]);
  assert.match(again.out, /Updated this project's history/);
  assert.match(again.out, /0 commits, 0 PRs, 0 failed CI runs, 0 past sessions new · 4 records kept/);
  commit(f.proj, "README.md", "hello\n", "Add a readme", 0);
  assert.match(snout(f, ["import"]).out, /1 commit, 0 PRs, 0 failed CI runs, 0 past sessions new · 5 records kept/);
  // The run's jobs were read once; a rerun that skips them keeps them.
  assert.match(snout(f, ["memory", "fetch", "run:501"]).out, /Job "test \(2\)"/);
  assert.equal(ghCalls(f).filter((c) => c[0] === "run" && c[1] === "view").length, 1);
});

test("without gh: git and sessions only, and it says why", () => {
  const f = fixture();
  const r = snout(f, ["import"], { ...f.env, SNOUT_GH: "snout-no-such-gh-program" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /2 commits, 0 PRs, 0 failed CI runs, 2 past sessions new/);
  assert.match(r.out, /GitHub: gh is not installed; PRs and CI runs are read with gh once it is installed and logged in/);
  assert.match(snout(f, ["import", "--no-gh", "--no-sessions"]).out, /GitHub: left out/);
});

test("sessions that ran in a symlinked spelling of the folder are this project's (macOS /var is /private/var)", () => {
  const f = fixture({ linked: true });
  const r = snout(f, ["import", "--no-gh"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /2 commits, 0 PRs, 0 failed CI runs, 2 past sessions new/);
  // The Codex session in another folder is still left out.
  assert.deepEqual(readdirSync(join(f.proj, ".snout", "memory")).sort(), [`${f.codexId}.json`, `${f.claudeId}.json`].sort());
});

test("a commit amended or rebased away leaves memory, and the stash never enters it", () => {
  const f = fixture();
  snout(f, ["import", "--no-gh"]);
  writeFileSync(join(f.proj, "wip.txt"), "half done\n");
  git(f.proj, ["add", "wip.txt"]);
  git(f.proj, ["stash"]);
  git(f.proj, ["commit", "-q", "--amend", "-m", "Shard tests 4 to 2, with a longer timeout"]);
  const amended = git(f.proj, ["rev-parse", "HEAD"]);
  const r = snout(f, ["import", "--no-gh"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 commit no branch has any more \(rebased or amended\) removed/);
  const found = snout(f, ["memory", "search", "shard tests"]).out;
  assert.match(found, new RegExp(`commit:${amended.slice(0, 10)}`));
  assert.doesNotMatch(found, new RegExp(`commit:${f.shard.slice(0, 10)}`), "the sha before the amend is cited nowhere");
  assert.ok(!allBytes(f.cfg).includes("WIP on main"), "the stash is not history");
});

test("the background run prints nothing, never calls gh unless asked, and frees its claim", () => {
  const f = fixture();
  const r = snout(f, ["import", "--background"]);
  assert.equal(r.out, "");
  assert.throws(() => readFileSync(f.log, "utf8"), /ENOENT/, "gh is not called without the user asking");
  assert.match(snout(f, ["import", "status"]).out, /Last import .* 2 transcripts read · GitHub: left out .* daily GitHub import off/);
  assert.match(snout(f, ["memory", "search", "shard tests"]).out, /commit:/);
  const project = readdirSync(join(f.cfg, "history"))[0];
  assert.deepEqual(readdirSync(join(f.cfg, "history", project)).filter((n) => n === "running"), [], "the claim is freed");

  // With the daily GitHub import on, the background run reads PRs and runs too.
  assert.match(snout(f, ["import", "github", "on"]).out, /Daily GitHub import on/);
  snout(f, ["import", "--background"]);
  assert.ok(ghCalls(f).some((c) => c[0] === "api"), "gh read once opted in");
  assert.match(snout(f, ["import", "status"]).out, /GitHub read \d{4}-\d\d-\d\d · daily GitHub import on/);
  assert.match(snout(f, ["import", "github", "off"]).out, /Daily GitHub import off/);
});

test("on a GitHub repo, the user is told once that snout import adds PRs and CI runs", () => {
  const f = fixture();
  const start = () => {
    const r = spawnSync(process.execPath, [CLI, "session-start"], { cwd: f.proj, encoding: "utf8", env: f.env, input: JSON.stringify({ session_id: "n1", cwd: f.proj, source: "startup" }) });
    return JSON.parse(r.stdout);
  };
  assert.doesNotMatch(start().systemMessage, /snout import/, "nothing before an import");
  snout(f, ["import", "--background"]);
  assert.doesNotMatch(start().systemMessage, /snout import/, "no GitHub remote: nothing to offer");

  git(f.proj, ["remote", "add", "origin", "https://github.com/acme/shard.git"]);
  snout(f, ["import", "--background"]);
  const once = start();
  assert.match(once.systemMessage, /Snout read 2 commits and 2 past sessions from this project\. Run snout import to add PRs and failed CI runs from GitHub \(read only, with your gh login\)/);
  assert.doesNotMatch(JSON.stringify(once.hookSpecificOutput ?? {}), /snout import/, "the user's line, not the agent's context");
  assert.doesNotMatch(start().systemMessage, /snout import/, "said once");

  // After GitHub was read, a fresh project state has nothing to offer either.
  const g = fixture();
  git(g.proj, ["remote", "add", "origin", "git@github.com:acme/shard.git"]);
  snout(g, ["import"]);
  const project = readdirSync(join(g.cfg, "history"))[0];
  assert.equal(readImportState(g.cfg, project).githubRemote, true);
  assert.equal(githubNudge(g.cfg, project), null);
});

test("the size cap drops the oldest records first", () => {
  const f = fixture();
  const key = "capped";
  const r = importHistory({ project: key, projectDir: f.proj, snoutDir: join(f.proj, ".snout"), configDir: f.cfg, github: false, sessions: false, max: 1, env: f.env });
  assert.equal(r.dropped, 1);
  const kept = readHistory(join(f.cfg, "history", key, "records"));
  assert.deepEqual(kept.map((x) => x.title), ["Shard tests 4 to 2"]);
});

test("a background import is claimed once, and again when the last one is a day old", () => {
  const cfg = mkdtempSync(join(tmpdir(), "snout-import-claim-"));
  assert.equal(claimImport(cfg, "p1"), true);
  assert.equal(claimImport(cfg, "p1"), false, "a second session start must not start a second import");
  assert.equal(claimImport(cfg, "p2"), true);
  // An import finished an hour ago: not again today. A day later: once more.
  mkdirSync(join(cfg, "history", "p3"), { recursive: true });
  writeFileSync(join(cfg, "history", "p3", "import.json"), JSON.stringify({ v: 1, last: new Date(NOW - 3_600_000).toISOString(), sessions: {} }));
  assert.equal(claimImport(cfg, "p3", NOW), false);
  assert.equal(claimImport(cfg, "p3", NOW + REFRESH_MS), true);
  assert.equal(claimImport(cfg, "p3", NOW + REFRESH_MS), false);
});

test("scrub replaces credentials and leaves ordinary text alone", () => {
  assert.equal(scrub(`key ${ANT_KEY} end`), `key ${REDACTED} end`);
  assert.equal(scrub("password: hunter2hunter2"), `password: ${REDACTED}`);
  assert.equal(scrub("https://bob:s3cretpw@github.com/x"), `https://bob:${REDACTED}@github.com/x`);
  assert.equal(scrub("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"), REDACTED);
  assert.equal(scrub("Raise the token budget to 600 and fix the secret-handling docs"), "Raise the token budget to 600 and fix the secret-handling docs");
});
