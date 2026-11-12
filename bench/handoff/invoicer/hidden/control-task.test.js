import { test } from "node:test";
import assert from "node:assert/strict";
import { unitCount } from "../src/invoice.js";

test("unitCount adds up every line's qty, gift cards included", () => {
  assert.equal(unitCount({ lines: [] }), 0);
  assert.equal(unitCount({ lines: [{ sku: "A", qty: 2, unitPrice: 1 }, { sku: "GC-50", qty: 3, unitPrice: 50 }, { sku: "B", qty: 60, unitPrice: 0.5 }] }), 65);
});
