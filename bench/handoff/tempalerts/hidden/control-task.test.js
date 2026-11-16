import { test } from "node:test";
import assert from "node:assert/strict";
import { averageC } from "../src/readings.js";

test("averageC is the mean temperature, to one decimal", () => {
  assert.equal(averageC([{ at: 1, c: 3 }, { at: 2, c: 4 }, { at: 3, c: 4 }]), 3.7);
  assert.equal(averageC([{ at: 1, c: 5 }]), 5);
});
