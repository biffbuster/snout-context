import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentCount } from "../src/segments.js";

test("a started segment counts in full", () => {
  assert.equal(segmentCount("x".repeat(161)), 2);
  assert.equal(segmentCount("x"), 1);
  assert.equal(segmentCount("x".repeat(160)), 1);
});
