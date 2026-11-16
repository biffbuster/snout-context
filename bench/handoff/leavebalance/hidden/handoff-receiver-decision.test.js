import { test } from "node:test";
import assert from "node:assert/strict";
import { carryOver } from "../src/carryover.js";

test("from 5 years of service the cap is 10 days", () => {
  assert.equal(carryOver(12, 5), 10);
  assert.equal(carryOver(8, 6), 8);
});

test("a negative balance is forgiven: it carries over as 0", () => assert.equal(carryOver(-2, 1), 0));
