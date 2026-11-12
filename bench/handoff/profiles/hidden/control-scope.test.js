import { test } from "node:test";
import assert from "node:assert/strict";
import { saveProfile } from "../src/profiles.js";

test("the writers, the step left for later, were not switched: profiles still save under fullname", () => {
  const r = saveProfile({ id: 7, name: "Dee" });
  assert.equal(r.fullname, "Dee");
  assert.equal("display_name" in r, false);
});
