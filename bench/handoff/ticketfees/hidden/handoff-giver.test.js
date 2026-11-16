import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrice } from "../src/prices.js";

test("prices are read to the exact cent", () => {
  assert.equal(parsePrice("19.99"), 1999);
  assert.equal(parsePrice("0.29"), 29);
});
