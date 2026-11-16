import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "../src/money.js";

test("whole amounts drop the cents", () => {
  assert.equal(formatMoney(1200), "$12");
  assert.equal(formatMoney(100000000), "$1,000,000");
});

test("negative amounts go in parentheses", () => {
  assert.equal(formatMoney(-525), "($5.25)");
  assert.equal(formatMoney(-1200), "($12)");
});
