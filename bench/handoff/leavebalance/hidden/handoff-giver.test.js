import { test } from "node:test";
import assert from "node:assert/strict";
import { earnedBy } from "../src/accrual.js";

test("the days earned by the end of a month include that month", () => {
  assert.equal(earnedBy(1), 2.1);
  assert.equal(earnedBy(6), 12.5);
  assert.equal(earnedBy(12), 25);
});
