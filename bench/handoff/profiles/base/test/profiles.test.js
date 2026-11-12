import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfile, saveProfile } from "../src/profiles.js";
import { legacyExport } from "../src/legacy-export.js";

test("a stored record loads as a profile", () => assert.deepEqual(loadProfile({ id: 1, fullname: "Ada Park" }), { id: 1, name: "Ada Park" }));
test("profiles save with an id", () => assert.equal(saveProfile({ id: 2, name: "Bo" }).id, 2));
test("the payroll export has a header row", () => assert.match(legacyExport([{ id: 1, name: "Ada" }]), /^id,fullname\n1,"Ada"\n$/));
