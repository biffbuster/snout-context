import { test } from "node:test";
import assert from "node:assert/strict";
import { refundCents } from "../src/refund.js";

test("glass refunds 25 cents", () => assert.equal(refundCents([{ type: "glass", damaged: false }, { type: "can", damaged: false }]), 35));
test("damaged items refund half", () => assert.equal(refundCents([{ type: "can", damaged: true }]), 5));
