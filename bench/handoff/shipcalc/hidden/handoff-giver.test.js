import { test } from "node:test";
import assert from "node:assert/strict";
import { domesticQuote } from "../src/rates.js";

test("a parcel at a band's limit pays that band's price", () => {
  assert.equal(domesticQuote(1), 499);
  assert.equal(domesticQuote(5), 899);
  assert.equal(domesticQuote(20), 1599);
});
