import { test } from "node:test";
import assert from "node:assert/strict";
import { alertState } from "../src/alerts.js";

const at = (cs) => cs.map((c, i) => ({ at: i + 1, c }));

test("the limit is 8°C", () => assert.equal(alertState(at([3, 9, 9, 9])), "alarm"));

test("it takes 3 readings in a row above the limit, in time order", () => {
  assert.equal(alertState(at([12, 3, 12, 3, 12])), "ok");
  assert.equal(alertState([{ at: 3, c: 12 }, { at: 1, c: 12 }, { at: 4, c: 3 }, { at: 2, c: 12 }]), "alarm");
});
