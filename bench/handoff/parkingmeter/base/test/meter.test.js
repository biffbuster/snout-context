import { test } from "node:test";
import assert from "node:assert/strict";
import { billedMinutes } from "../src/meter.js";

test("whole minutes are billed as they are", () => assert.equal(billedMinutes(0, 10 * 60_000), 10));
test("a session can't end before it starts", () => assert.throws(() => billedMinutes(5, 1), RangeError));
