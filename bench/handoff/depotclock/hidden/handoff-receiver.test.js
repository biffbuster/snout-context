// Hidden test for the receiver's task (the weekly report's week boundary). Copied in only to grade; never in a session's workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyHours } from "../src/reports/weekly.js";

const depots = new Map([
  ["OSL", { id: "OSL", name: "Oslo", tz: "Europe/Oslo" }],
  ["YYZ", { id: "YYZ", name: "Toronto", tz: "America/Toronto" }],
  ["SYD", { id: "SYD", name: "Sydney", tz: "Australia/Sydney" }],
]);

test("a shift counts in the week it starts on the depot's own calendar", () => {
  const out = weeklyHours([
    { driver: "tash", depot: "SYD", start: "2026-10-25T19:00:00Z", end: "2026-10-26T03:00:00Z" }, // Monday 06:00 in Sydney
    { driver: "marc", depot: "YYZ", start: "2026-10-26T01:00:00Z", end: "2026-10-26T05:00:00Z" }, // Sunday 21:00 in Toronto
    { driver: "ingrid", depot: "OSL", start: "2026-10-21T06:00:00Z", end: "2026-10-21T14:00:00Z" },
  ], depots);
  assert.deepEqual(out, { tash: { "2026-W44": 8 }, marc: { "2026-W43": 4 }, ingrid: { "2026-W43": 8 } });
});
