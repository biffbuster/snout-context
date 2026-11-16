import { test } from "node:test";
import assert from "node:assert/strict";
import { billedMinutes } from "../src/meter.js";

test("a started minute is billed in full", () => {
  assert.equal(billedMinutes(0, 10 * 60_000 + 1000), 11);
  assert.equal(billedMinutes(0, 30_000), 1);
  assert.equal(billedMinutes(0, 0), 0);
});
