import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyDeliveries } from "../src/reports/daily.js";
import { deliveriesByDriver } from "../src/reports/drivers.js";
import { weeklyHours } from "../src/reports/weekly.js";

const depots = new Map([["OSL", { id: "OSL", name: "Oslo", tz: "Europe/Oslo" }]]);

test("daily deliveries per depot", () => {
  const out = dailyDeliveries([
    { id: "a", depot: "OSL", driver: "ingrid", finishedAt: "2026-10-19T09:12:00Z" },
    { id: "b", depot: "OSL", driver: "ingrid", finishedAt: "2026-10-19T13:40:00Z" },
    { id: "c", depot: "OSL", driver: "per", finishedAt: "2026-10-20T10:00:00Z" },
  ], depots);
  assert.deepEqual(out, { OSL: { "2026-10-19": 2, "2026-10-20": 1 } });
});

test("weekly hours per driver", () => {
  const out = weeklyHours([
    { driver: "ingrid", depot: "OSL", start: "2026-10-19T06:00:00Z", end: "2026-10-19T14:00:00Z" },
    { driver: "ingrid", depot: "OSL", start: "2026-10-21T06:00:00Z", end: "2026-10-21T12:30:00Z" },
    { driver: "ingrid", depot: "OSL", start: "2026-10-27T06:00:00Z", end: "2026-10-27T10:00:00Z" },
  ], depots);
  assert.deepEqual(out, { ingrid: { "2026-W43": 14.5, "2026-W44": 4 } });
});

test("unknown depots are refused", () => {
  assert.throws(() => dailyDeliveries([{ id: "x", depot: "LHR", driver: "z", finishedAt: "2026-10-19T09:00:00Z" }], depots), /unknown depot LHR/);
});

test("deliveries per driver, most first", () => {
  assert.deepEqual(deliveriesByDriver([{ driver: "b" }, { driver: "a" }, { driver: "b" }]), [{ driver: "b", count: 2 }, { driver: "a", count: 1 }]);
});
