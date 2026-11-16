import { test } from "node:test";
import assert from "node:assert/strict";
import { poolByHours } from "../src/pool.js";

const front = (name, hours) => ({ name, hours, role: "front" });
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test("front staff are paid in proportion to their hours", () => {
  assert.deepEqual(poolByHours(4000, [front("ana", 10), front("ben", 10), front("cy", 20)]), { ana: 1000, ben: 1000, cy: 2000 });
});

test("the whole total is paid out in whole cents", () => {
  const out = poolByHours(1000, [front("ana", 3), front("ben", 3), front("cy", 3)]);
  assert.equal(sum(out), 1000);
  for (const v of Object.values(out)) assert.ok(Number.isInteger(v));
});
