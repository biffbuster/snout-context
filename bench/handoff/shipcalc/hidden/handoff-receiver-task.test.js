import { test } from "node:test";
import assert from "node:assert/strict";
import { internationalQuote } from "../src/international.js";

test("international quotes use each zone's base price and step", () => {
  assert.equal(internationalQuote(1, "EU"), 1500);
  assert.equal(internationalQuote(1.5, "EU"), 1900);
  assert.equal(internationalQuote(0.5, "WORLD"), 2500);
  assert.equal(internationalQuote(1.2, "WORLD"), 2780);
  assert.throws(() => internationalQuote(1, "MARS"));
});
