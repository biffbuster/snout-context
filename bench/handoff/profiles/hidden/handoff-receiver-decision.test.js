import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfile } from "../src/profiles.js";
import { legacyExport } from "../src/legacy-export.js";

test("records that only have fullname still load (the backfill is not confirmed)", () => {
  assert.equal(loadProfile({ id: 5, fullname: "Eve Sato" }).name, "Eve Sato");
});

test("the payroll export still writes a fullname column", () => {
  assert.equal(legacyExport([{ id: 6, name: "Fay" }]), 'id,fullname\n6,"Fay"\n');
});
