import { test } from "node:test";
import assert from "node:assert/strict";
import { overlaps } from "../src/shifts.js";

test("shifts that only touch don't overlap", () => {
  assert.equal(overlaps({ start: 6, end: 14 }, { start: 14, end: 22 }), false);
  assert.equal(overlaps({ start: 14, end: 22 }, { start: 6, end: 14 }), false);
  assert.equal(overlaps({ start: 6, end: 14 }, { start: 13, end: 22 }), true);
});
