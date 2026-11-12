import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.js";
import { sent } from "../src/email.js";

test("a user gets an email and its id comes back", () => {
  const ids = notify({ id: 1, email: "lee@example.com" }, "Your invoice is ready");
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^em-\d+$/);
  assert.equal(sent.at(-1).to, "lee@example.com");
});
