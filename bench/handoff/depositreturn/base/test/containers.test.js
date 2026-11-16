import { test } from "node:test";
import assert from "node:assert/strict";
import { countByType } from "../src/containers.js";

test("each type is counted", () => assert.deepEqual(countByType(["can", "glass", "can"]), { can: 2, plastic: 0, glass: 1 }));
