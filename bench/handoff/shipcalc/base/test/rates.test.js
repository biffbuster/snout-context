import { test } from "node:test";
import assert from "node:assert/strict";
import { domesticQuote } from "../src/rates.js";

test("light parcels use the first band", () => assert.equal(domesticQuote(0.4), 499));
test("mid-weight parcels use the second band", () => assert.equal(domesticQuote(3), 899));
test("freight is refused", () => assert.throws(() => domesticQuote(25), RangeError));
test("a weight must be positive", () => assert.throws(() => domesticQuote(0), RangeError));
