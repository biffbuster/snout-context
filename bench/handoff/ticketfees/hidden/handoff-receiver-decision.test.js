import { test } from "node:test";
import assert from "node:assert/strict";
import { orderTotal } from "../src/fees.js";

test("the fee is a flat 150 cents per order", () => {
  assert.equal(orderTotal([1000, 2500], { student: false }).fee, 150);
  assert.equal(orderTotal([4000], { student: false }).fee, 150);
});

test("students pay no service fee", () => assert.deepEqual(orderTotal([1000, 2500], { student: true }), { tickets: 3500, fee: 0, total: 3500 }));
