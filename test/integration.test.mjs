/**
 * Spawns the built CLI exactly as a hook does. This layer exists because the unit tests
 * import dist/lib.mjs and therefore never execute dist/snout.mjs — which is how a double
 * shebang once shipped a bundle that could not load at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/snout.mjs", import.meta.url).pathname;

function project() {
  const root = mkdtempSync(join(tmpdir(), "snout-int-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/app.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ d: "x".repeat(20_000) }));
  writeFileSync(join(root, ".env"), "TOKEN=abc\n");
  return root;
}

function hook(root, event, payload, env = {}) {
  const r = spawnSync(process.execPath, [CLI, event], {
    input: JSON.stringify({ session_id: "itest", cwd: root, ...payload }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const read = (root, rel) => ({ tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: join(root, rel) } });

test("the bundle loads and reports its version", () => {
  const r = spawnSync(process.execPath, [CLI, "version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^snout \d+\.\d+\.\d+/);
});

test("a project's .jev folder from before the rename becomes .snout, history intact", () => {
  const root = project();
  mkdirSync(join(root, ".jev"));
  writeFileSync(join(root, ".jev", "ledger.jsonl"), JSON.stringify({ rule: "lockfile", decision: "allow" }) + "\n");
  hook(root, "pre-tool", read(root, "package-lock.json"));
  assert.ok(!existsSync(join(root, ".jev")), "the old folder is moved, not copied");
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(rows.length, 2, "the old row is kept and the new decision is appended");
});

test("observe mode emits nothing for a lockfile but still records it", () => {
  const root = project();
  assert.equal(hook(root, "pre-tool", read(root, "package-lock.json")), null);
  const ledger = join(root, ".snout", "ledger.jsonl");
  assert.ok(existsSync(ledger), "a decision must be recorded even when nothing is blocked");
  const row = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n")[0]);
  assert.equal(row.rule, "lockfile");
  assert.equal(row.decision, "allow");
  assert.ok(row.tokensAvoidedEst > 1000, "observe mode must still report what it would have saved");
});

test("enforce mode denies a lockfile with a reason that names the override", () => {
  const root = project();
  const out = hook(root, "pre-tool", read(root, "package-lock.json"), { SNOUT_MODE: "enforce" });
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /lockfile/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /snout:allow/);
  assert.ok(out.systemMessage, "the user needs to see that something was blocked");
});

test("a denied read tells the agent how to search instead", () => {
  const root = project();
  const out = hook(root, "pre-tool", read(root, "package-lock.json"), { SNOUT_MODE: "enforce" });
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /grep -n -A3 '"node_modules\/<name>"' package-lock\.json/);
});

const bashCall = (command) => ({ tool_name: "Bash", tool_use_id: "b1", tool_input: { command } });

test("enforce denies printing a flagged file whole with Bash, and points to a search", () => {
  const root = project();
  const out = hook(root, "pre-tool", bashCall("cat package-lock.json"), { SNOUT_MODE: "enforce" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /gated like a Read/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /grep -n/);
  const row = JSON.parse(readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(row.tool, "Bash");
  assert.equal(row.decision, "deny");
  assert.ok(row.tokensAvoidedEst > 1000);
});

test("targeted Bash reads, ordinary files and observe mode are never gated", () => {
  const root = project();
  for (const cmd of ["grep -n x package-lock.json", "head -n 5 package-lock.json", "cat package-lock.json | grep x", "cat src/app.ts", "ls -la"]) {
    assert.equal(hook(root, "pre-tool", bashCall(cmd), { SNOUT_MODE: "enforce" }), null, cmd);
  }
  assert.equal(hook(root, "pre-tool", bashCall("cat package-lock.json"), { SNOUT_MODE: "observe" }), null);
  assert.ok(!existsSync(join(root, ".snout", "ledger.jsonl")), "allowed Bash reads are recorded by PostToolUse, not here");
});

test("a credential printed with Bash asks, with no search hint", () => {
  const root = project();
  const out = hook(root, "pre-tool", bashCall("cat .env"), { SNOUT_MODE: "observe" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /grep/);
});

test("a directory or a file too small to be worth a turn is never gated", () => {
  const root = project();
  mkdirSync(join(root, "vendor", "lib"), { recursive: true });
  writeFileSync(join(root, "vendor", "lib", "tiny.js"), "export const a = 1;\n");
  assert.equal(hook(root, "pre-tool", read(root, "vendor/lib"), { SNOUT_MODE: "enforce" }), null, "directory");
  assert.equal(hook(root, "pre-tool", read(root, "vendor/lib/tiny.js"), { SNOUT_MODE: "enforce" }), null, "tiny file");
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(rows.every((r) => r.decision === "allow"), "recorded, not blocked");
});

test("a small credential file is still gated: secrets are not a token decision", () => {
  const root = project();
  const out = hook(root, "pre-tool", read(root, ".env"), { SNOUT_MODE: "enforce" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("a ranged Read of a flagged file is judged by its window: small passes, large does not", () => {
  const root = project();
  const gen = Array.from({ length: 2000 }, (_, i) => `export function op${i}(http) { return http.request({ path: "/v1/op${i}" }); }`).join("\n");
  writeFileSync(join(root, "src", "client.gen.js"), "// @generated by openapi-generator. DO NOT EDIT.\n" + gen);
  const ranged = (offset, limit) => ({ tool_name: "Read", tool_use_id: "r", tool_input: { file_path: join(root, "src/client.gen.js"), offset, limit } });
  assert.equal(hook(root, "pre-tool", ranged(100, 40), { SNOUT_MODE: "enforce" }), null, "40 lines is a targeted read");
  const big = hook(root, "pre-tool", ranged(1, 1500), { SNOUT_MODE: "enforce" });
  assert.equal(big.hookSpecificOutput.permissionDecision, "deny", "a limit that covers most of the file is still a bulk read");
});

test("enforce trims a whole-file Read of a file with a useful head, in the same turn", () => {
  const root = project();
  const gen = Array.from({ length: 2000 }, (_, i) => `export function op${i}(http) { return http.request({ path: "/v1/op${i}" }); }`).join("\n");
  writeFileSync(join(root, "src", "client.gen.js"), "// @generated by openapi-generator. DO NOT EDIT.\n" + gen);
  const out = hook(root, "pre-tool", read(root, "src/client.gen.js"), { SNOUT_MODE: "enforce" });
  const h = out.hookSpecificOutput;
  assert.equal(h.permissionDecision, "allow", "the read goes ahead, cut down");
  assert.equal(h.updatedInput.offset, 1);
  assert.ok(h.updatedInput.limit >= 5 && h.updatedInput.limit <= 60, `limit ${h.updatedInput.limit}`);
  assert.equal(h.updatedInput.file_path, join(root, "src/client.gen.js"), "the rest of the input is kept");
  assert.match(h.additionalContext, /only lines 1–\d+ of 2001/);
  assert.match(h.additionalContext, /op0 L2, op1 L3/, "the note carries the outline");
  const row = JSON.parse(readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(row.trimmed, true);
  assert.equal(row.decision, "deny", "reports count what was cut as withheld");
  assert.ok(row.tokensReadEst > 0 && row.tokensAvoidedEst > row.tokensReadEst);
});

test("a one-line bundle is denied, not trimmed: its head is the whole file", () => {
  const root = project(); // package-lock.json here is a single 20 KB line
  const out = hook(root, "pre-tool", read(root, "package-lock.json"), { SNOUT_MODE: "enforce" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
});

test("advise mode asks rather than denies", () => {
  const root = project();
  const out = hook(root, "pre-tool", read(root, "package-lock.json"), { SNOUT_MODE: "advise" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("a credential file asks in every mode and is never denied silently", () => {
  for (const mode of ["observe", "advise", "enforce"]) {
    const root = project();
    const out = hook(root, "pre-tool", read(root, ".env"), { SNOUT_MODE: mode });
    assert.ok(out, `mode ${mode} produced no response for a credential file`);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask", `mode ${mode}`);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /credential/);
  }
});

test("ordinary source is silent in every mode", () => {
  for (const mode of ["observe", "advise", "enforce"]) {
    const root = project();
    assert.equal(hook(root, "pre-tool", read(root, "src/app.ts"), { SNOUT_MODE: mode }), null, `mode ${mode}`);
  }
});

test("Grep and Glob are never gated", () => {
  const root = project();
  assert.equal(hook(root, "pre-tool", { tool_name: "Grep", tool_input: { pattern: "x" } }, { SNOUT_MODE: "enforce" }), null);
  assert.equal(hook(root, "pre-tool", { tool_name: "Glob", tool_input: { pattern: "**/*.ts" } }, { SNOUT_MODE: "enforce" }), null);
});

