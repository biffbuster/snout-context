import { test } from "node:test";
import assert from "node:assert/strict";
import { daysOverdue } from "../src/loans.js";

test("a loan returned early is not overdue", () => assert.equal(daysOverdue("2026-03-10", "2026-03-02"), 0));
