import { test } from "node:test";
import assert from "node:assert/strict";
import { earnedBy } from "../src/accrual.js";

test("days earned grow each month", () => assert.ok(earnedBy(6) > earnedBy(5)));