test("a nonexistent file does not break the hook", () => {
  const root = project();
  assert.doesNotThrow(() => hook(root, "pre-tool", read(root, "does/not/exist.ts"), { SNOUT_MODE: "enforce" }));
});

test("malformed stdin does not break the hook", () => {
  const r = spawnSync(process.execPath, [CLI, "pre-tool"], { input: "{ not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});

test("SessionStart never spends the user's tokens on context", () => {
  const root = project();
  const out = hook(root, "session-start", { session_start_reason: "startup" });
  assert.ok(out, "the user should see a status line");
  assert.equal(out.additionalContext, undefined, "a token optimiser must not inject context of its own");
  assert.ok(out.systemMessage, "user-facing text belongs in systemMessage");
});

test("a turn is summarised on Stop", () => {
  const root = project();
  hook(root, "prompt-submit", { prompt: "fix the login bug" });
  hook(root, "pre-tool", read(root, "package-lock.json"));
  hook(root, "stop", {});
  const turns = join(root, ".snout", "turns.jsonl");
  assert.ok(existsSync(turns));
  const row = JSON.parse(readFileSync(turns, "utf8").trim().split("\n").pop());
  assert.equal(row.turn, 1);
  assert.ok(row.tokensAvoidedEst > 0);
});

test("compaction is recorded, because it is the outcome we exist to postpone", () => {
  const root = project();
  hook(root, "pre-compact", { compaction_reason: "auto" });
  const rows = readFileSync(join(root, ".snout", "turns.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).compacted, true);
});

test("/snout:mode persists only what differs from the defaults", () => {
  const root = project();
  const r = spawnSync(process.execPath, [CLI, "mode", "advise"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0);
  const cfg = JSON.parse(readFileSync(join(root, ".snout", "config.json"), "utf8"));
  assert.deepEqual(Object.keys(cfg), ["mode"], "a config file should not restate the defaults");
  assert.equal(cfg.mode, "advise");
});

test("/snout:allow silences a file permanently", () => {
  const root = project();
  spawnSync(process.execPath, [CLI, "allow", "package-lock.json"], { cwd: root, encoding: "utf8" });
  const out = hook(root, "pre-tool", read(root, "package-lock.json"), { SNOUT_MODE: "enforce" });
  assert.equal(out, null, "an allow-listed file must stop being flagged");
});

test("/snout:mode rejects an unknown mode instead of writing it", () => {
  const root = project();
  const r = spawnSync(process.execPath, [CLI, "mode", "banana"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /observe\|advise\|enforce/);
  assert.equal(existsSync(join(root, ".snout", "config.json")), false);
});

test("doctor runs with no ledger at all", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-empty-"));
  const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /snout/);
  assert.match(r.stdout, /blocking hook/);
});

test("REGRESSION: every rapid sequential invocation is recorded (EAGAIN on stdin)", () => {
  // `readFileSync(0)` lost ~57% of payloads here. Anything below 100% means the hook is
  // silently doing nothing, and every number the plugin reports is then wrong.
  const root = project();
  const N = 25;
  for (let i = 0; i < N; i++) hook(root, "pre-tool", read(root, "package-lock.json"));
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(rows.length, N, `only ${rows.length} of ${N} payloads were read`);
});

test("REGRESSION: a read-only command creates no state where it is run", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-ro-"));
  for (const cmd of ["version", "help", "report", "statusline", "status"]) {
    spawnSync(process.execPath, [CLI, cmd], { cwd: root, encoding: "utf8" });
  }
  assert.equal(existsSync(join(root, ".snout")), false, "a read-only command must leave no trace");
});

test("REGRESSION: a hook event with an unreadable payload writes nothing anywhere", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-nopayload-"));
  const r = spawnSync(process.execPath, [CLI, "pre-tool"], { cwd: root, input: "", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  // Without `cwd` from the payload we cannot know the project, so guessing would misroute
  // the ledger into whatever directory the process happened to start in.
  assert.equal(existsSync(join(root, ".snout")), false);
});

test("PostToolUse records a classification without any blocking hook installed", () => {
  const root = project();
  hook(root, "prompt-submit", { prompt: "look at the lockfile" });
  const out = hook(root, "post-tool", {
    tool_name: "Read",
    tool_use_id: "t9",
    tool_input: { file_path: join(root, "package-lock.json") },
    tool_response: { type: "text", file: { filePath: "package-lock.json", content: "x".repeat(4000) } },
  });
  assert.equal(out, null, "the recording path must never emit a permission decision");
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rule, "lockfile");
  assert.equal(rows[0].observedOnly, true, "a row written after the read must say so");
  assert.equal(rows[0].decision, "allow", "nothing was blocked, so nothing may claim to have been");
});

test("PostToolUse sizes a read by what it returned, not by the whole file", () => {
  const root = project();
  const whole = readFileSync(join(root, "package-lock.json"), "utf8").length;
  hook(root, "post-tool", {
    tool_name: "Read",
    tool_use_id: "t10",
    tool_input: { file_path: join(root, "package-lock.json") },
    tool_response: { type: "text", file: { filePath: "package-lock.json", content: "x".repeat(500) } },
  });
  const row = JSON.parse(readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim());
  assert.equal(row.bytes, 500, "a ranged read must not be counted as the whole file");
  assert.ok(row.bytes < whole);
});

test("a gated read is not double-counted by the recording hook", () => {
  const root = project();
  hook(root, "prompt-submit", { prompt: "x" });
  hook(root, "pre-tool", read(root, "package-lock.json"), { SNOUT_MODE: "enforce" });
  hook(root, "post-tool", {
    tool_name: "Read",
    tool_use_id: "t11",
    tool_input: { file_path: join(root, "package-lock.json") },
    tool_response: { type: "text", file: { filePath: "package-lock.json", content: "x".repeat(100) } },
  });
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const forFile = rows.filter((r) => r.path === "package-lock.json");
  assert.equal(forFile.length, 1, `expected one row, got ${forFile.length}: ${JSON.stringify(forFile.map((r) => r.rule))}`);
  assert.equal(forFile[0].observedOnly, undefined);
});

test("doctor flags a mode that cannot act because the blocking hook is absent", () => {
  const root = project();
  const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8", env: { ...process.env, SNOUT_MODE: "enforce" } });
  assert.match(r.stdout, /not installed/);
  assert.match(r.stdout, /nothing can be/);
});

test("doctor flags a blocking hook that is installed but idle", () => {
  const root = project();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read|NotebookRead|Bash", hooks: [{ type: "command", command: 'node "x/dist/snout.mjs" pre-tool' }] }] } }),
  );
  const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(r.stdout, /installed \(PreToolUse\)/);
  assert.match(r.stdout, /costs a process per read/);
});

test("doctor reads the split layout /snout:mode installs: Read entry plus if-filtered Bash handlers", () => {
  const root = project();
  mkdirSync(join(root, ".claude"), { recursive: true });
  const h = (extra = {}) => ({ type: "command", command: 'node "x/dist/snout.mjs" pre-tool', ...extra });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [
      { matcher: "Read|NotebookRead", hooks: [h()] },
      { matcher: "Bash", hooks: [h({ if: "Bash(cat *)" }), h({ if: "Bash(less *)" })] },
    ] } }),
  );
  const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(r.stdout, /installed \(PreToolUse\)/);
  assert.doesNotMatch(r.stdout, /Bash is not gated/);
});

