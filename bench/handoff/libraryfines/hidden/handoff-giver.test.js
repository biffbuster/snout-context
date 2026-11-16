import { test } from "node:test";
import assert from "node:assert/strict";
import { daysOverdue } from "../src/loans.js";

test("days overdue count from the day after the due date", () => {
  assert.equal(daysOverdue("2026-03-10", "2026-03-10"), 0);
  assert.equal(daysOverdue("2026-03-10", "2026-03-11"), 1);
  assert.equal(daysOverdue("2026-03-10", "2026-03-13"), 3);
});
