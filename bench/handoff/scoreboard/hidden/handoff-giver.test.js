import { test } from "node:test";
import assert from "node:assert/strict";
import { points } from "../src/results.js";

test("a draw is 1 point", () => {
  assert.equal(points({ for: 1, against: 1 }), 1);
  assert.equal(points({ for: 0, against: 0 }), 1);
  assert.equal(points({ for: 3, against: 2 }), 3);
});
