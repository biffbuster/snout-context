import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBin } from "../src/bins.js";

test("a bin code is aisle, slot and level", () => assert.deepEqual(parseBin("A7-3"), { aisle: "A", slot: 7, level: 3 }));
