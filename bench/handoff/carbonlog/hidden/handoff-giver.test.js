import { test } from "node:test";
import assert from "node:assert/strict";
import { toTonnes } from "../src/units.js";

test("tonnes are rounded to two decimals, not cut off", () => {
  assert.equal(toTonnes(1555), 1.56);
  assert.equal(toTonnes(1554), 1.55);
  assert.equal(toTonnes(4), 0);
});
