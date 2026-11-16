import { test } from "node:test";
import assert from "node:assert/strict";
import { rideMinutes } from "../src/rides.js";

test("a morning ride", () => assert.equal(rideMinutes("08:00", "08:45"), 45));
