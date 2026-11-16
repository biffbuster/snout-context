import { test } from "node:test";
import assert from "node:assert/strict";
import { splitEvenly } from "../src/tips.js";

test("every cent is paid out, extra cents to the first names", () => {
  assert.deepEqual(splitEvenly(1000, ["ana", "ben", "cy"]), { ana: 334, ben: 333, cy: 333 });
  assert.deepEqual(splitEvenly(1001, ["ana", "ben", "cy"]), { ana: 334, ben: 334, cy: 333 });
});
