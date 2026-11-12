import { test } from "node:test";
import assert from "node:assert/strict";
import { saveProfile } from "../src/profiles.js";

test("profiles are saved under display_name", () => {
  const r = saveProfile({ id: 4, name: "Dee Ray" });
  assert.equal(r.display_name, "Dee Ray");
  assert.equal(r.id, 4);
  assert.equal("fullname" in r, false);
});
