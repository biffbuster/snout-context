import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.js";
import { sent as sms } from "../src/sms.js";
import { sent as email } from "../src/email.js";

test("a user who prefers SMS gets a text; others still get email", () => {
  const before = email.length;
  notify({ id: 3, email: "kim@example.com", phone: "+15551234567", prefers: "sms" }, "Code 1234");
  assert.equal(sms.at(-1).phone, "+15551234567");
  assert.equal(sms.at(-1).text, "Code 1234");
  assert.equal(email.length, before, "no email for an SMS user");
  notify({ id: 4, email: "jo@example.com" }, "hello");
  assert.equal(email.at(-1).to, "jo@example.com");
});
