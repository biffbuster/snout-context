import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleAmount } from "../src/scale.js";

test("doubling a recipe doubles the amounts", () => assert.equal(scaleAmount(100, 2, 4), 200));
