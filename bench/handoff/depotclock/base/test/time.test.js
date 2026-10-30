import { test } from "node:test";
import assert from "node:assert/strict";
import { hoursBetween, isoWeek, utcDay } from "../src/time.js";

test("isoWeek follows ISO 8601", () => {
  assert.equal(isoWeek("2026-10-19"), "2026-W43");
  assert.equal(isoWeek("2026-10-25"), "2026-W43");
  assert.equal(isoWeek("2026-10-26"), "2026-W44");
  assert.equal(isoWeek("2027-01-01"), "2026-W53");
  assert.equal(isoWeek("2025-12-29"), "2026-W01");
});

test("utcDay and hoursBetween", () => {
  assert.equal(utcDay("2026-10-19T09:12:00Z"), "2026-10-19");
  assert.equal(hoursBetween("2026-10-19T06:00:00Z", "2026-10-19T14:30:00Z"), 8.5);
});
