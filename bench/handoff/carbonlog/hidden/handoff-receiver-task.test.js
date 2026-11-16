import { test } from "node:test";
import assert from "node:assert/strict";
import { flightKg } from "../src/flights.js";

test("economy flights emit 0.15 kg a km, in whole kilograms", () => {
  assert.equal(flightKg(1000, "economy"), 150);
  assert.equal(flightKg(2000, "economy"), 300);
  assert.equal(flightKg(1234, "economy"), 185);
});

test("an unknown cabin is an error", () => assert.throws(() => flightKg(1000, "first"), RangeError));