test("snout mode enforce installs the gate itself, keeps other hooks, and observe removes it", () => {
  const root = project();
  mkdirSync(join(root, ".claude"), { recursive: true });
  const mine = { matcher: "Write", hooks: [{ type: "command", command: "echo mine" }] };
  writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [mine] } }));
  spawnSync(process.execPath, [CLI, "mode", "enforce"], { cwd: root, encoding: "utf8" });
  const on = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8"));
  const [kept, read, bash] = on.hooks.PreToolUse;
  assert.deepEqual(kept, mine, "the user's own hook is untouched");
  assert.equal(read.matcher, "Read|NotebookRead");
  assert.match(read.hooks[0].command, /node ".*snout\.mjs" pre-tool/);
  assert.ok(!read.hooks[0].command.includes("${CLAUDE_PLUGIN_ROOT}"), "project settings get an absolute path");
  assert.equal(bash.matcher, "Bash");
  assert.ok(bash.hooks.every((x) => /^Bash\(\w+ \*\)$/.test(x.if)), "every Bash handler is if-filtered");
  assert.ok(bash.hooks.some((x) => x.if === "Bash(cat *)") && !bash.hooks.some((x) => /git|npm|rg|ls/.test(x.if)));
  assert.match(spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" }).stdout, /installed \(PreToolUse\)/);

  spawnSync(process.execPath, [CLI, "mode", "enforce"], { cwd: root, encoding: "utf8" });
  assert.equal(JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")).hooks.PreToolUse.length, 3, "re-running does not duplicate");

  spawnSync(process.execPath, [CLI, "mode", "observe"], { cwd: root, encoding: "utf8" });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")).hooks.PreToolUse, [mine]);
});

