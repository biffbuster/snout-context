// `snout audit context`: inventory, usage, authorship, every flag, the map, archive and restore.
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  auditContext, classifyContextPath, staleRefs, normalize, shingles, overlap, authorOf, readClaudeTranscript,
  renderAudit, renderMap, totals, archiveFiles, restoreArchive, listArchives,
} from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const OLD = "2026-01-05T12:00:00Z";
const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i % 97} word${(i * 7) % 113}`).join(" ");

function put(root, rel, body) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function git(root, args, env = {}) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com", ...env } });
  assert.equal(r.status, 0, r.stderr);
}
const commitAt = (root, msg, date) => git(root, ["commit", "-q", "-m", msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });

/** A project with one of everything the audit should catch, committed months ago. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "snout-ctx-"));
  const home = mkdtempSync(join(tmpdir(), "snout-ctx-home-"));
  git(root, ["init", "-q"]);
  put(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  put(root, "src/app.ts", "export const a = 1;\n");
  put(root, "src/old.ts", "export const gone = 1;\n");
  // A bloated CLAUDE.md that also mentions a deleted file and a missing script.
  put(root, "CLAUDE.md", "# Rules\nRun `npm test` and `npm run lint`. See `src/old.ts` for the legacy path.\n" + words(4000, "rule"));
  // AGENTS.md is a copy of a shared block.
  put(root, "AGENTS.md", "# Shared\n" + words(300, "shared"));
  put(root, "GEMINI.md", "# Shared\n" + words(300, "shared"));
  put(root, ".claude/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy the app to production with the release checklist\n---\n" + words(200, "deploy"));
  put(root, ".claude/skills/lint/SKILL.md", "---\nname: lint\ndescription: >\n  Fix lint errors across the project\n  using the house style\n---\n" + words(200, "lint"));
  put(root, ".claude/commands/ship.md", "---\ndescription: Ship it\n---\nShip the build.\n");
  put(root, "docs/guide.md", "# Guide\n" + words(400, "guide"));
  git(root, ["add", "-A"]);
  commitAt(root, "init", OLD);
  // An AI-written one-off report, committed with an AI trailer, never read again.
  put(root, "IMPLEMENTATION_SUMMARY.md", "# Summary\n" + words(500, "summary"));
  git(root, ["add", "-A"]);
  commitAt(root, "Add summary\n\nCo-Authored-By: Claude <noreply@anthropic.com>", OLD);
  git(root, ["rm", "-q", "src/old.ts"]);
  commitAt(root, "remove old", OLD);
  return { root, home };
}

/** A Claude Code transcript for the fixture: the deploy skill and the guide were used, the summary was written by the agent. */
function transcript(root, home) {
  const dir = join(home, ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const line = (content) => JSON.stringify({ type: "assistant", timestamp: now, message: { content } });
  writeFileSync(join(dir, "s1.jsonl"), [
    line([{ type: "tool_use", id: "1", name: "Skill", input: { skill: "deploy" } }]),
    line([{ type: "tool_use", id: "2", name: "Read", input: { file_path: join(root, "docs/guide.md") } }]),
    line([{ type: "tool_use", id: "3", name: "Write", input: { file_path: join(root, "IMPLEMENTATION_SUMMARY.md"), content: "x" } }]),
    JSON.stringify({ type: "user", timestamp: now, message: { content: "<command-name>/ship</command-name>" } }),
  ].join("\n") + "\n");
}

const byPath = (a) => Object.fromEntries(a.files.map((f) => [f.path, f]));
const codes = (f) => f.flags.map((x) => x.code).sort();

test("context paths are classified per agent convention", () => {
  assert.equal(classifyContextPath("CLAUDE.md").kind, "always");
  assert.equal(classifyContextPath("pkg/CLAUDE.md").kind, "always");
  assert.deepEqual(classifyContextPath("AGENTS.md").agents.includes("codex"), true);
  assert.equal(classifyContextPath(".cursor/rules/style.mdc").agents[0], "cursor");
  assert.equal(classifyContextPath(".github/copilot-instructions.md").kind, "always");
  assert.equal(classifyContextPath(".windsurfrules").kind, "always");
  assert.equal(classifyContextPath(".clinerules/a.md").kind, "always");
  assert.equal(classifyContextPath(".claude/skills/x/SKILL.md").role, "skill");
  assert.equal(classifyContextPath(".claude/commands/a/b.md").role, "command");
  assert.equal(classifyContextPath(".claude/agents/r.md").role, "agent");
  assert.equal(classifyContextPath("notes/PLAN.md").kind, "on-demand");
  assert.equal(classifyContextPath(".github/ISSUE_TEMPLATE/bug.md"), null);
  assert.equal(classifyContextPath("src/app.ts"), null);
});

test("duplicates: normalized text and shingle overlap", () => {
  const a = shingles(normalize("# Title\nRun the TESTS, then ship it to prod now please."));
  const b = shingles(normalize("title: run the tests then ship it to prod now please"));
  assert.equal(overlap(a, b).jaccard, 1);
  const big = shingles(normalize(words(200, "x") + " " + words(200, "y")));
  const part = shingles(normalize(words(200, "x")));
  assert.ok(overlap(part, big).containment > 0.95);
  assert.ok(overlap(part, big).jaccard < 0.6);
});

test("authorship: AI trailers, agent writes, human commits", () => {
  assert.equal(authorOf({ ai: 2, human: 0, first: 0 }, false), "ai");
  assert.equal(authorOf({ ai: 0, human: 3, first: 0 }, false), "human");
  assert.equal(authorOf({ ai: 0, human: 3, first: 0 }, true), "mixed");
  assert.equal(authorOf(undefined, true), "ai");
  assert.equal(authorOf(undefined, false), "unknown");
});

test("transcripts: skills, reads, commands and writes are counted", () => {
  const u = { reads: new Map(), skills: new Map(), commands: new Map(), agents: new Map(), writes: new Set(), codex: [], sources: [] };
  const now = new Date().toISOString();
  readClaudeTranscript([
    JSON.stringify({ timestamp: now, message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "plugin:deploy" } }] } }),
    JSON.stringify({ timestamp: now, message: { content: [{ type: "tool_use", name: "Agent", input: { subagent_type: "reviewer" } }] } }),
    JSON.stringify({ timestamp: now, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/p/a.md" } }] } }),
    JSON.stringify({ timestamp: "2020-01-01T00:00:00Z", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/p/old.md" } }] } }),
    JSON.stringify({ timestamp: now, message: { content: "<command-name>/ship</command-name>" } }),
    "not json",
  ].join("\n"), u, "2026-01-01T00:00:00Z", now);
  assert.equal(u.skills.get("deploy")[0], 1);
  assert.equal(u.agents.get("reviewer")[0], 1);
  assert.equal(u.commands.get("ship")[0], 1);
  assert.ok(u.writes.has("/p/a.md"));
  assert.equal(u.reads.has("/p/old.md"), false, "reads before the window are not usage");
});

test("stale references: deleted files and missing scripts, not examples", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-stale-"));
  put(root, "package.json", JSON.stringify({ scripts: { test: "x" } }));
  put(root, "src/a.ts", "");
  const text = "See `src/old.ts`, `src/a.ts`, `src/example.ts`, `vendor/`, https://x.dev/a.md, `npm run lint` and `npm run test`.";
  assert.deepEqual(staleRefs(text, join(root, "CLAUDE.md"), root, new Set(["src/old.ts", "src/a.ts"])).sort(), ["npm run lint", "src/old.ts"]);
  // Without history, a path counts when its folder exists.
  assert.deepEqual(staleRefs("`src/old.ts` `nope/x.ts`", join(root, "CLAUDE.md"), root).sort(), ["src/old.ts"]);
  // Scripts come from the nearest package.json.
  put(root, "app/package.json", JSON.stringify({ scripts: { dev: "x" } }));
  assert.deepEqual(staleRefs("`npm run dev`", join(root, "app/README.md"), root), []);
});

test("audit: every flag on a project that has one of everything", () => {
  const { root, home } = fixture();
  transcript(root, home);
  const a = auditContext(root, { home, days: 30 });
  const f = byPath(a);

  assert.equal(f["CLAUDE.md"].kind, "always");
  assert.ok(f["CLAUDE.md"].perSession > 2000);
  assert.deepEqual(codes(f["CLAUDE.md"]), ["oversized", "stale"]);
  assert.match(f["CLAUDE.md"].flags.find((x) => x.code === "stale").reason, /src\/old\.ts/);
  assert.match(f["CLAUDE.md"].flags.find((x) => x.code === "stale").reason, /npm run lint/);
  assert.equal(f["CLAUDE.md"].savePerSession, f["CLAUDE.md"].tokens - 2000);

  // AGENTS.md and GEMINI.md are the same text: one of them is flagged, with its per-session cost.
  const dup = ["AGENTS.md", "GEMINI.md"].map((p) => f[p]).filter((x) => codes(x).includes("duplicate"));
  assert.equal(dup.length, 1);
  assert.equal(dup[0].savePerSession, dup[0].perSession);

  // The deploy skill and ship command were used; the lint skill was not.
  assert.equal(f[".claude/skills/deploy/SKILL.md"].uses, 1);
  assert.deepEqual(codes(f[".claude/skills/deploy/SKILL.md"]), []);
  assert.equal(f[".claude/commands/ship.md"].uses, 1);
  assert.deepEqual(codes(f[".claude/skills/lint/SKILL.md"]), ["unused"]);
  assert.ok(f[".claude/skills/lint/SKILL.md"].perSession > 5, "block-scalar description is counted");

  // The AI-written summary nobody read again.
  assert.equal(f["IMPLEMENTATION_SUMMARY.md"].author, "ai");
  assert.deepEqual(codes(f["IMPLEMENTATION_SUMMARY.md"]), ["one-off"]);
  // A human doc that was read stays clean.
  assert.equal(f["docs/guide.md"].uses, 1);
  assert.equal(f["docs/guide.md"].author, "human");
  assert.deepEqual(codes(f["docs/guide.md"]), []);

  // Ranked by tokens per session saved: the oversized CLAUDE.md first.
  assert.equal(a.files[0].path, "CLAUDE.md");
  const t = totals(a);
  assert.equal(t.always.files, 3);
  assert.ok(t.savePerSession >= f["CLAUDE.md"].savePerSession);
  assert.ok(a.sources.some((s) => /Claude Code/.test(s)));
});

test("audit: renders a report and a compact map for an agent", () => {
  const { root, home } = fixture();
  const a = auditContext(root, { home });
  const report = renderAudit(a);
  assert.match(report, /Always loaded\s+3/);
  assert.match(report, /oversized/);
  assert.match(report, /--archive/);
  const map = renderMap(a);
  const rows = map.split("\n").filter((l) => l.includes(" | ") && !l.startsWith("#"));
  assert.ok(rows.length >= a.files.length);
  assert.match(map, /^CLAUDE\.md \| always \| instructions \| \d+ \| \d+ \| - \| - \| human \| oversized/m);
});

test("conflict candidates: instruction files on the same topics, not copies", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-conf-"));
  const home = mkdtempSync(join(tmpdir(), "snout-conf-home-"));
  put(root, "CLAUDE.md", "Always use tabs for indentation. Database migrations run with migrate script. Testing uses vitest framework. Deploy staging before production. Logging uses structured json output. " + words(60, "alpha"));
  put(root, "AGENTS.md", "Never use tabs, indentation uses spaces. Database migrations are manual. Testing uses jest framework. Deploy production directly. Logging uses plain text output. " + words(60, "beta"));
  const a = auditContext(root, { home, noGit: true });
  assert.equal(a.conflictCandidates.length, 1);
  assert.deepEqual([a.conflictCandidates[0].a, a.conflictCandidates[0].b].sort(), ["AGENTS.md", "CLAUDE.md"]);
});

test("archive moves files with a manifest; restore puts them back", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-arch-"));
  put(root, "PLAN.md", "plan");
  put(root, "docs/NOTES.md", "notes");
  const m = archiveFiles(root, ["PLAN.md", "./docs/NOTES.md"], new Date("2026-10-05T10:00:00Z"));
  assert.equal(existsSync(join(root, "PLAN.md")), false);
  assert.equal(readFileSync(join(root, ".snout/archive", m.id, "docs/NOTES.md"), "utf8"), "notes");
  assert.deepEqual(m.files.map((f) => f.path), ["PLAN.md", "docs/NOTES.md"]);
  assert.equal(listArchives(root).length, 1);

  // A file that came back at its old path is never overwritten.
  put(root, "PLAN.md", "new plan");
  const r = restoreArchive(root, m.id);
  assert.deepEqual(r.restored, ["docs/NOTES.md"]);
  assert.deepEqual(r.skipped, ["PLAN.md"]);
  assert.equal(readFileSync(join(root, "PLAN.md"), "utf8"), "new plan");
  assert.equal(readFileSync(join(root, "docs/NOTES.md"), "utf8"), "notes");

  rmSync(join(root, "PLAN.md"));
  assert.deepEqual(restoreArchive(root, m.id).restored, ["PLAN.md"]);
  assert.equal(readFileSync(join(root, "PLAN.md"), "utf8"), "plan");
  assert.equal(listArchives(root).length, 0, "a fully restored archive is retired");
});

test("archive refuses paths outside the project, .git, .snout and missing files", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-arch2-"));
  put(root, "a.md", "a");
  assert.throws(() => archiveFiles(root, ["../x.md"]), /outside the project/);
  assert.throws(() => archiveFiles(root, [".snout/x"]), /can't be archived/);
  assert.throws(() => archiveFiles(root, ["nope.md"]), /not a file/);
  assert.throws(() => restoreArchive(root, "../../etc"), /no archive/);
  assert.equal(existsSync(join(root, "a.md")), true);
});

test("cli: audit context reports, archives only with --yes, and restores", () => {
  const { root, home } = fixture();
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
  const run = (...a) => spawnSync(process.execPath, [CLI, "audit", "context", ...a], { cwd: root, encoding: "utf8", env, timeout: 30_000 });
  const report = run();
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /flagged/);
  const json = JSON.parse(run("--json").stdout);
  assert.ok(json.files.every((f) => !("abs" in f)), "absolute paths stay out of --json");
  assert.ok(json.totals.flagged >= 4);

  const noConfirm = run("--archive", "IMPLEMENTATION_SUMMARY.md");
  assert.match(noConfirm.stdout, /Not moved/);
  assert.equal(existsSync(join(root, "IMPLEMENTATION_SUMMARY.md")), true);
  const yes = run("--archive", "IMPLEMENTATION_SUMMARY.md", "--yes");
  assert.match(yes.stdout, /Archived to \.snout\/archive\//);
  assert.equal(existsSync(join(root, "IMPLEMENTATION_SUMMARY.md")), false);
  const id = /--restore (\S+)/.exec(yes.stdout)[1];
  assert.match(run("--restore").stdout, new RegExp(id));
  assert.match(run("--restore", id).stdout, /Restored 1 file/);
  assert.equal(existsSync(join(root, "IMPLEMENTATION_SUMMARY.md")), true);
});

test("mcp: snout_audit_context returns the map, read-only", () => {
  const { root, home } = fixture();
  const input = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "snout_audit_context", arguments: { format: "map" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "snout_audit_context", arguments: {} } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const r = spawnSync(process.execPath, [CLI, "mcp", root], { input, encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") } });
  const replies = Object.fromEntries(r.stdout.trim().split("\n").map((l) => JSON.parse(l)).map((x) => [x.id, x]));
  assert.match(replies[1].result.content[0].text, /^# Agent context map/);
  assert.match(replies[1].result.content[0].text, /CLAUDE\.md \| always/);
  assert.match(replies[2].result.content[0].text, /flagged/);
  assert.equal(existsSync(join(root, ".snout/archive")), false);
});

test("a symlinked CLAUDE.md is one file; a copy for another agent costs no session twice", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "snout-link-"));
  const home = mkdtempSync(join(tmpdir(), "snout-link-home-"));
  put(root, "AGENTS.md", "# Shared\n" + words(3000, "shared"));
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  let f = byPath(auditContext(root, { home, noGit: true }));
  assert.equal(f["CLAUDE.md"].linkTo, "AGENTS.md");
  assert.deepEqual(codes(f["CLAUDE.md"]), []);
  assert.deepEqual(codes(f["AGENTS.md"]), ["oversized"]);
  const a = auditContext(root, { home, noGit: true });
  assert.equal(totals(a).always.perSession, f["AGENTS.md"].tokens, "per agent, not summed across agents");

  // A real copy instead of a link: flagged so the copies don't drift, but no per-session saving.
  rmSync(join(root, "CLAUDE.md"));
  put(root, "CLAUDE.md", readFileSync(join(root, "AGENTS.md"), "utf8"));
  f = byPath(auditContext(root, { home, noGit: true }));
  const dup = [f["CLAUDE.md"], f["AGENTS.md"]].find((x) => codes(x).includes("duplicate"));
  assert.match(dup.flags.find((x) => x.code === "duplicate").reason, /different agents/);
  assert.equal(dup.savePerSession, dup.tokens - 2000, "only the oversized part counts");
});

test("one-off needs a one-time sign; living docs, per-folder instructions and plain-doc stale refs aren't flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-rules-"));
  const home = mkdtempSync(join(tmpdir(), "snout-rules-home-"));
  git(root, ["init", "-q"]);
  put(root, "src/gone.ts", "x");
  put(root, "docs/plans/2026-01-04-auth-fix-plan.md", "# Plan\n" + words(300, "plan"));
  put(root, "docs/adr/0007-review-process.md", "# ADR\n" + words(300, "adr"));
  put(root, "docs/architecture-review.md", "# Review\n" + words(300, "arch"));
  put(root, "chat-ui/AGENTS.md", "# App\n" + words(200, "app"));
  put(root, "admin-ui/AGENTS.md", "# App\n" + words(200, "app"));
  put(root, "docs/history.md", "Moved from `src/gone.ts` and `src/gone.ts`.\n" + words(100, "h"));
  git(root, ["add", "-A"]);
  commitAt(root, "plans\n\nCo-Authored-By: Claude <noreply@anthropic.com>", OLD);
  git(root, ["rm", "-q", "src/gone.ts"]);
  commitAt(root, "rm", OLD);
  const f = byPath(auditContext(root, { home, noUsage: true }));
  assert.deepEqual(codes(f["docs/plans/2026-01-04-auth-fix-plan.md"]), ["one-off"]);
  assert.equal(f["docs/plans/2026-01-04-auth-fix-plan.md"].flags[0].action, "review");
  assert.deepEqual(codes(f["docs/adr/0007-review-process.md"]), [], "an ADR is a living decision record");
  assert.deepEqual(codes(f["docs/architecture-review.md"]), [], "no date or reports folder: not a one-off");
  assert.deepEqual(codes(f["chat-ui/AGENTS.md"]), []);
  assert.deepEqual(codes(f["admin-ui/AGENTS.md"]), [], "each folder's AGENTS.md serves its own folder");
  assert.deepEqual(codes(f["docs/history.md"]), [], "stale refs only count in instructions agents follow");
});

test("every flag carries an action; nothing is suggested for archiving outright", () => {
  const { root, home } = fixture();
  const a = auditContext(root, { home });
  const actions = {};
  for (const f of a.files) for (const fl of f.flags) actions[fl.code] = fl.action;
  assert.equal(actions.oversized, "trim");
  assert.equal(actions.stale, "fix");
  assert.equal(actions.unused, "review");
  assert.equal(actions["one-off"], "review");
  assert.ok(a.files.every((f) => f.flags.every((x) => x.action !== "archive")));
  assert.match(renderAudit(a), /Review before archiving/);
});

test("stale skips workspace-targeted scripts, workspace scripts and gitignored runtime files", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-stale2-"));
  const home = mkdtempSync(join(tmpdir(), "snout-stale2-home-"));
  git(root, ["init", "-q"]);
  put(root, ".gitignore", "dist/\n.state/\n");
  put(root, "package.json", JSON.stringify({ scripts: { test: "x" } }));
  put(root, "apps/web/package.json", JSON.stringify({ scripts: { storybook: "x" } }));
  put(root, "dist/keep.txt", "x");
  put(root, ".state/keep.txt", "x");
  put(root, "src/gone.ts", "x");
  put(root, "CLAUDE.md", "Run `npm run -w apps/web dev`, `npm run storybook`, `npm run deploy`. Built to `dist/cli.js`; state in `.state/intent.json`; old code in `src/gone.ts`.\n");
  git(root, ["add", "-A"]);
  commitAt(root, "init", OLD);
  git(root, ["rm", "-q", "src/gone.ts"]);
  commitAt(root, "rm", OLD);
  const f = byPath(auditContext(root, { home, noUsage: true }));
  const stale = f["CLAUDE.md"].flags.find((x) => x.code === "stale");
  assert.ok(stale);
  assert.match(stale.reason, /npm run deploy/);
  assert.match(stale.reason, /src\/gone\.ts/);
  assert.doesNotMatch(stale.reason, /storybook|-w|dist\/cli|intent\.json/);
});
