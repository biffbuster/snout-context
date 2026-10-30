// Automatic notes (opt-in, `snout memory notes on`): an approved lesson that fits a task reaches the
// prompt without a search, for Claude Code and Codex alike; nothing does when nothing clears the bar;
// a prompt gets three at most; and the session-start line names lessons by where they apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addObservation, approveLesson, checkProposals, memoryHint, proposeLesson, storesFor, userPrincipal, MAX_PROMPT_NOTES } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const PASS = { command: "node --test", result: "ℹ pass 12" };
const RULE = "A retry of a charge reuses the invoice's original idempotency key; a new key per try charged customers twice when a timed-out try had gone through.";
const APPLIES = "retrying a charge in chargeline (src/billing.js chargeInvoice, or any later retry of a failed invoice)";
const TASK = "Finance wants failed charges retried on a schedule instead of being written off. Add retryFailedInvoices in src/retries.js: retry each failed invoice's charge 1, 6 and 24 hours after its last attempt.";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "snout-inject-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  mkdirSync(join(root, ".snout"));
  const env = (extra = {}) => { const e = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root, SNOUT_MODE: "enforce", SNOUT_MEMORY_NOTES: "1", ...extra }; delete e.CI; delete e.SNOUT_TOKEN; return e; };
  const run = (args, input, extra) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", input, env: env(extra) }).stdout.trim();
  const context = (out) => (out ? JSON.parse(out).hookSpecificOutput?.additionalContext ?? "" : "");
  const prompt = (text, extra, agent = "claude") => {
    const input = JSON.stringify({ cwd: root, session_id: `p-${Math.random()}`, hook_event_name: "UserPromptSubmit", prompt: text, ...(agent === "codex" ? { model: "stand-in" } : {}) });
    return context(run(agent === "codex" ? ["hook", "codex", "UserPromptSubmit"] : ["prompt-submit"], input, extra));
  };
  const start = (extra) => context(run(["session-start"], JSON.stringify({ cwd: root, session_id: `s-${Math.random()}`, source: "startup" }), extra));
  const stores = () => storesFor(root, join(root, ".snout"), cfg);
  const user = userPrincipal(root);
  const lesson = (text = RULE, applies = APPLIES, approve = true) => {
    const o = proposeLesson(stores(), user, { text, basis: "test", applies, evidence: "node --test", session: "s1", agent: "claude" });
    checkProposals(stores(), { session: "s1", agent: "claude", test: PASS, commits: [] }, []);
    return approve ? approveLesson(stores(), o.id) : o;
  };
  const injects = () => readFileSync(join(root, ".snout", "recall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "inject");
  return { root, prompt, start, stores, user, lesson, injects };
}

test("an approved lesson that fits the task reaches the prompt with its source, for Claude Code and for Codex", () => {
  const r = repo();
  const o = r.lesson();
  for (const agent of ["claude", "codex"]) {
    const ctx = r.prompt(TASK, {}, agent);
    assert.match(ctx, /original idempotency key/, agent);
    assert.match(ctx, new RegExp(`a lesson the user approved, for when retrying a charge in chargeline.*session:s1, claude, \\d{4}-\\d\\d-\\d\\d; approved`), agent);
  }
  assert.equal(r.injects().at(-1).items[0], o.id);
});

test("nothing is added when nothing clears the bar, when notes are off, or when the lesson is only a proposal", () => {
  const r = repo();
  r.lesson();
  assert.equal(r.prompt("Add a dark mode toggle to the settings page"), "", "unrelated");
  assert.equal(r.prompt("Retry the flaky upload in the UI"), "", "one shared word is weak");
  assert.equal(r.prompt(TASK, { SNOUT_MEMORY_NOTES: "0" }), "", "notes off, the default");
  assert.equal(r.prompt(TASK, { SNOUT_MODE: "observe" }), "", "observe records, shows nothing");
  const p = repo();
  p.lesson(RULE, APPLIES, false);
  assert.equal(p.prompt(TASK), "", "a proposal nobody approved");
});

test("an approved lesson stays out when its explanation overlaps but its applicability does not", () => {
  const r = repo();
  r.lesson();
  assert.equal(r.prompt("Fix a gateway connection timeout in the telemetry collector"), "", "shared cause words do not make a billing lesson applicable");
  assert.equal(r.prompt("Change src/auth/reset.ts to reject reused password reset links"), "", "reuse and src are not the billing scope");
  const thumbnails = repo();
  thumbnails.lesson("A thumbnail worker retry keeps the job's original dedupe key after a transient failure.", "retrying thumbnail jobs in workers/thumbs.ts");
  assert.equal(thumbnails.prompt("Retry email notification jobs after SMTP failures"), "", "retry and jobs are generic workflow words");
  assert.equal(thumbnails.prompt("Update worker memory limits for video transcoding jobs"), "", "worker and jobs are generic workflow words");
  const webhook = repo();
  webhook.lesson("Webhook signature verification uses the raw request body before JSON parsing.", "handling signed webhooks in src/webhooks/verify.ts");
  assert.match(webhook.prompt("Webhook signature checks fail after JSON parsing"), /raw request body/, "a named domain and strong explanatory match can deliver the lesson");
});

test("a prompt gets three notes at most, lessons first", () => {
  const r = repo();
  const o = r.lesson();
  for (const n of ["one", "two", "three", "four"]) addObservation(r.stores(), r.user, { kind: "fact", text: `Failed invoice charges retry through the ${n} gateway adapter in src/retries.js`, via: "manual" });
  r.prompt(TASK);
  const row = r.injects().at(-1);
  assert.equal(row.items.length, MAX_PROMPT_NOTES);
  assert.equal(row.items[0], o.id);
});

test("the session-start line names approved lessons by where they apply, only with notes on, and never what they say", () => {
  const r = repo();
  const o = r.lesson();
  const on = r.start();
  assert.match(on, new RegExp(`${o.id} \\(when retrying a charge in chargeline`));
  assert.doesNotMatch(on, /idempotency/, "the rule itself waits for the task it fits, or a fetch");
  assert.equal(r.start({ SNOUT_MEMORY_NOTES: "0" }), "", "notes off: no records of sessions here, so no line at all");
  const cards = [{ session: "s1", agent: "claude", updated: "2026-10-29T10:00:00Z" }];
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `o_${i}`, applies: "x".repeat(200) }));
  const line = memoryHint(cards, "now", "codex", null, 5, many);
  assert.match(line, /o_0 .*o_1 .*o_2 .*; 2 more\./);
  assert.ok(line.length < 900, `bounded: ${line.length} characters`);
});

test("the prompt hook stays fast with a large store", () => {
  const r = repo();
  r.lesson();
  for (let i = 0; i < 300; i++) addObservation(r.stores(), r.user, { kind: "fact", text: `Module ${i} keeps its fixtures in fixtures/m${i} and its seed data in seeds/m${i}.json`, via: "manual" });
  r.prompt(TASK);
  const times = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); r.prompt(TASK); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  // A whole process per call, Node start included; the gate's own latency check is the real measure.
  assert.ok(times[2] < 2500, `median ${Math.round(times[2])} ms`);
});
