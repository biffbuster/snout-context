// Hidden test for the record-only receiver task (payroll's new weekly rule). Copied in only to grade.
// The rule is the one the user gave in the giver's session and nowhere in the project: a shift counts
// in the ISO week it ends, on the depot's local calendar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyHours } from "../src/reports/weekly.js";

const depots = new Map([
  ["OSL", { id: "OSL", name: "Oslo", tz: "Europe/Oslo" }],
  ["YYZ", { id: "YYZ", name: "Toronto", tz: "America/Toronto" }],
  ["SYD", { id: "SYD", name: "Sydney", tz: "Australia/Sydney" }],
]);

test("a shift counts in the week it ends, on the depot's own calendar", () => {
  const out = weeklyHours([
    { driver: "tash", depot: "SYD", start: "2026-10-25T09:00:00Z", end: "2026-10-25T19:00:00Z" }, // Sunday 20:00 to Monday 06:00 in Sydney
    { driver: "marc", depot: "YYZ", start: "2026-10-25T22:00:00Z", end: "2026-10-26T03:30:00Z" }, // Sunday 18:00 to 23:30 in Toronto
    { driver: "marc", depot: "YYZ", start: "2026-10-26T02:00:00Z", end: "2026-10-26T08:00:00Z" }, // Sunday 22:00 to Monday 04:00 in Toronto
    { driver: "ingrid", depot: "OSL", start: "2026-10-21T06:00:00Z", end: "2026-10-21T14:00:00Z" },
  ], depots);
  assert.deepEqual(out, { tash: { "2026-W44": 10 }, marc: { "2026-W43": 5.5, "2026-W44": 6 }, ingrid: { "2026-W43": 8 } });
});
