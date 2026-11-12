import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfile } from "../src/profiles.js";

test("loadProfile trims the spaces around the name, under either field", () => {
  assert.equal(loadProfile({ id: 1, display_name: "  Bea Lin " }).name, "Bea Lin");
  assert.equal(loadProfile({ id: 2, fullname: " Cy Ode" }).name, "Cy Ode");
  assert.equal(loadProfile({ id: 3, fullname: "Old", display_name: " New " }).name, "New");
});
