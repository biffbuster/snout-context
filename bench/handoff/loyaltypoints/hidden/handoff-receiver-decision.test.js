import { test } from "node:test";
import assert from "node:assert/strict";
import { maxRedeemCents } from "../src/redeem.js";

test("points pay at most 50% of the cart", () => assert.equal(maxRedeemCents([{ cents: 1000, giftCard: false }], 5000), 500));

test("gift cards can't be paid with points", () => {
  assert.equal(maxRedeemCents([{ cents: 1000, giftCard: false }, { cents: 2000, giftCard: true }], 5000), 500);
  assert.equal(maxRedeemCents([{ cents: 2000, giftCard: true }], 5000), 0);
});
