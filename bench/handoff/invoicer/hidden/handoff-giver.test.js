import { test } from "node:test";
import assert from "node:assert/strict";
import { totalCents } from "../src/invoice.js";

test("totals are exact integer cents", () => {
  assert.equal(totalCents({ lines: [{ sku: "A", qty: 3, unitPrice: 0.1 }] }), 30);
  assert.equal(totalCents({ lines: [{ sku: "B", qty: 3, unitPrice: 19.99 }] }), 5997);
  assert.ok(Number.isInteger(totalCents({ lines: [{ sku: "C", qty: 7, unitPrice: 0.07 }] })));
});
