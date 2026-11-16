import { test } from "node:test";
import assert from "node:assert/strict";
import { maxRedeemCents } from "../src/redeem.js";

test("a few points pay their worth, a cent each", () => assert.equal(maxRedeemCents([{ cents: 10000, giftCard: false }], 300), 300));
test("no points pay nothing", () => assert.equal(maxRedeemCents([{ cents: 10000, giftCard: false }], 0), 0));
