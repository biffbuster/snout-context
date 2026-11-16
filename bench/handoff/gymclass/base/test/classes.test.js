import { test } from "node:test";
import assert from "node:assert/strict";
import { isFull, spotsLeft } from "../src/classes.js";

test("spots left", () => assert.equal(spotsLeft({ capacity: 10, booked: ["a", "b", "c"] }), 7));
test("a class with room is not full", () => assert.equal(isFull({ capacity: 10, booked: ["a", "b", "c"] }), false));
