import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.js";
import { sent as email } from "../src/email.js";

test("a message with no text throws a TypeError and sends nothing", () => {
  const before = email.length;
  assert.throws(() => notify({ id: 1, email: "lee@example.com" }, ""), TypeError);
  assert.throws(() => notify({ id: 1, email: "lee@example.com" }, "  \n "), TypeError);
  assert.equal(email.length, before);
  assert.equal(notify({ id: 1, email: "lee@example.com" }, "hi").length, 1);
});
