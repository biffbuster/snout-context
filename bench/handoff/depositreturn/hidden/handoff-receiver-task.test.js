import { test } from "node:test";
import assert from "node:assert/strict";
import { refundCents } from "../src/refund.js";

test("cans and plastic bottles refund 10 cents each", () => {
  assert.equal(refundCents([{ type: "can", damaged: false }, { type: "plastic", damaged: false }, { type: "can", damaged: false }]), 30);
  assert.equal(refundCents([]), 0);
});

test("an unknown type is an error", () => assert.throws(() => refundCents([{ type: "carton", damaged: false }]), RangeError));
