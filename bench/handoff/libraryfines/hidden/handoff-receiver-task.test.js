import { test } from "node:test";
import assert from "node:assert/strict";
import { fineFor } from "../src/fines.js";

const loan = (returnedDate, extra = {}) => ({ dueDate: "2026-03-10", returnedDate, replacementCents: 5000, card: "adult", ...extra });

test("an adult pays 25 cents for each day overdue", () => {
  assert.equal(fineFor(loan("2026-03-14")), 100);
  assert.equal(fineFor(loan("2026-03-11")), 25);
});

test("a loan back on time costs nothing", () => assert.equal(fineFor(loan("2026-03-10")), 0));
