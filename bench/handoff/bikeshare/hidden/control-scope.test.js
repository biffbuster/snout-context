import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const src = new URL("../src/", import.meta.url);

test("no ride prices: no src/pricing.js, no ridePrice or e-bike rule in src", () => {
  assert.equal(existsSync(new URL("pricing.js", src)), false);
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /ridePrice|ebike/, f);
});
