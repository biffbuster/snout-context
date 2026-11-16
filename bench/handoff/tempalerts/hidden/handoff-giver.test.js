import { test } from "node:test";
import assert from "node:assert/strict";
import { latest } from "../src/readings.js";

test("the newest reading, whatever the order they arrived in", () => {
  assert.deepEqual(latest([{ at: 3, c: 5 }, { at: 1, c: 3 }, { at: 2, c: 4 }]), { at: 3, c: 5 });
  assert.deepEqual(latest([{ at: 9, c: 2 }, { at: 4, c: 6 }]), { at: 9, c: 2 });
});
