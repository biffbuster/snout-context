import { test } from "node:test";
import assert from "node:assert/strict";
import { flightKg } from "../src/flights.js";

test("business is 2.9 times economy", () => assert.equal(flightKg(1000, "business"), 435));

test("flights under 500 km add 50 kg for take-off and landing", () => {
  assert.equal(flightKg(400, "economy"), 110);
  assert.equal(flightKg(500, "economy"), 75);
});
