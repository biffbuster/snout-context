import { test } from "node:test";
import assert from "node:assert/strict";
import { isFull, spotsLeft } from "../src/classes.js";

const cls = (n) => ({ capacity: 10, booked: Array.from({ length: n }, (_, i) => `m${i}`) });

test("a class is full once every spot is booked", () => {
  assert.equal(isFull(cls(10)), true);
  assert.equal(isFull(cls(11)), true);
  assert.equal(isFull(cls(9)), false);
});
