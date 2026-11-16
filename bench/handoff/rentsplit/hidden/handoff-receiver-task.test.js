import { test } from "node:test";
import assert from "node:assert/strict";
import { splitUtilities } from "../src/utilities.js";

const rooms = [{ name: "a", m2: 10 }, { name: "b", m2: 10 }, { name: "c", m2: 10 }];

test("internet is split evenly", () => {
  assert.deepEqual(splitUtilities({ internetCents: 3000, electricityCents: 0 }, rooms), { a: 1000, b: 1000, c: 1000 });
});

test("the rooms pay exactly the bills", () => {
  const out = splitUtilities({ internetCents: 1001, electricityCents: 2002 }, rooms);
  assert.equal(out.a + out.b + out.c, 3003);
});
