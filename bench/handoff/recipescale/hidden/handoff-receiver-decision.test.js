import { test } from "node:test";
import assert from "node:assert/strict";
import { toMetric } from "../src/metric.js";

test("metric amounts are rounded to the nearest 5 ml", () => {
  assert.deepEqual(toMetric(0.3, "cup"), { amount: 70, unit: "ml" });
  assert.deepEqual(toMetric(1.1, "tbsp"), { amount: 15, unit: "ml" });
});

test("amounts under 3 teaspoons stay in teaspoons", () => {
  assert.deepEqual(toMetric(1, "tsp"), { amount: 1, unit: "tsp" });
  assert.deepEqual(toMetric(2.5, "tsp"), { amount: 2.5, unit: "tsp" });
});