test("session start re-points a gate left behind by a plugin update", () => {
  const root = project();
  mkdirSync(join(root, ".claude"), { recursive: true });
  const stale = 'node "/old/plugin/0.1.0/dist/snout.mjs" pre-tool';
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read|NotebookRead", hooks: [{ type: "command", command: stale }] }] } }));
  hook(root, "session-start", {});
  const shared = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(shared.hooks, undefined, "the stale entry is gone");
  const local = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8"));
  assert.ok(local.hooks.PreToolUse[0].hooks[0].command.includes(CLI), "and the gate points at this bundle");
});

test("doctor flags a blocking hook installed before Bash was gated", () => {
  const root = project();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read|NotebookRead", hooks: [{ type: "command", command: 'node "x/dist/snout.mjs" pre-tool' }] }] } }),
  );
  const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(r.stdout, /Bash is not gated/);
});

// ---------------------------------------------------------------- bash ingress

const bash = (command, content) => ({
  tool_name: "Bash",
  tool_use_id: "b1",
  tool_input: { command },
  tool_response: { stdout: content, stderr: "", interrupted: false },
});

test("a lockfile read through Bash lands in the ledger", () => {
  const root = project();
  hook(root, "post-tool", bash("cat package-lock.json", "x".repeat(20_000)));
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1, "the read happened; exactly one row must record it");
  assert.equal(rows[0].rule, "lockfile", "classification must not depend on which tool read the file");
  assert.equal(rows[0].tool, "Bash");
  assert.equal(rows[0].path, "package-lock.json");
  assert.ok(rows[0].observedOnly, "nothing was gated — the read already happened");
});

