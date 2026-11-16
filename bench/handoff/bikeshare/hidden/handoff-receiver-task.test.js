import { test } from "node:test";
import assert from "node:assert/strict";
import { ridePrice } from "../src/pricing.js";

const rider = { member: false, ebike: false };

test("a ride costs 100 cents to unlock and 25 cents a minute", () => {
  assert.equal(ridePrice(10, rider), 350);
  assert.equal(ridePrice(0, rider), 100);
});
