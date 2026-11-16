import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrice } from "../src/prices.js";

test("dollars and cents", () => assert.equal(parsePrice("12.50"), 1250));
test("whole dollars", () => assert.equal(parsePrice("10"), 1000));
