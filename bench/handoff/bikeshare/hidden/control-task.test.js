import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/rides.js";

test("formatDuration shows minutes, then hours and minutes", () => {
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(65), "1 h 05 min");
  assert.equal(formatDuration(120), "2 h 00 min");
});
