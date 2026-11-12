import { test } from "node:test";
import assert from "node:assert/strict";
import { internationalQuote, RestrictedItemError } from "../src/international.js";

test("above 2 kg the weight is rounded up to the next half kilo", () => {
  assert.equal(internationalQuote(2, "EU"), 2300);
  assert.equal(internationalQuote(2.1, "EU"), 2700);
  assert.equal(internationalQuote(3.2, "WORLD"), 6000);
});

test("lithium batteries never ship internationally", () => {
  assert.equal(typeof RestrictedItemError, "function");
  assert.throws(() => internationalQuote(1, "EU", [{ sku: "PB-10", lithium: true }]), RestrictedItemError);
  assert.equal(internationalQuote(1, "EU", [{ sku: "MUG" }]), 1500);
});
