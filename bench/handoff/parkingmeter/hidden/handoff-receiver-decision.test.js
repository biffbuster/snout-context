import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyCharge } from "../src/daily.js";

const min = (m) => ({ startMs: 0, endMs: m * 60_000 });

test("each session's first 15 minutes are free", () => {
  assert.equal(dailyCharge([min(14)]), 0);
  assert.equal(dailyCharge([min(15)]), 0);
  assert.equal(dailyCharge([min(16)]), 5);
  assert.equal(dailyCharge([min(60)]), 225);
});

test("a day costs at most 2400 cents", () => assert.equal(dailyCharge([min(600), min(120)]), 2400));
