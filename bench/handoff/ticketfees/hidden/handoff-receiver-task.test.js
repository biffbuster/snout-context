import { test } from "node:test";
import assert from "node:assert/strict";
import { orderTotal } from "../src/fees.js";

test("an order sums its tickets and adds the fee", () => {
  const out = orderTotal([1000, 2500], { student: false });
  assert.equal(out.tickets, 3500);
  assert.equal(out.total, out.tickets + out.fee);
});
