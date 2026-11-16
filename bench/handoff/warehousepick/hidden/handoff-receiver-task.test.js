import { test } from "node:test";
import assert from "node:assert/strict";
import { pickOrder } from "../src/route.js";

const item = (sku, bin) => ({ sku, bin, frozen: false });

test("items are picked aisle by aisle from A, slot by slot", () => {
  assert.deepEqual(pickOrder([item("c9", "C9-1"), item("a12", "A12-2"), item("c2", "C2-1"), item("a3", "A3-1")]), ["a3", "a12", "c2", "c9"]);
});
