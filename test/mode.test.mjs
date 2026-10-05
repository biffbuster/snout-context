import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMode } from "../dist/lib.mjs";

const lowValue = { verdict: "deny", tier: 0, rule: "lockfile", value: 0, confidence: 1, reason: "r" };
const uncertain = { verdict: "deny", tier: 2, rule: "context-value", value: 0, confidence: 0.4, reason: "r" };
const medium = { verdict: "deny", tier: 2, rule: "context-value", value: 0, confidence: 0.7, reason: "r" };
const secret = { verdict: "ask", tier: 0, rule: "secret", value: 0, confidence: 1, reason: "r" };

test("INVARIANT: observe mode never blocks", () => {
  for (const d of [lowValue, uncertain, medium]) {
    assert.equal(applyMode(d, "observe").verdict, "allow");
    assert.equal(applyMode(d, "observe").suppressedByMode, true);
  }
});

test("INVARIANT: low confidence always allows, in every mode", () => {
  for (const mode of ["observe", "advise", "enforce"]) {
    assert.equal(applyMode(uncertain, mode).verdict, "allow", `mode ${mode} acted on an uncertain answer`);
  }
});

test("advise asks but never denies", () => {
  assert.equal(applyMode(lowValue, "advise").verdict, "ask");
  assert.equal(applyMode(medium, "advise").verdict, "ask");
});

test("enforce denies only at high confidence, and asks otherwise", () => {
  assert.equal(applyMode(lowValue, "enforce").verdict, "deny");
  assert.equal(applyMode(medium, "enforce").verdict, "ask");
});

test("a secret survives every mode unchanged", () => {
  for (const mode of ["observe", "advise", "enforce"]) {
    assert.equal(applyMode(secret, mode).verdict, "ask");
  }
});

test("an allow is never escalated", () => {
  const a = { verdict: "allow", tier: 0, rule: "always-allow", value: 3, confidence: 1, reason: "r" };
  for (const mode of ["observe", "advise", "enforce"]) {
    assert.equal(applyMode(a, mode).verdict, "allow");
  }
});
