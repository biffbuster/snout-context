import { test } from "node:test";
import assert from "node:assert/strict";
import { toTonnes } from "../src/units.js";

test("whole tonnes", () => assert.equal(toTonnes(2000), 2));
test("half a tonne", () => assert.equal(toTonnes(1500), 1.5));
