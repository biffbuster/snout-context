import { test } from "node:test";
import assert from "node:assert/strict";
import { discountedTotalCents } from "../src/discounts.js";

test("5% from 50 to 99 units, 10% from 100", () => {
  assert.equal(discountedTotalCents({ lines: [{ sku: "A", qty: 50, unitPrice: 1 }] }), 4750);
  assert.equal(discountedTotalCents({ lines: [{ sku: "A", qty: 99, unitPrice: 1 }] }), 9405);
  assert.equal(discountedTotalCents({ lines: [{ sku: "A", qty: 100, unitPrice: 1 }] }), 9000);
});

test("units count over the whole order", () => {
  assert.equal(discountedTotalCents({ lines: [{ sku: "A", qty: 30, unitPrice: 1 }, { sku: "B", qty: 30, unitPrice: 1 }] }), 5700);
});

test("gift cards neither count toward the units nor get a discount", () => {
  assert.equal(discountedTotalCents({ lines: [{ sku: "A", qty: 40, unitPrice: 1 }, { sku: "GC-25", qty: 20, unitPrice: 25 }] }), 54000);
  assert.equal(discountedTotalCents({ lines: [{ sku: "A", qty: 60, unitPrice: 1 }, { sku: "GC-25", qty: 10, unitPrice: 25 }] }), 30700);
});
