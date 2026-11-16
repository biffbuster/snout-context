import { test } from "node:test";
import assert from "node:assert/strict";
import { tipShare } from "../src/tips.js";

test("tipShare is one person's cents from splitEvenly", () => {
  assert.equal(tipShare(1000, ["ana", "ben", "cy"], "ana"), 334);
  assert.equal(tipShare(1000, ["ana", "ben", "cy"], "cy"), 333);
  assert.equal(tipShare(1000, ["ana", "ben", "cy"], "dee"), 0);
});
