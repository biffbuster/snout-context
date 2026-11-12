import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.js";
import { sent as sms } from "../src/sms.js";

test("notify keeps its signature and returns an array of message ids on every channel", () => {
  assert.equal(notify.length, 2);
  const a = notify({ id: 5, email: "x@example.com" }, "e");
  const b = notify({ id: 6, email: "y@example.com", phone: "+15559876543", prefers: "sms" }, "s");
  for (const ids of [a, b]) {
    assert.ok(Array.isArray(ids));
    assert.equal(ids.length, 1);
    assert.equal(typeof ids[0], "string");
  }
});

test("a text over 160 characters is cut to 160 with an ellipsis as the last character", () => {
  const long = "x".repeat(200);
  notify({ id: 7, email: "z@example.com", phone: "+15550001111", prefers: "sms" }, long);
  assert.equal(sms.at(-1).text, "x".repeat(159) + "…");
});
