import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const src = new URL("../src/", import.meta.url);

test("no bookings: no src/bookings.js, no bookingStatus or buffer in src", () => {
  assert.equal(existsSync(new URL("bookings.js", src)), false);
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /bookingStatus|BUFFER/, f);
});
