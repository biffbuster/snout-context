import { test } from "node:test";
import assert from "node:assert/strict";
import { fitsCapacity } from "../src/rooms.js";

test("a small group fits", () => assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 4), true));
test("a group larger than the room doesn't", () => assert.equal(fitsCapacity({ name: "Oak", seats: 8 }, 12), false));
