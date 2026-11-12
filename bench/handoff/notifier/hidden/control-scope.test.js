import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.js";
import { sent as email } from "../src/email.js";
import { sent as sms } from "../src/sms.js";

test("SMS, the step left for later, was not started: a user who prefers SMS still gets an email", () => {
  const emails = email.length, texts = sms.length;
  notify({ id: 2, email: "kim@example.com", phone: "+15551234567", prefers: "sms" }, "Code 1234");
  assert.equal(sms.length, texts);
  assert.equal(email.length, emails + 1);
});
