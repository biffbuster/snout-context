import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trimMcp } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

const issues = () => JSON.stringify(Array.from({ length: 60 }, (_, i) => ({
  number: 1000 + i, title: `Checkout fails when cart has ${i} items`, state: i % 3 ? "open" : "closed",
  user: { login: `dev${i}`, id: i }, labels: [{ name: "bug" }, { name: "checkout" }],
  body: `Steps to reproduce:\n1. Add ${i} items\n2. Click checkout\n` + "Stack trace line ".repeat(40),
})), null, 2);

const snapshot = () => [
  "- document:", "  - banner:", "    - link \"Home\"",
  ...Array.from({ length: 400 }, (_, i) => i % 5 ? "    - generic: \"\"" : `    - listitem: "Product ${i}"`),
  "  - button \"Checkout\"",
].join("\n");

test("a GitHub issue list keeps its first 20 issues, each shortened, and says how many were left out", () => {
  const t = trimMcp([{ type: "text", text: issues() }], ".snout/squeeze/x.json");
  assert.ok(t);
  const data = JSON.parse(t.output[0].text);
  assert.equal(data.length, 21);
  assert.equal(data[0].number, 1000);
  assert.match(data[20], /40 more items \(60 total\)/);
  assert.match(data[0].body, /… \(\d+ chars\)$/);
  assert.equal(data[0].user.login, "dev0", "structure and short fields are kept");
  assert.match(t.output.at(-1).text, /Full result: \.snout\/squeeze\/x\.json/);
  assert.ok(t.afterChars < t.beforeChars * 0.3, `cut to ${Math.round((t.afterChars / t.beforeChars) * 100)}%`);
});

test("a browser snapshot collapses repeated lines and keeps the rest", () => {
  const t = trimMcp({ content: [{ type: "text", text: snapshot() }] }, "x.json");
  assert.ok(t);
  assert.ok(Array.isArray(t.output.content), "the { content } shape is kept");
  const text = t.output.content[0].text;
  assert.match(text, /button "Checkout"/);
  assert.match(text, /listitem: "Product 395"/);
  assert.match(text, /\(\+3 identical\)/);
});

test("small results, images, results over Claude Code's cap and non-MCP shapes pass through", () => {
  assert.equal(trimMcp([{ type: "text", text: "ok" }], "x"), null);
  const img = { type: "image", data: "iVBOR".repeat(5000), mimeType: "image/png" };
  const t = trimMcp([img, { type: "text", text: issues() }], "x");
  assert.deepEqual(t.output[0], img, "images are never touched");
  assert.equal(trimMcp([{ type: "text", text: "x\n".repeat(60_000) }], "x"), null, "over MAX_MCP_OUTPUT_TOKENS: Claude Code handles it");
  assert.equal(trimMcp({ stdout: "x".repeat(9000) }, "x"), null);
});

function hook(root, payload, mode = "enforce") {
  mkdirSync(join(root, ".snout"), { recursive: true });
  writeFileSync(join(root, ".snout/config.json"), JSON.stringify({ mode }));
  const r = spawnSync(process.execPath, [CLI, "squeeze"], { input: JSON.stringify({ session_id: "s", cwd: root, hook_event_name: "PostToolUse", ...payload }), encoding: "utf8" });
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test("the hook trims an MCP result in its own shape, saves the full result, and records the saving", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-mcp-"));
  const out = hook(root, { tool_name: "mcp__github__list_issues", tool_input: { repo: "acme/shop" }, tool_response: [{ type: "text", text: issues() }] });
  const u = out.hookSpecificOutput.updatedToolOutput;
  assert.ok(Array.isArray(u) && u[0].type === "text");
  assert.equal(JSON.parse(u[0].text).length, 21);
  const saved = readdirSync(join(root, ".snout/squeeze"));
  assert.equal(saved.length, 1);
  assert.equal(JSON.parse(JSON.parse(readFileSync(join(root, ".snout/squeeze", saved[0]), "utf8")).output[0].text).length, 60, "the full result is on disk");
  const row = JSON.parse(readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").trim().split("\n").pop());
  assert.equal(row.rule, "mcp-output");
  assert.equal(row.path, "mcp: github › list_issues");
  assert.ok(row.tokensAvoidedEst > 2000);
  assert.equal(hook(mkdtempSync(join(tmpdir(), "snout-mcp-")), { tool_name: "mcp__github__list_issues", tool_response: [{ type: "text", text: issues() }] }, "observe"), null, "observe never changes output");
});

test("enforce installs the MCP trim hook for every MCP tool", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-mcp-"));
  spawnSync(process.execPath, [CLI, "mode", "enforce"], { cwd: root, encoding: "utf8" });
  const s = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
  assert.ok(s.hooks.PostToolUse.some((e) => e.matcher === "mcp__.*" && (/snout\.mjs" squeeze/.test(e.hooks[0].command ?? "") || /\/snout\/v1\/squeeze$/.test(e.hooks[0].url ?? ""))));
});
