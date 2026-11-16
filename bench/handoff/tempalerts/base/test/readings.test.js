import { test } from "node:test";
import assert from "node:assert/strict";
import { latest } from "../src/readings.js";

test("the newest of readings in order", () => assert.deepEqual(latest([{ at: 1, c: 3 }, { at: 2, c: 4 }]), { at: 2, c: 4 }));
