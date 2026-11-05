// Hidden test for the giver's task (the daily report's day boundary). Copied in only to grade; never in a session's workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyDeliveries } from "../src/reports/daily.js";

const depots = new Map([
  ["OSL", { id: "OSL", name: "Oslo", tz: "Europe/Oslo" }],
  ["YYZ", { id: "YYZ", name: "Toronto", tz: "America/Toronto" }],
  ["SYD", { id: "SYD", name: "Sydney", tz: "Australia/Sydney" }],
]);

test("a delivery counts on the depot's own calendar day", () => {
  const out = dailyDeliveries([
    { id: "a", depot: "YYZ", driver: "marc", finishedAt: "2026-10-20T02:30:00Z" }, // 22:30 on the 19th in Toronto
    { id: "b", depot: "YYZ", driver: "marc", finishedAt: "2026-10-19T15:05:00Z" },
    { id: "c", depot: "SYD", driver: "tash", finishedAt: "2026-10-19T14:30:00Z" }, // 01:30 on the 20th in Sydney
    { id: "d", depot: "OSL", driver: "ingrid", finishedAt: "2026-10-19T21:30:00Z" }, // 23:30 on the 19th in Oslo
  ], depots);
  assert.deepEqual(out, { YYZ: { "2026-10-19": 2 }, SYD: { "2026-10-20": 1 }, OSL: { "2026-10-19": 1 } });
});
