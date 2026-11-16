import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsEarned } from "../src/points.js";

test("only whole dollars earn a point", () => {
  assert.equal(pointsEarned(950), 9);
  assert.equal(pointsEarned(999), 9);
  assert.equal(pointsEarned(1001), 10);
});
