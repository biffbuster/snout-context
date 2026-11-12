// File history notes (memoryFileHistory, opt-in): after a source file's first read in a session, the
// commits that last changed it, from the checkout's own history. Local git repos; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFiles, fileHistoryNotes, FILE_HISTORY_TOKENS, isSourceFile } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const git = (cwd, args, when) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}) } });

/** A repo whose src/looseEqual.ts changed three times in the last months and once two years earlier. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "snout-file-history-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "Dev"]);
  mkdirSync(join(dir, "src", "__tests__"), { recursive: true });
  const commit = (file, text, msg, when) => { writeFileSync(join(dir, file), text); git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", msg], when); };
  commit("src/looseEqual.ts", "v1\n", "shared: add looseEqual", "2024-09-01T10:00:00Z");
  commit("src/looseEqual.ts", "v2\n", "refactor: rename helpers", "2026-07-01T10:00:00Z");
  commit("src/looseEqual.ts", "v3\n", "perf: faster array compare", "2026-09-01T10:00:00Z");
  commit("src/looseEqual.ts", "v4\n", "fix(shared): correctly compare Map and Set", "2026-10-28T10:00:00Z");
  commit("src/__tests__/looseEqual.spec.ts", "t\n", "test: Map cases", "2026-10-29T10:00:00Z");
  commit("README.md", "r\n", "docs", "2026-11-01T10:00:00Z");
  mkdirSync(join(dir, ".snout"), { recursive: true });
  return dir;
}

function post(dir, payload, env = {}) {
  const r = spawnSync(process.execPath, [CLI, "file-history"], {
    input: JSON.stringify({ cwd: dir, session_id: "s1", hook_event_name: "PostToolUse", ...payload }), encoding: "utf8",
    env: { ...process.env, CI: undefined, SNOUT_TOKEN: undefined, SNOUT_MODE: "enforce", SNOUT_MEMORY_FILE_HISTORY: "1", ...env },
  });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "" : "";
}

test("a source file's first read gets its last commits, newest first, from history within the window; never twice", () => {
  const dir = repo();
  const note = post(dir, { tool_name: "Read", tool_input: { file_path: join(dir, "src", "looseEqual.ts") } });
  assert.match(note, /^Snout: recent commits to src\/looseEqual\.ts \(this checkout's history, newest first; records, not a diagnosis\): [0-9a-f]{7,} 2026-10-28 fix\(shared\): correctly compare Map and Set · [0-9a-f]{7,} 2026-09-01 perf: faster array compare · [0-9a-f]{7,} 2026-07-01 refactor: rename helpers$/);
  assert.doesNotMatch(note, /add looseEqual/, "older than the window before HEAD's own date");
  assert.equal(post(dir, { tool_name: "Read", tool_input: { file_path: join(dir, "src", "looseEqual.ts") } }), "", "once per file per session");
  const row = readFileSync(join(dir, ".snout", "recall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.kind === "file-history");
  assert.equal(row.files[0].file, "src/looseEqual.ts");
  assert.equal(row.files[0].commits.length, 3);
});

test("shell reads count, through a cd; tests, docs and other files get no note; off and observe say nothing", () => {
  const dir = repo();
  assert.match(post(dir, { tool_name: "Bash", tool_input: { command: "cd src && sed -n 1,5p looseEqual.ts" } }), /recent commits to src\/looseEqual\.ts/);
  assert.equal(post(dir, { tool_name: "Read", tool_input: { file_path: join(dir, "src", "__tests__", "looseEqual.spec.ts") } }), "", "a test file");
  assert.equal(post(dir, { tool_name: "Read", tool_input: { file_path: join(dir, "README.md") } }), "", "not source code");
  const other = repo();
  assert.equal(post(other, { tool_name: "Read", tool_input: { file_path: join(other, "src", "looseEqual.ts") } }, { SNOUT_MEMORY_FILE_HISTORY: "" }), "", "off by default");
  assert.equal(post(other, { tool_name: "Read", tool_input: { file_path: join(other, "src", "looseEqual.ts") } }, { SNOUT_MODE: "observe" }), "", "observe adds nothing");
});

test("the files a command reads, and what counts as source", () => {
  const dir = repo();
  assert.deepEqual(commandFiles("cd src && grep -n Map looseEqual.ts | head", dir), [join(dir, "src", "looseEqual.ts")]);
  assert.deepEqual(commandFiles("echo nothing.here", dir), []);
  assert.equal(isSourceFile("packages/shared/src/looseEqual.ts"), true);
  assert.equal(isSourceFile("packages/shared/__tests__/looseEqual.spec.ts"), false);
  assert.equal(isSourceFile("src/types.d.ts"), false);
});

test("notes stop at the session's token budget", () => {
  const dir = repo();
  const r = fileHistoryNotes(dir, [join(dir, "src", "looseEqual.ts")], { files: [], tokens: FILE_HISTORY_TOKENS - 5 });
  assert.equal(r.text, "", "no room left");
  assert.deepEqual(r.state.files, ["src/looseEqual.ts"], "the file counts as seen");
});
