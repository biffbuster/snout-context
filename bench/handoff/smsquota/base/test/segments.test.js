import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentCount } from "../src/segments.js";

test("two full segments", () => assert.equal(segmentCount("x".repeat(320)), 2));
test("an empty message has no segments", () => assert.equal(segmentCount(""), 0));