test("Bash rows are billed for what was returned, not what the file holds", () => {
  const root = project();
  // `head -c 200` on a 20 KB lockfile costs 200 bytes of context, and counting the file
  // would inflate every total on the report.
  hook(root, "post-tool", bash("head -c 200 package-lock.json", "y".repeat(200)));
  const row = JSON.parse(readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim());
  assert.equal(row.bytes, 200);
});

test("a multi-file Bash read splits the result across the files it named", () => {
  const root = project();
  hook(root, "post-tool", bash("cat package-lock.json src/app.ts", "z".repeat(1000)));
  const rows = readFileSync(join(root, ".snout", "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.path).sort(), ["package-lock.json", "src/app.ts"]);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  assert.ok(Math.abs(total - 1000) <= 2, `split must conserve the result length, got ${total}`);
  const lock = rows.find((r) => r.path === "package-lock.json");
  assert.ok(lock.bytes > rows.find((r) => r.path === "src/app.ts").bytes, "the larger file takes the larger share");
});

test("a Bash command that reads nothing writes nothing", () => {
  const root = project();
  hook(root, "post-tool", bash("npm test", "all passed"));
  hook(root, "post-tool", bash("rm -f notes.md", ""));
  assert.equal(existsSync(join(root, ".snout", "ledger.jsonl")), false, "no read, no row");
});

// ---------------------------------------------------------------- registration evidence

test("doctor distinguishes 'never fired' from 'fired and found nothing'", () => {
  const root = project();

  // Before any hook runs, doctor must say so in as many words. The failure this guards
  // against is a silent one: an unregistered plugin looks exactly like a quiet session.
  const cold = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /HOOKS SEEN/);
  assert.match(cold.stdout, /none — no hook has ever run/);

  // A session start alone: hooks are firing, nothing has been classified.
  hook(root, "session-start", {});
  const warm = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.doesNotMatch(warm.stdout, /none — no hook has ever run/);
  assert.match(warm.stdout, /session-start\s+\d+s ago/);
  assert.match(warm.stdout, /post-tool\s+never/);
  // The read path is the one that classifies, so its silence is called out by name.
  assert.match(warm.stdout, /post-tool has never run/);
  // No turn has finished, so the session may simply not have read anything yet.
  assert.match(warm.stdout, /nothing has used the Read tool yet/);
  assert.doesNotMatch(warm.stdout, /predates the/);

  // A finished turn with still no post-tool: now Bash reads are the likely cause.
  hook(root, "stop", {});
  const idle = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(idle.stdout, /predates the\n?\s*Bash matcher|predates the/);
  assert.doesNotMatch(idle.stdout, /nothing has used the Read tool yet/);

  hook(root, "post-tool", read(root, "package-lock.json"));
  const hot = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(hot.stdout, /post-tool\s+\d+s ago/);
  assert.doesNotMatch(hot.stdout, /post-tool has never run/);
});

test("every hook event leaves a heartbeat, including ones that classify nothing", () => {
  const root = project();
  hook(root, "session-start", {});
  hook(root, "prompt-submit", { prompt: "hello" });
  hook(root, "stop", {});

  const lines = readFileSync(join(root, ".snout/hooks.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => JSON.parse(l).event), ["session-start", "prompt-submit", "stop"]);
});

test("a subagent's agent id is recorded on the heartbeat when the payload carries one", () => {
  const root = project();
  hook(root, "post-tool", { ...read(root, "package-lock.json"), agent_id: "a-7", agent_type: "Explore" });

  const row = JSON.parse(readFileSync(join(root, ".snout/hooks.jsonl"), "utf8").trim());
  assert.equal(row.agentId, "a-7");
  assert.equal(row.agentType, "Explore");
});

test("doctor names which copy of the plugin is running", () => {
  const root = project();
  const r = spawnSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(r.stdout, /bundle\s+.*snout\.mjs\s+\(local checkout\)/);
});

test("the report covers the current session unless asked for all of them", () => {
  const root = project();
  const post = (session, rel) => hook(root, "post-tool", { ...read(root, rel), session_id: session });
  hook(root, "session-start", { session_id: "one" });
  post("one", "package-lock.json");
  hook(root, "session-start", { session_id: "two" });
  post("two", "src/app.ts");

  const report = (...args) => spawnSync(process.execPath, [CLI, "report", ...args], { cwd: root, encoding: "utf8" }).stdout;
  const current = report();
  assert.match(current, /this session · 1 read/);
  assert.doesNotMatch(current, /lockfile/, "an earlier session's read leaked into this one");
  assert.match(current, /1 more row\(s\) from earlier sessions/);

  const all = report("--all");
  assert.match(all, /all sessions · 2 read/);
  assert.match(all, /lockfile/);
});

test("ledger rows carry the subagent that made the read, and the report splits by agent", () => {
  const root = project();
  hook(root, "session-start", {});
  hook(root, "post-tool", read(root, "src/app.ts"));
  hook(root, "post-tool", { ...read(root, "package-lock.json"), tool_use_id: "t2", agent_id: "agent-aaaa1111", agent_type: "Explore" });

  const rows = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows[0].agentId, undefined, "main-loop rows stay unchanged");
  assert.equal(rows[1].agentId, "agent-aaaa1111");
  assert.equal(rows[1].agentType, "Explore");

  const report = spawnSync(process.execPath, [CLI, "report", "--by-agent"], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(report, /BY AGENT/);
  assert.match(report, /Explore agent-aa/);
  assert.match(report, /main/);
});

test("two agents reading the same file in the same turn are two reads", () => {
  const root = project();
  hook(root, "session-start", {});
  // Subagent A goes through the blocking hook; subagent B's read is only observed afterwards.
  hook(root, "pre-tool", { ...read(root, "package-lock.json"), agent_id: "A" });
  hook(root, "post-tool", { ...read(root, "package-lock.json"), tool_use_id: "t9", agent_id: "B" });

  const rows = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.agentId), ["A", "B"], "B's read was deduplicated against A's");
});

test("two subagents reading the same lockfile show up as redundancy, end to end", () => {
  const root = project();
  hook(root, "session-start", {});
  hook(root, "post-tool", { ...read(root, "package-lock.json"), tool_use_id: "a", agent_id: "agent-one", agent_type: "Explore" });
  hook(root, "post-tool", { ...read(root, "package-lock.json"), tool_use_id: "b", agent_id: "agent-two", agent_type: "Explore" });
  hook(root, "post-tool", { ...read(root, "src/app.ts"), tool_use_id: "c", agent_id: "agent-two", agent_type: "Explore" });

  const rows = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => typeof r.fp === "string" && r.range === ":"), "every row needs a fingerprint and range");

  const report = spawnSync(process.execPath, [CLI, "report", "--by-agent"], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(report, /1 of 3 read\(s\) \(33%\) repeated a read another agent had already made/);
  assert.match(report, /`package-lock\.json`\s+re-read 1×/);
});

