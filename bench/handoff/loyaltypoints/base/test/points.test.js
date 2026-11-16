import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsEarned } from "../src/points.js";

test("whole dollars", () => assert.equal(pointsEarned(1000), 10));
test("nothing spent", () => assert.equal(pointsEarned(0), 0));
