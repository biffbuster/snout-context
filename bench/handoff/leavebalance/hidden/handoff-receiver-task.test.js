import { test } from "node:test";
import assert from "node:assert/strict";
import { carryOver } from "../src/carryover.js";

test("unused days carry over, at most 5", () => {
  assert.equal(carryOver(3, 1), 3);
  assert.equal(carryOver(8, 2), 5);
  assert.equal(carryOver(0, 3), 0);
});
