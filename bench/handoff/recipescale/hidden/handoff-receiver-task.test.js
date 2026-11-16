import { test } from "node:test";
import assert from "node:assert/strict";
import { toMetric } from "../src/metric.js";

test("cups, tablespoons and teaspoons become millilitres", () => {
  assert.deepEqual(toMetric(1, "cup"), { amount: 240, unit: "ml" });
  assert.deepEqual(toMetric(1.5, "cup"), { amount: 360, unit: "ml" });
  assert.deepEqual(toMetric(2, "tbsp"), { amount: 30, unit: "ml" });
  assert.deepEqual(toMetric(4, "tsp"), { amount: 20, unit: "ml" });
});

test("an unknown unit is an error", () => assert.throws(() => toMetric(1, "pinch"), RangeError));
