import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteFromWaitlist } from "../src/waitlist.js";

const w = (name, extra = {}) => ({ name, tier: "regular", declines: 0, ...extra });

test("founding-tier members are promoted before everyone else", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("c"), w("f", { tier: "founding" })] }, ["a"]);
  assert.deepEqual(out.booked, ["b", "f"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), ["c"]);
});

test("anyone who declined a spot twice is dropped from the waitlist", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("x", { declines: 2 }), w("c")] }, ["a"]);
  assert.deepEqual(out.booked, ["b", "c"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), []);
});
