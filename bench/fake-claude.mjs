#!/usr/bin/env node
/**
 * A stand-in for `claude -p` that costs nothing: the SWE-bench harness runs it with
 * SWE_FAKE_AGENT=1 to check everything around the agent before a paid run. It fires the hooks in
 * the workspace's .claude/settings.json the way Claude Code does (JSON on stdin, through Git Bash
 * on Windows), feeds them a large Read, a repeat of it and a long passing test run, applies the
 * gold patch from SWE_FAKE_PATCH, and prints Claude Code's JSON result with a nominal cost.
 *
 * What each hook answered is written to stderr, so a dry run shows whether Snout stepped in.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";

const cwd = process.cwd();
const session_id = randomUUID();
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
const settings = existsSync(".claude/settings.json") ? JSON.parse(readFileSync(".claude/settings.json", "utf8")) : {};
const hooks = settings.hooks ?? {};
const BASH = process.platform === "win32"
  ? process.env.CLAUDE_CODE_GIT_BASH_PATH || ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find(existsSync)
  : "bash";
const log = (s) => process.stderr.write(`[fake] ${s}\n`);
const answers = [];

/** Every hook of `event` whose matcher (and `if` rule) fits the tool call; returns their parsed outputs. */
function fire(event, payload) {
  const outs = [];
  for (const entry of hooks[event] ?? []) {
    if (entry.matcher && payload.tool_name && !new RegExp(`^(?:${entry.matcher})$`).test(payload.tool_name)) continue;
    for (const h of entry.hooks ?? []) {
      if (h.type !== "command") continue;
      if (h.if) {
        const m = /^Bash\((\S+) \*\)$/.exec(h.if);
        if (m && !String(payload.tool_input?.command ?? "").startsWith(m[1] + " ")) continue;
      }
      const r = spawnSync(BASH, ["-c", h.command], { cwd, input: JSON.stringify({ session_id, transcript_path: "", cwd, hook_event_name: event, ...payload }), encoding: "utf8", timeout: (h.timeout ?? 60) * 1000 });
      if (r.status !== 0 && r.status !== 2) log(`${event} hook exited ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}`);
      let out = null;
      try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { log(`${event} hook printed non-JSON: ${r.stdout.slice(0, 120)}`); }
      outs.push(out);
    }
  }
  return outs;
}

function biggestPython() {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 6) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".py")) { const s = statSync(p).size; if (!best || s > best.size) best = { p, size: s }; }
    }
  };
  walk(cwd, 0);
  return best?.p;
}

function tool(name, input, response) {
  const pre = fire("PreToolUse", { tool_name: name, tool_input: input });
  const deny = pre.find((o) => o?.hookSpecificOutput?.permissionDecision === "deny");
  if (deny) { answers.push(`${name}: denied`); log(`${name} denied: ${deny.hookSpecificOutput.permissionDecisionReason.slice(0, 120)}`); return; }
  const post = fire("PostToolUse", { tool_name: name, tool_input: input, tool_response: response, tool_use_id: randomUUID() });
  const upd = post.find((o) => o?.hookSpecificOutput?.updatedToolOutput);
  answers.push(`${name}: ${upd ? "trimmed" : "passed"}`);
  log(`${name} ${upd ? `trimmed to ${JSON.stringify(upd.hookSpecificOutput.updatedToolOutput).length} chars from ${JSON.stringify(response).length}` : "passed through"}`);
}

fire("SessionStart", { source: "startup" });
fire("UserPromptSubmit", { prompt });

const big = biggestPython();
if (big) {
  const content = readFileSync(big, "utf8");
  const lines = content.split("\n");
  const resp = { type: "text", file: { filePath: big, content, numLines: lines.length, startLine: 1, totalLines: lines.length } };
  tool("Read", { file_path: big }, resp);
  tool("Read", { file_path: big }, resp); // the repeat
  log(`read ${relative(cwd, big)} (${lines.length} lines) twice`);
}
const passing = Array.from({ length: 300 }, (_, i) => `tests/test_mod.py::test_case_${i} PASSED`).join("\n");
tool("Bash", { command: "python -m pytest -v tests/test_mod.py" }, { stdout: `${passing}\n============ 300 passed in 4.21s ============\n`, stderr: "", interrupted: false, isImage: false });

if (process.env.SWE_FAKE_PATCH && existsSync(process.env.SWE_FAKE_PATCH)) {
  const r = spawnSync("git", ["apply", "--whitespace=nowarn", process.env.SWE_FAKE_PATCH], { cwd, encoding: "utf8" });
  log(r.status === 0 ? "gold patch applied" : `gold patch failed: ${r.stderr.trim().slice(0, 200)}`);
}
fire("Stop", {});

process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: `fake agent: ${answers.join(", ")}`, session_id, num_turns: 4,
  total_cost_usd: 0.001, usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 50 },
}));
