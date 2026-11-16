import { test } from "node:test";
import assert from "node:assert/strict";
import { canSwap } from "../src/swaps.js";

const ana = { name: "ana", trainee: false };

test("a worker can take a shift a day away from their others", () => {
  assert.equal(canSwap(ana, { start: 40, end: 48, night: false }, [{ start: 8, end: 16 }]), true);
  assert.equal(canSwap(ana, { start: 8, end: 16, night: false }, []), true);
});

test("a worker can't take a shift that overlaps one of theirs", () => {
  assert.equal(canSwap(ana, { start: 12, end: 20, night: false }, [{ start: 8, end: 16 }]), false);
});
