import { test } from "node:test";
import assert from "node:assert/strict";
import { countByType } from "../src/containers.js";

test("types count whatever their case", () => {
  assert.deepEqual(countByType(["Glass", "glass", "CAN"]), { can: 1, plastic: 0, glass: 2 });
});
