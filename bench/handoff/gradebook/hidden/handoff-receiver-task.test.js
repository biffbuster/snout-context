import { test } from "node:test";
import assert from "node:assert/strict";
import { letterGrade } from "../src/letters.js";

test("letters follow the average: A from 90, B from 80, C from 70", () => {
  assert.equal(letterGrade([95, 92, 91]), "A");
  assert.equal(letterGrade([85, 82, 80]), "B");
  assert.equal(letterGrade([75, 72]), "C");
});
