import { test } from "node:test";
import assert from "node:assert/strict";
import { points } from "../src/results.js";

test("a win is 3 points", () => assert.equal(points({ for: 2, against: 1 }), 3));
test("a loss is 0 points", () => assert.equal(points({ for: 0, against: 1 }), 0));
