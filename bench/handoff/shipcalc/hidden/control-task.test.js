import { test } from "node:test";
import assert from "node:assert/strict";
import { isFreight } from "../src/index.js";

test("isFreight is true only past the heaviest domestic band", () => {
  assert.equal(isFreight(0.4), false);
  assert.equal(isFreight(20), false);
  assert.equal(isFreight(20.1), true);
  assert.equal(isFreight(35), true);
});
