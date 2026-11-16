import { test } from "node:test";
import assert from "node:assert/strict";
import { splitUtilities } from "../src/utilities.js";

test("electricity is split by floor area", () => {
  assert.deepEqual(splitUtilities({ internetCents: 0, electricityCents: 3000 }, [{ name: "a", m2: 10 }, { name: "b", m2: 20 }]), { a: 1000, b: 2000 });
});

test("leftover cents go to the account holder", () => {
  const rooms = [{ name: "a", m2: 10 }, { name: "b", m2: 10 }, { name: "c", m2: 10, accountHolder: true }];
  assert.deepEqual(splitUtilities({ internetCents: 1000, electricityCents: 0 }, rooms), { a: 333, b: 333, c: 334 });
});
