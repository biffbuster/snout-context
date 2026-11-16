import { test } from "node:test";
import assert from "node:assert/strict";
import { ridePrice } from "../src/pricing.js";

test("members ride their first 30 minutes free and still pay the unlock", () => {
  assert.equal(ridePrice(20, { member: true, ebike: false }), 100);
  assert.equal(ridePrice(40, { member: true, ebike: false }), 350);
});

test("e-bikes cost double per minute", () => assert.equal(ridePrice(10, { member: false, ebike: true }), 600));