// ---------------------------------------------------------------- search, web, MCP ingress

test("the documented tool_response shapes all yield the returned text", async () => {
  const { responseText } = await import("../dist/lib.mjs");
  assert.equal(responseText({ type: "text", text: "a" }), "a");
  assert.equal(responseText({ file: { content: "b" } }), "b");
  assert.equal(responseText({ stdout: "c", stderr: "d" }), "cd");
  assert.equal(responseText({ mode: "content", content: "e" }), "e");
  assert.equal(responseText({ result: "f" }), "f");
  assert.equal(responseText({ filenames: ["g", "h"] }), "g\nh");
  assert.equal(responseText([{ type: "text", text: "i" }, { type: "text", text: "j" }]), "i\nj");
  assert.equal(responseText({ content: [{ type: "text", text: "k" }] }), "k");
  assert.equal(responseText(undefined), "");
});

test("Grep content output is split by file and each file classified", () => {
  const root = project();
  const lock = join(root, "package-lock.json");
  const app = join(root, "src/app.ts");
  const out = [`${lock}:1:{"d":"xxxx"}`, `${lock}:2:"more"`, "--", `${app}:1:export const a = 1;`, "Found 3 matches"].join("\n");
  hook(root, "post-tool", { tool_name: "Grep", tool_use_id: "g1", tool_input: { pattern: "x", output_mode: "content" }, tool_response: { mode: "content", content: out } });

  const rows = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(byPath["package-lock.json"].rule, "lockfile", "grep matches from a lockfile are lockfile waste");
  assert.equal(byPath["package-lock.json"].bytes, Buffer.byteLength(`${lock}:1:{"d":"xxxx"}\n${lock}:2:"more"\n`));
  assert.equal(byPath["src/app.ts"].tool, "Grep");
  const rest = rows.find((r) => r.rule === "tool-output");
  assert.ok(rest, "the separator and summary line are tool output, not pinned on a file");
});

