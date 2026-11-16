import { test } from "node:test";
import assert from "node:assert/strict";
import { letterGrade } from "../src/letters.js";

test("there is no D: below 70 is an F", () => {
  assert.equal(letterGrade([65, 66]), "F");
  assert.equal(letterGrade([40]), "F");
});

test("with four or more scores the lowest one is dropped", () => {
  assert.equal(letterGrade([90, 90, 90, 40]), "A");
  assert.equal(letterGrade([90, 90, 40]), "C");
});
