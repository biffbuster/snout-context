import { test } from "node:test";
import assert from "node:assert/strict";
import { alertState } from "../src/alerts.js";

const at = (cs) => cs.map((c, i) => ({ at: i + 1, c }));

test("a cold fridge is ok", () => assert.equal(alertState(at([2, 3, 4, 3, 2])), "ok"));
test("a fridge that stays warm raises the alarm", () => assert.equal(alertState(at([15, 15, 15, 15, 15])), "alarm"));
