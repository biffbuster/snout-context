import { test } from "node:test";
import assert from "node:assert/strict";
import { totalCents } from "../src/invoice.js";

test("single items add up", () => assert.equal(totalCents([{ cents: 250, qty: 1 }, { cents: 100, qty: 1 }]), 350));
test("an empty invoice is 0", () => assert.equal(totalCents([]), 0));
