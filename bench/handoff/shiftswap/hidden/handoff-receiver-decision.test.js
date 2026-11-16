import { test } from "node:test";
import assert from "node:assert/strict";
import { canSwap } from "../src/swaps.js";

const ana = { name: "ana", trainee: false };

test("a worker needs 11 hours off between shifts", () => {
  assert.equal(canSwap(ana, { start: 25, end: 33, night: false }, [{ start: 8, end: 16 }]), false);
  assert.equal(canSwap(ana, { start: 27, end: 35, night: false }, [{ start: 8, end: 16 }]), true);
});

test("trainees can't swap into night shifts", () => {
  assert.equal(canSwap({ name: "tom", trainee: true }, { start: 22, end: 30, night: true }, []), false);
});