test("Grep files mode, Glob, WebFetch and MCP are measured as tool output, never flagged", () => {
  const root = project();
  hook(root, "session-start", {});
  hook(root, "post-tool", { tool_name: "Grep", tool_use_id: "g2", tool_input: { pattern: "x" }, tool_response: { mode: "files_with_matches", filenames: ["a.ts", "b.ts"] } });
  hook(root, "post-tool", { tool_name: "Glob", tool_use_id: "g3", tool_input: { pattern: "**/*.ts" }, tool_response: { filenames: ["src/app.ts"] } });
  hook(root, "post-tool", { tool_name: "WebFetch", tool_use_id: "w1", tool_input: { url: "https://example.com/doc" }, tool_response: { result: "y".repeat(3000) } });
  hook(root, "post-tool", { tool_name: "mcp__db__query", tool_use_id: "m1", tool_input: {}, tool_response: [{ type: "text", text: "z".repeat(2000) }] });

  const rows = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.tool), ["Grep", "Glob", "WebFetch", "mcp__db__query"]);
  assert.ok(rows.every((r) => r.rule === "tool-output" && r.tokensAvoidedEst === 0));
  assert.equal(rows[2].path, "https://example.com/doc");
  assert.equal(rows[2].bytes, 3000);

  const report = spawnSync(process.execPath, [CLI, "report"], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(report, /Search, web and MCP output added ~[\d.]+k? more \(Grep, Glob, WebFetch, MCP\): measured, not classified/);
  assert.doesNotMatch(report, /tool-output/, "tool output must not appear as a class");
});

