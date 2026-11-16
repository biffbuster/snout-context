import { test } from "node:test";
import assert from "node:assert/strict";
import { monthlyBill } from "../src/billing.js";

test("a month with no messages costs nothing", () => assert.equal(monthlyBill([]), 0));

test("each further segment costs 2 cents", () => {
  assert.equal(monthlyBill([{ segments: 300, international: false }]) - monthlyBill([{ segments: 299, international: false }]), 2);
});
