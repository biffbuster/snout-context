import { test } from "node:test";
import assert from "node:assert/strict";
import { splitEvenly } from "../src/tips.js";

test("an even total splits evenly", () => assert.deepEqual(splitEvenly(900, ["ana", "ben", "cy"]), { ana: 300, ben: 300, cy: 300 }));
test("no one to pay is an error", () => assert.throws(() => splitEvenly(100, []), RangeError));
