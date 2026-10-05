import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scorePrompt } from "../dist/lib.mjs";

const CLI = new URL("../dist/snout.mjs", import.meta.url).pathname;

test("vague task prompts get a tip; scoped ones, replies and questions do not", () => {
  for (const p of ["fix the checkout bug", "add dark mode", "make the app faster"]) {
    const c = scorePrompt(p);
    assert.ok(c.taskLike && c.tip, p);
    assert.deepEqual(c.missing, ["target", "behavior", "verify"], p);
  }
  for (const p of [
    "The cart total ignores item quantity. Fix it so `node --test test/cart.test.js` passes.",
    "fetchUserName returns undefined. Find the bug and fix it",
    "Add formatPrice(cents, currency) to src/format.js supporting USD and EUR",
  ]) assert.equal(scorePrompt(p).tip, null, p);
  for (const p of ["yes do it", "continue", "what does this repo do?", "/snout:report", "thanks, now fix the tests too"]) {
    assert.equal(scorePrompt(p).tip, null, p);
  }
});

test("the three signals score target, behaviour and verification", () => {
  const c = scorePrompt("Fix the crash in src/cart.ts: total should include quantity; run npm test");
  assert.deepEqual([c.target, c.behavior, c.verify, c.score], [true, true, true, 1]);
  assert.equal(scorePrompt("refactor the payment flow so it retries").target, false);
});

function hook(root, prompt, session = "s1") {
  return spawnSync(process.execPath, [CLI, "prompt-submit"], { input: JSON.stringify({ session_id: session, cwd: root, hook_event_name: "UserPromptSubmit", prompt }), encoding: "utf8" });
}

test("the hook shows the tip to the user only, never nags, and stores no prompt text", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-coach-"));
  const first = JSON.parse(hook(root, "fix the checkout bug").stdout);
  assert.match(first.systemMessage, /Snout prompt coach/);
  assert.equal(first.hookSpecificOutput, undefined, "nothing reaches the model's context");
  assert.equal(hook(root, "make the app faster").stdout, "", "no second tip within three turns");
  assert.equal(hook(root, "The cart total ignores quantity; fix src/cart.ts so npm test passes").stdout, "");
  const rows = readFileSync(join(root, ".snout/prompts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.tipped), [true, false, false]);
  assert.deepEqual(rows.map((r) => r.turn), [1, 2, 3]);
  const raw = readFileSync(join(root, ".snout/prompts.jsonl"), "utf8");
  assert.doesNotMatch(raw, /checkout|faster|cart/, "signals only, never the prompt");
});

test("coach off: no tip, nothing recorded", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-coach-"));
  mkdirSync(join(root, ".snout"));
  writeFileSync(join(root, ".snout/config.json"), JSON.stringify({ coach: "off" }));
  assert.equal(hook(root, "fix the checkout bug").stdout, "");
  assert.ok(!existsSync(join(root, ".snout/prompts.jsonl")));
});

test("the plugin runs the prompt hook in the foreground, so a tip can be shown", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const h = hooks.hooks.UserPromptSubmit[0].hooks[0];
  assert.notEqual(h.async, true);
  assert.ok(h.timeout <= 5);
});
