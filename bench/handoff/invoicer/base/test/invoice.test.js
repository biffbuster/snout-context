import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCents, totalCents } from "../src/invoice.js";

test("whole-dollar lines add up", () => assert.equal(totalCents({ lines: [{ sku: "A", qty: 2, unitPrice: 5 }] }), 1000));
test("an empty order is zero", () => assert.equal(totalCents({ lines: [] }), 0));
test("cents print with two decimals", () => assert.equal(formatCents(1999), "$19.99"));
