import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRequests, codexRequests, costOf, readSpend, claudeSlug, summarizeSpend } from "../dist/lib.mjs";

const CLI = new URL("../dist/snout.mjs", import.meta.url).pathname;
const today = new Date().toISOString().slice(0, 10);

const claudeLine = (o = {}) => JSON.stringify({
  type: "assistant", timestamp: `${today}T10:00:00.000Z`, requestId: "req_1", cwd: o.cwd ?? "/p",
  message: { model: o.model ?? "claude-opus-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: o.output ?? 500, cache_creation: { ephemeral_1h_input_tokens: 600, ephemeral_5m_input_tokens: 400 }, speed: o.speed ?? "standard" } },
  ...(o.requestId ? { requestId: o.requestId } : {}),
});

test("prices follow the published list: Opus 5.5 with 5m and 1h cache writes, and fast mode", () => {
  const u = { input: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 };
  // $4 input, $5 5m write, $8 1h write, $0.20 cache read, $20 output
  assert.equal(costOf("claude-opus-5-5", u), 4 + 5 + 8 + 0.2 + 20);
  // fast: $8/$40, cache multipliers on top of the fast input rate
  assert.equal(costOf("claude-opus-5-5", { ...u, fast: true }), 8 + 10 + 16 + 0.4 + 40);
  assert.equal(costOf("claude-haiku-4-5-20251001", { ...u, cacheWrite5m: 0, cacheWrite1h: 0 }), 1 + 0.1 + 5, "dated snapshots price as their family");
  assert.equal(costOf("gpt-6-astra", { input: 1e6, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1e6, output: 1e6 }), 10 + 1 + 50);
  assert.equal(costOf("some-future-model", u), null);
});

test("a Claude request streamed over several lines counts once, with its final usage", () => {
  const text = [claudeLine({ output: 10 }), claudeLine({ output: 500 }), claudeLine({ requestId: "req_2", model: "claude-sonnet-5" }), "{not json", JSON.stringify({ message: { model: "<synthetic>", usage: { input_tokens: 1 } } })].join("\n");
  const reqs = claudeRequests(text);
  assert.equal(reqs.length, 2);
  const r = reqs.find((x) => x.model === "claude-opus-5-5");
  assert.equal(r.output, 500);
  assert.equal(r.cacheWrite1h, 600);
  assert.equal(r.cacheWrite5m, 400);
});

test("Codex: cached tokens are split out of input, and the model comes from the turn", () => {
  const lines = [
    { type: "session_meta", payload: { cwd: "/work/app" } },
    { type: "turn_context", payload: { model: "gpt-6-astra" } },
    { type: "token_usage_record", timestamp: `${today}T01:00:00Z`, payload: { response_id: "r1", usage: { input_tokens: 14709, cached_input_tokens: 12288, cache_write_input_tokens: 0, output_tokens: 50 } } },
    { type: "token_usage_record", timestamp: `${today}T01:00:01Z`, payload: { response_id: "r1", usage: { input_tokens: 14709, cached_input_tokens: 12288, cache_write_input_tokens: 0, output_tokens: 50 } } },
  ].map((o) => JSON.stringify(o)).join("\n");
  const { cwd, reqs } = codexRequests(lines);
  assert.equal(cwd, "/work/app");
  assert.equal(reqs.length, 1);
  assert.deepEqual([reqs[0].model, reqs[0].input, reqs[0].cacheRead, reqs[0].output], ["gpt-6-astra", 2421, 12288, 50]);
});

test("readSpend finds a project's Claude and Codex sessions; snout spend reports them", () => {
  const home = mkdtempSync(join(tmpdir(), "snout-spend-"));
  const project = join(home, "work", "app");
  mkdirSync(join(project, ".snout"), { recursive: true });
  const claudeDir = join(home, ".claude", "projects", claudeSlug(project));
  mkdirSync(join(claudeDir, "s1", "subagents"), { recursive: true });
  writeFileSync(join(claudeDir, "s1.jsonl"), claudeLine({ cwd: project }) + "\n");
  writeFileSync(join(claudeDir, "s1", "subagents", "a.jsonl"), claudeLine({ cwd: project, requestId: "req_sub", model: "claude-haiku-4-5-20251001" }) + "\n");
  const codexDir = join(home, ".codex", "sessions", "2026", "09", "28");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "rollout-a.jsonl"), [
    { type: "session_meta", payload: { cwd: project } }, { type: "turn_context", payload: { model: "gpt-6-astra" } },
    { type: "token_usage_record", timestamp: `${today}T01:00:00Z`, payload: { response_id: "r1", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } },
  ].map((o) => JSON.stringify(o)).join("\n"));
  writeFileSync(join(codexDir, "rollout-other.jsonl"), [{ type: "session_meta", payload: { cwd: "/elsewhere" } }, { type: "token_usage_record", timestamp: `${today}T01:00:00Z`, payload: { response_id: "x", usage: { input_tokens: 5, output_tokens: 5 } } }].map((o) => JSON.stringify(o)).join("\n"));

  const env = { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
  const old = { ...process.env };
  Object.assign(process.env, env);
  try {
    const spend = readSpend(project, join(home, "cache.json"));
    const rows = spend.get(project);
    assert.deepEqual(rows.map((r) => r.model).sort(), ["claude-haiku-4-5-20251001", "claude-opus-5-5", "gpt-6-astra"], "subagent transcripts count; another project's Codex session does not");
    const s = summarizeSpend(rows);
    assert.equal(s.requests, 3);
    assert.ok(s.costUsd > 0 && s.inputRate > 0);
    // Cached second read agrees with the first.
    assert.deepEqual(readSpend(project, join(home, "cache.json")).get(project), rows);
  } finally {
    process.env = old;
  }
  const out = JSON.parse(spawnSync(process.execPath, [CLI, "spend", "--json"], { cwd: project, encoding: "utf8", env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: project, SNOUT_CONFIG_DIR: join(home, "cfg") } }).stdout);
  assert.equal(out.requests, 3);
  assert.equal(out.byModel.length, 3);
  const all = JSON.parse(spawnSync(process.execPath, [CLI, "spend", "--all", "--json"], { cwd: project, encoding: "utf8", env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: project, SNOUT_CONFIG_DIR: join(home, "cfg") } }).stdout);
  assert.deepEqual(all.projects.map((p) => p.dir).sort(), ["/elsewhere", project].sort(), "--all groups every project on the machine");
});
