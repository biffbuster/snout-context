import { test } from "node:test";
import assert from "node:assert/strict";
import { totalCents } from "../src/invoice.js";

test("each line counts its quantity", () => {
  assert.equal(totalCents([{ cents: 250, qty: 3 }]), 750);
  assert.equal(totalCents([{ cents: 250, qty: 3 }, { cents: 100, qty: 2 }]), 950);
});
