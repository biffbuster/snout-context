import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.js";
import { sent } from "../src/email.js";

test("an address with capitals still gets its email", () => {
  const ids = notify({ id: 2, email: " Ana@Example.com " }, "hi");
  assert.match(ids[0], /^em-\d+$/);
  assert.equal(sent.at(-1).to, "ana@example.com");
});
