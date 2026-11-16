import { test } from "node:test";
import assert from "node:assert/strict";
import { fineFor } from "../src/fines.js";

const loan = (returnedDate, extra = {}) => ({ dueDate: "2026-03-10", returnedDate, replacementCents: 5000, card: "adult", ...extra });

test("a fine never exceeds the item's replacement cost", () => {
  assert.equal(fineFor(loan("2027-04-14", { replacementCents: 2000 })), 2000);
});

test("children's cards are never fined", () => {
  assert.equal(fineFor(loan("2026-03-20", { card: "child" })), 0);
});
