import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRent } from "../src/rent.js";

test("the rooms pay exactly the rent, within a cent of their share", () => {
  const out = splitRent(100000, [{ name: "a", m2: 10 }, { name: "b", m2: 10 }, { name: "c", m2: 10 }]);
  assert.equal(out.a + out.b + out.c, 100000);
  for (const v of Object.values(out)) assert.ok(Math.abs(v - 100000 / 3) < 1);
});
