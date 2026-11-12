import { test } from "node:test";
import assert from "node:assert/strict";
import { discountedTotalCents } from "../src/discounts.js";

test("small orders pay the plain total; large orders get a volume discount", () => {
  assert.equal(discountedTotalCents({ lines: [{ sku: "A", qty: 10, unitPrice: 2 }] }), 2000);
  assert.ok(discountedTotalCents({ lines: [{ sku: "A", qty: 120, unitPrice: 1 }] }) < 12000);
});
