import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleAmount } from "../src/scale.js";

test("amounts scale by the exact ratio of servings", () => {
  assert.equal(scaleAmount(100, 4, 6), 150);
  assert.equal(scaleAmount(100, 4, 2), 50);
});
