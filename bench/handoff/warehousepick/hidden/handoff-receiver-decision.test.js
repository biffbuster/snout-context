import { test } from "node:test";
import assert from "node:assert/strict";
import { pickOrder } from "../src/route.js";

const item = (sku, bin, frozen = false) => ({ sku, bin, frozen });

test("aisles are walked in a snake: B, D and so on from the highest slot down", () => {
  assert.deepEqual(pickOrder([item("b3", "B3-1"), item("a1", "A1-1"), item("b9", "B9-2")]), ["a1", "b9", "b3"]);
});

test("frozen items are picked last", () => {
  assert.deepEqual(pickOrder([item("ice", "A1-1", true), item("c5", "C5-1")]), ["c5", "ice"]);
});
