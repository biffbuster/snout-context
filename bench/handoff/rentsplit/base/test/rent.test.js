import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRent } from "../src/rent.js";

test("two rooms of the same size pay the same", () => assert.deepEqual(splitRent(200000, [{ name: "a", m2: 12 }, { name: "b", m2: 12 }]), { a: 100000, b: 100000 }));
test("a bigger room pays more", () => {
  const out = splitRent(100000, [{ name: "a", m2: 10 }, { name: "b", m2: 30 }]);
  assert.ok(out.b > out.a);
});
