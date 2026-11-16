import { test } from "node:test";
import assert from "node:assert/strict";
import { rideMinutes } from "../src/rides.js";

test("a ride across midnight counts the right minutes", () => {
  assert.equal(rideMinutes("23:50", "00:10"), 20);
  assert.equal(rideMinutes("10:00", "10:00"), 0);
});
