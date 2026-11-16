import { test } from "node:test";
import assert from "node:assert/strict";
import { fitsCapacity } from "../src/rooms.js";

test("a room seats a group as large as its seats", () => {
  assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 8), true);
  assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 9), false);
});
