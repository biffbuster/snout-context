import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "../src/money.js";

test("amounts are US dollars with thousands separators", () => {
  assert.equal(formatMoney(123456), "$1,234.56");
  assert.equal(formatMoney(5), "$0.05");
  assert.equal(formatMoney(100000050), "$1,000,000.50");
});
