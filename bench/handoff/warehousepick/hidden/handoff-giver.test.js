import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBin } from "../src/bins.js";

test("slots of two digits parse right", () => {
  assert.deepEqual(parseBin("B12-1"), { aisle: "B", slot: 12, level: 1 });
  assert.deepEqual(parseBin("C40-2"), { aisle: "C", slot: 40, level: 2 });
});
