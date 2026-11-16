import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteFromWaitlist } from "../src/waitlist.js";

const w = (name, extra = {}) => ({ name, tier: "regular", declines: 0, ...extra });

test("a cancelled spot goes to the next on the waitlist", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("c"), w("d")] }, ["a"]);
  assert.deepEqual(out.booked, ["b", "c"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), ["d"]);
});

test("with no cancellations nothing moves", () => {
  const out = promoteFromWaitlist({ capacity: 2, booked: ["a", "b"], waitlist: [w("c")] }, []);
  assert.deepEqual(out.booked, ["a", "b"]);
  assert.deepEqual(out.waitlist.map((x) => x.name), ["c"]);
});
