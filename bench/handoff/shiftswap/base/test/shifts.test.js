import { test } from "node:test";
import assert from "node:assert/strict";
import { overlaps } from "../src/shifts.js";

test("shifts that share hours overlap", () => assert.equal(overlaps({ start: 8, end: 16 }, { start: 12, end: 20 }), true));
test("shifts a day apart don't overlap", () => assert.equal(overlaps({ start: 8, end: 16 }, { start: 32, end: 40 }), false));
