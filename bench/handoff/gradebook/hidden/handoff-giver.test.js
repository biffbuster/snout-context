import { test } from "node:test";
import assert from "node:assert/strict";
import { average } from "../src/grades.js";

test("a zero counts toward the average", () => {
  assert.equal(average([100, 0]), 50);
  assert.equal(average([0, 0, 90]), 30);
});
