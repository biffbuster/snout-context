import { test } from "node:test";
import assert from "node:assert/strict";
import { monthlyBill } from "../src/billing.js";

test("the first 100 domestic segments each month are free", () => {
  assert.equal(monthlyBill([{ segments: 60, international: false }, { segments: 40, international: false }]), 0);
  assert.equal(monthlyBill([{ segments: 150, international: false }]), 100);
});

test("international segments cost 5 cents and are never free", () => {
  assert.equal(monthlyBill([{ segments: 10, international: true }]), 50);
});
