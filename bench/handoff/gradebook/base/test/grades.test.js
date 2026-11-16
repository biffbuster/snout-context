import { test } from "node:test";
import assert from "node:assert/strict";
import { average } from "../src/grades.js";

test("the average of two scores", () => assert.equal(average([80, 90]), 85));
test("no scores average to 0", () => assert.equal(average([]), 0));