// ---------------------------------------------------------------- apply and user defaults

const lockReads = (root, n) => {
  for (let i = 0; i < n; i++) hook(root, "post-tool", { ...read(root, "package-lock.json"), tool_use_id: `l${i}`, session_id: `s${i}` });
};
const snout = (root, args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, SNOUT_HOME: join(root, ".home"), ...env } }).stdout;

test("apply previews a change and writes nothing without --yes", () => {
  const root = project();
  lockReads(root, 3);
  const list = snout(root, ["apply"]);
  assert.match(list, /1\. Tell the agent to stop reading package-lock\.json/);
  assert.match(list, /read 3× across 3 session\(s\)/);
  const preview = snout(root, ["apply", "1"]);
  assert.match(preview, /append to CLAUDE\.md:\s+- Don't read `package-lock\.json`: it's a generated lockfile/);
  assert.match(preview, /To apply: snout apply 1 --yes/);
  assert.equal(existsSync(join(root, "CLAUDE.md")), false, "a preview must not write");
});

test("apply --yes appends exactly the previewed line, and --undo removes it", () => {
  const root = project();
  writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
  lockReads(root, 3);
  snout(root, ["apply", "1", "--yes"]);
  const after = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.match(after, /^# Project\n- Don't read `package-lock\.json`/);
  assert.doesNotMatch(snout(root, ["apply"]), /stop reading package-lock/, "a path named in CLAUDE.md gets no second tip");
  assert.match(snout(root, ["apply"]), /APPLIED\n\s+claude-md:package-lock\.json/);

  assert.match(snout(root, ["apply", "--undo"]), /Undone: claude-md:package-lock\.json/);
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# Project\n");
  assert.match(snout(root, ["apply", "--undo"]), /Nothing to undo/);
});

test("undo deletes a CLAUDE.md that apply created", () => {
  const root = project();
  lockReads(root, 3);
  snout(root, ["apply", "1", "--yes"]);
  assert.ok(existsSync(join(root, "CLAUDE.md")));
  snout(root, ["apply", "--undo"]);
  assert.equal(existsSync(join(root, "CLAUDE.md")), false);
});

test("a config write changes one key in one layer, never the merged view", () => {
  const root = project();
  mkdirSync(join(root, ".home"), { recursive: true });
  writeFileSync(join(root, ".home/config.json"), JSON.stringify({ alwaysDeny: ["**/*.lock", "**/go.sum"] }));
  snout(root, ["allow", "docs/big.md"], { SNOUT_MODE: "enforce" });
  const project_ = JSON.parse(readFileSync(join(root, ".snout/config.json"), "utf8"));
  assert.equal(project_.mode, undefined, "an environment override must never be persisted");
  assert.equal(project_.alwaysDeny, undefined, "user defaults must not be copied into the project");
  assert.ok(project_.alwaysAllow.includes("docs/big.md"));
});

test("user defaults apply to every project, and the project file wins key by key", async () => {
  const { loadConfig, resolvePaths } = await import("../dist/lib.mjs");
  const root = project();
  const home = join(root, ".home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ mode: "advise", alwaysDeny: ["**/go.sum"] }));
  const prev = process.env.SNOUT_HOME;
  process.env.SNOUT_HOME = home;
  try {
    assert.equal(loadConfig(resolvePaths(root)).mode, "advise");
    assert.deepEqual(loadConfig(resolvePaths(root)).alwaysDeny, ["**/go.sum"]);
    mkdirSync(join(root, ".snout"), { recursive: true });
    writeFileSync(join(root, ".snout/config.json"), JSON.stringify({ mode: "observe" }));
    assert.equal(loadConfig(resolvePaths(root)).mode, "observe");
    assert.deepEqual(loadConfig(resolvePaths(root)).alwaysDeny, ["**/go.sum"], "keys the project does not set still come from the user file");
  } finally {
    if (prev === undefined) delete process.env.SNOUT_HOME;
    else process.env.SNOUT_HOME = prev;
  }
});

test("the advise tip promises nothing when the blocking hook is absent", () => {
  const root = project();
  lockReads(root, 3);
  const list = snout(root, ["apply"]);
  assert.match(list, /Switch to advise mode/);
  assert.match(list, /effect\s+none until the blocking hook is installed/);
});
