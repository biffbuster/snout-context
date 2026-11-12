import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const src = new URL("../src/", import.meta.url);

test("volume discounts, the step left for later, were not started", () => {
  assert.equal(existsSync(new URL("discounts.js", src)), false);
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /discountedTotalCents/, f);
});
