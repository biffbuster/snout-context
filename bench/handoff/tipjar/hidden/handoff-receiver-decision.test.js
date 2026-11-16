import { test } from "node:test";
import assert from "node:assert/strict";
import { poolByHours } from "../src/pool.js";

const front = (name, hours) => ({ name, hours, role: "front" });

test("kitchen hours count half", () => {
  assert.deepEqual(poolByHours(3000, [front("ana", 10), { name: "kim", hours: 20, role: "kitchen" }]), { ana: 1500, kim: 1500 });
});

test("cents left after rounding down go to whoever worked the most hours", () => {
  assert.deepEqual(poolByHours(1000, [front("ana", 5), front("ben", 5), front("cy", 6)]), { ana: 312, ben: 312, cy: 376 });
});
