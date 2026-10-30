// Repeat skip: what an agent already has, unchanged, is not sent again. Any change, another
// agent, or a compaction gets the full text.
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const ENFORCE = { SNOUT_MODE: "enforce" };

function project() {
  const root = mkdtempSync(join(tmpdir(), "snout-repeat-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".snout"), { recursive: true });
  writeFileSync(join(root, "src/big.ts"), Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
  return root;
}

function hook(root, event, payload, env = ENFORCE) {
  const r = spawnSync(process.execPath, [CLI, event], {
    input: JSON.stringify({ session_id: "rtest", cwd: root, ...payload }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const readCall = (root, extra = {}, agent = {}) => ({ tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: join(root, "src/big.ts"), ...extra }, ...agent });
// What Claude Code's Read returns: the window it served.
const fullResponse = { type: "text", file: { filePath: "src/big.ts", startLine: 1, numLines: 400, totalLines: 400 } };
const done = (root, call, response = fullResponse) => hook(root, "post-tool", { ...call, tool_response: response });
const isSkip = (out) => out?.hookSpecificOutput?.updatedInput?.limit === 1 && /unchanged/.test(out.hookSpecificOutput.additionalContext);

test("Claude Code answers exact repeats itself; a narrower window of a file read whole is skipped here", () => {
  const root = project();
  const call = readCall(root);
  assert.ok(!isSkip(hook(root, "pre-tool", call)), "first read is full");
  done(root, call);
  assert.ok(!isSkip(hook(root, "pre-tool", call)), "an exact repeat is left to Claude Code's own 'file unchanged'");
  const again = hook(root, "pre-tool", readCall(root, { offset: 100, limit: 50 }));
  assert.ok(isSkip(again), JSON.stringify(again));
  assert.match(again.hookSpecificOutput.additionalContext, /read the whole file .*which includes lines 100–149/);
  assert.equal(again.hookSpecificOutput.permissionDecision, "allow", "never an error the agent has to route around");
  const row = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find((r) => r.rule === "repeat-read");
  assert.ok(row.tokensAvoidedEst > 200, "the skipped tokens are counted as saved");
});

test("an edit, another agent or a compaction all get a full read", () => {
  const root = project();
  const call = readCall(root);
  const part = readCall(root, { offset: 10, limit: 20 });
  hook(root, "pre-tool", call);
  done(root, call);

  // another agent (a subagent has its own context)
  assert.ok(!isSkip(hook(root, "pre-tool", readCall(root, { offset: 10, limit: 20 }, { agent_id: "sub-1", agent_type: "Explore" }))));
  assert.ok(isSkip(hook(root, "pre-tool", part)));

  // the file changed (the agent's own edit bumps mtime)
  writeFileSync(join(root, "src/big.ts"), readFileSync(join(root, "src/big.ts"), "utf8") + "\nexport const extra = 1;");
  assert.ok(!isSkip(hook(root, "pre-tool", part)), "changed file reads in full");
  done(root, call, { type: "text", file: { startLine: 1, numLines: 401, totalLines: 401 } });
  assert.ok(isSkip(hook(root, "pre-tool", part)), "and is skipped again once re-read");

  // compaction replaces the conversation with a summary
  hook(root, "pre-compact", {});
  assert.ok(!isSkip(hook(root, "pre-tool", part)), "after compaction the next read is full");
});

test("a partial read covers only the lines it returned, and failed reads are never remembered", () => {
  const root = project();
  const ranged = readCall(root, { offset: 50, limit: 30 });
  hook(root, "pre-tool", ranged);
  done(root, ranged, { type: "text", file: { startLine: 50, numLines: 30, totalLines: 400 } });
  assert.ok(isSkip(hook(root, "pre-tool", readCall(root, { offset: 60, limit: 10 }))), "inside the window read: skipped");
  assert.ok(!isSkip(hook(root, "pre-tool", readCall(root, { offset: 70, limit: 30 }))), "runs past it: full");
  assert.ok(!isSkip(hook(root, "pre-tool", readCall(root))), "the whole file was never read: full");

  const root2 = project();
  const call = readCall(root2);
  hook(root2, "pre-tool", call);
  done(root2, call, "Error: file not readable");
  assert.ok(!isSkip(hook(root2, "pre-tool", readCall(root2, { offset: 1, limit: 5 }))), "a failed read is not 'already seen'");
});

test("printing a file with cat after reading it, or cat twice, is stopped with a pointer", () => {
  const root = project();
  const cat = { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "cat src/big.ts" } };
  assert.equal(hook(root, "pre-tool", cat)?.hookSpecificOutput?.permissionDecision, undefined, "first cat runs");
  hook(root, "post-tool", { ...cat, tool_response: { stdout: readFileSync(join(root, "src/big.ts"), "utf8"), stderr: "", interrupted: false } });
  const second = hook(root, "pre-tool", cat);
  assert.equal(second.hookSpecificOutput.permissionDecision, "deny");
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /unchanged since you read it in full/);
  assert.ok(isSkip(hook(root, "pre-tool", readCall(root, { offset: 5, limit: 5 }))), "a cat counts as a whole-file read");

  const root2 = project();
  const call = readCall(root2);
  hook(root2, "pre-tool", call);
  done(root2, call);
  assert.equal(hook(root2, "pre-tool", cat).hookSpecificOutput.permissionDecision, "deny", "cat after Read");
  assert.equal(hook(root2, "pre-tool", cat, { SNOUT_MODE: "observe" })?.hookSpecificOutput?.permissionDecision, undefined, "observe never blocks");
});

test("an identical MCP or command result is replaced with a pointer to the earlier copy", () => {
  const root = project();
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, title: `Issue ${i}`, body: "x".repeat(30) }));
  const mcp = { tool_name: "mcp__issues__list_issues", tool_use_id: "m1", tool_input: { state: "open" }, tool_response: [{ type: "text", text: JSON.stringify(rows) }] };
  assert.equal(hook(root, "squeeze", mcp)?.hookSpecificOutput?.updatedToolOutput?.[0]?.text?.startsWith("snout: identical"), undefined, "first result passes");
  assert.doesNotMatch(JSON.stringify(hook(root, "squeeze", mcp) ?? {}), /identical to this tool/, "same call id: not a repeat");
  const again = hook(root, "squeeze", { ...mcp, tool_use_id: "m2" });
  assert.match(again.hookSpecificOutput.updatedToolOutput[0].text, /identical to this tool's result/);
  const other = hook(root, "squeeze", { ...mcp, tool_use_id: "m3", tool_response: [{ type: "text", text: JSON.stringify(rows.slice(1)) }] });
  assert.doesNotMatch(JSON.stringify(other ?? {}), /identical to this tool/, "a different result passes");
  assert.doesNotMatch(JSON.stringify(hook(root, "squeeze", { ...mcp, tool_use_id: "m4", agent_id: "sub-2" }) ?? {}), /identical to this tool/, "another agent's context is separate");

  const out = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts:12: const value = compute(${i})`).join("\n");
  const grep = { tool_name: "Bash", tool_use_id: "g1", tool_input: { command: "grep -rn compute src" }, tool_response: { stdout: out, stderr: "", interrupted: false } };
  hook(root, "squeeze", grep);
  assert.doesNotMatch(JSON.stringify(hook(root, "squeeze", grep) ?? {}), /same output/, "the same call seen twice (two matching hook entries) is not a repeat");
  assert.match(hook(root, "squeeze", { ...grep, tool_use_id: "g2" }).hookSpecificOutput.updatedToolOutput.stdout, /same output as when you ran this command/);
  const rule = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.rule === "repeat-output");
  assert.equal(rule.length, 2);
});

test("a touched-but-identical mtime change still forces a full read, and the config switch turns it off", () => {
  const root = project();
  const call = readCall(root);
  hook(root, "pre-tool", call);
  done(root, call);
  const t = new Date(Date.now() + 5000);
  utimesSync(join(root, "src/big.ts"), t, t);
  assert.ok(!isSkip(hook(root, "pre-tool", call)), "mtime moved: full read");

  const root2 = project();
  writeFileSync(join(root2, ".snout/config.json"), JSON.stringify({ repeatReads: false }));
  const c2 = readCall(root2);
  hook(root2, "pre-tool", c2);
  done(root2, c2);
  assert.ok(!isSkip(hook(root2, "pre-tool", c2)), "repeatReads: false disables it");
});

test("a compound command that runs the squeeze hook twice for one call is recorded once", () => {
  const root = project();
  const out = Array.from({ length: 400 }, (_, i) => `ok ${i + 1} - util step ${i} scales and offsets`).join("\n") + "\n# pass 400\n# fail 0\n";
  const call = { tool_name: "Bash", tool_use_id: "dup1", tool_input: { command: "cd app && npm test" }, tool_response: { stdout: out, stderr: "", interrupted: false } };
  const a = hook(root, "squeeze", call);
  const b = hook(root, "squeeze", call);
  assert.ok(a.hookSpecificOutput.updatedToolOutput.stdout.length < out.length, "squeezed");
  assert.equal(b.hookSpecificOutput.updatedToolOutput.stdout.split("\n").length, a.hookSpecificOutput.updatedToolOutput.stdout.split("\n").length, "both runs return the same output");
  const rows = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.rule === "command-output");
  assert.equal(rows.length, 1, "savings are counted once");
});

test("a hook from a subdirectory the agent cd'd into uses the project's .snout, not a new one", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "snout-cd-"));
  mkdirSync(join(root, ".snout"));
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib/app.js"), "export const x = 1;\n");
  const hook = (cwd, env = {}) => spawnSync(process.execPath, [CLI, "post-tool"], {
    input: JSON.stringify({ session_id: "s", cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "u", tool_input: { command: "grep -rn x ." }, tool_response: { stdout: "app.js:1:x", stderr: "" } }),
    encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
  });
  hook(join(root, "lib"));
  assert.ok(!existsSync(join(root, "lib/.snout")), "found the parent's .snout");
  const other = mkdtempSync(join(tmpdir(), "snout-cd2-"));
  mkdirSync(join(other, "pkg"));
  hook(join(other, "pkg"), { CLAUDE_PROJECT_DIR: other });
  assert.ok(!existsSync(join(other, "pkg/.snout")), "CLAUDE_PROJECT_DIR wins for a directory inside it");
});

// Ranged shell prints: the lines they printed are in context, as a Read's would be.
const bash = (command, id = "s1") => ({ tool_name: "Bash", tool_use_id: id, tool_input: { command } });
const ran = (root, call) => hook(root, "post-tool", { ...call, tool_response: { stdout: "…", stderr: "", interrupted: false } });

test("a ranged shell print is remembered: printing lines inside it again is stopped, naming the earlier read", () => {
  const root = project();
  const first = bash("sed -n '100,200p' src/big.ts");
  assert.equal(hook(root, "pre-tool", first)?.hookSpecificOutput?.permissionDecision, undefined, "the first print runs");
  ran(root, first);
  const inside = hook(root, "pre-tool", bash("sed -n '120,150p' src/big.ts", "s2"));
  assert.equal(inside.hookSpecificOutput.permissionDecision, "deny");
  assert.match(inside.hookSpecificOutput.permissionDecisionReason, /unchanged since turn \d+, when you read lines 100–200 of it, which include lines 120–150/);
  assert.equal(hook(root, "pre-tool", bash("sed -n '150,260p' src/big.ts", "s3"))?.hookSpecificOutput?.permissionDecision, undefined, "lines never printed run");
  assert.equal(hook(root, "pre-tool", bash("sed -n '1,50p' src/big.ts | grep v1", "s4"))?.hookSpecificOutput?.permissionDecision, undefined, "a pipe is not a plain print");
  const row = readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find((r) => r.rule === "repeat-read");
  assert.ok(row.tokensAvoidedEst > 50 && row.tokensAvoidedEst < 400, `the window's tokens are counted, not the file's: ${row.tokensAvoidedEst}`);
});

test("a Read of lines a shell printed is skipped even in Claude Code, which only knows its own Reads", () => {
  const root = project();
  const head = bash("head -n 80 src/big.ts");
  hook(root, "pre-tool", head);
  ran(root, head);
  const same = hook(root, "pre-tool", readCall(root, { offset: 1, limit: 80 }));
  assert.ok(isSkip(same), JSON.stringify(same));
  assert.match(same.hookSpecificOutput.additionalContext, /read lines 1–80 earlier/);
  assert.ok(isSkip(hook(root, "pre-tool", readCall(root, { offset: 10, limit: 5 }))));
  assert.ok(!isSkip(hook(root, "pre-tool", readCall(root, { offset: 70, limit: 30 }))), "lines past what head printed are read");
});

test("lines of a file read whole are stopped; once the file is edited they are printed again, and observe never blocks", () => {
  const root = project();
  const call = readCall(root);
  hook(root, "pre-tool", call);
  done(root, call);
  assert.equal(hook(root, "pre-tool", bash("head -n 30 src/big.ts")).hookSpecificOutput.permissionDecision, "deny", "lines of a file read whole");
  assert.equal(hook(root, "pre-tool", bash("head -n 30 src/big.ts"), { SNOUT_MODE: "observe" })?.hookSpecificOutput?.permissionDecision, undefined, "observe never blocks");
  writeFileSync(join(root, "src/big.ts"), readFileSync(join(root, "src/big.ts"), "utf8") + "\nexport const more = 1;\n");
  assert.equal(hook(root, "pre-tool", bash("head -n 30 src/big.ts"))?.hookSpecificOutput?.permissionDecision, undefined, "edited since: printed again");
});

test("an image read again is answered with a pointer, since a limit can't shorten an image", () => {
  const root = project();
  writeFileSync(join(root, "shot.png"), Buffer.alloc(4096, 1));
  const img = { tool_name: "Read", tool_use_id: "i1", tool_input: { file_path: join(root, "shot.png") } };
  assert.equal(hook(root, "pre-tool", img)?.hookSpecificOutput?.permissionDecision, undefined, "the first look is a real read");
  hook(root, "post-tool", { ...img, tool_response: { type: "image", file: { base64: "AAAA", type: "image/png", originalSize: 4096 } } });
  const again = hook(root, "pre-tool", img);
  assert.equal(again.hookSpecificOutput.permissionDecision, "deny");
  assert.match(again.hookSpecificOutput.permissionDecisionReason, /shot\.png` is unchanged since you read it in full .*instead of reading it again/);
});

test("Codex on Windows: Get-Content with -TotalCount or Select-Object -Skip -First counts as those lines", async () => {
  const { powerShellRangeRead, rangeRead } = await import("../dist/lib.mjs");
  const root = project();
  const f = join(root, "src/big.ts");
  assert.deepEqual(powerShellRangeRead("Get-Content -LiteralPath src/big.ts -TotalCount 40", root), { abs: f, window: "1:40" });
  assert.deepEqual(powerShellRangeRead("Get-Content src/big.ts | Select-Object -Skip 99 -First 20", root), { abs: f, window: "100:20" });
  assert.deepEqual(powerShellRangeRead('pwsh.exe -NoProfile -Command "Get-Content src/big.ts -Head 5"', root), { abs: f, window: "1:5" });
  assert.equal(powerShellRangeRead("Get-Content src/big.ts | Select-String foo", root), null);
  assert.deepEqual(rangeRead("sed -n 7p src/big.ts", root), { abs: f, window: "7:1" });
  assert.deepEqual(rangeRead("head -25 src/big.ts", root), { abs: f, window: "1:25" });
  assert.equal(rangeRead("sed -i 's/a/b/' src/big.ts", root), null, "an in-place edit is no read");
  assert.equal(rangeRead("head -c 100 src/big.ts", root), null, "bytes are not lines");
  assert.equal(rangeRead("sed -n '1,5p' src/missing.ts", root), null);
});
