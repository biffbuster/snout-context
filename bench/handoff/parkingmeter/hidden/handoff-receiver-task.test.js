import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyCharge } from "../src/daily.js";

const min = (m) => ({ startMs: 0, endMs: m * 60_000 });

test("no sessions cost nothing", () => assert.equal(dailyCharge([]), 0));

test("a day's sessions are charged one by one and added up", () => {
  assert.equal(dailyCharge([min(40), min(60)]), dailyCharge([min(40)]) + dailyCharge([min(60)]));
  assert.ok(dailyCharge([min(60)]) > dailyCharge([min(40)]));
  assert.ok(dailyCharge([{ startMs: 0, endMs: 60 * 60_000 + 1000 }]) > dailyCharge([min(60)]), "a started minute is billed");
});
