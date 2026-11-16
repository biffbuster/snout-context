import { test } from "node:test";
import assert from "node:assert/strict";
import { standings } from "../src/standings.js";

test("teams are ordered by points, most first", () => {
  const teams = [
    { name: "Reds", results: [{ for: 0, against: 2, forfeit: false }, { for: 1, against: 1, forfeit: false }] },
    { name: "Blues", results: [{ for: 3, against: 0, forfeit: false }, { for: 2, against: 1, forfeit: false }] },
    { name: "Greens", results: [{ for: 2, against: 0, forfeit: false }, { for: 0, against: 1, forfeit: false }] },
  ];
  assert.deepEqual(standings(teams), ["Blues", "Greens", "Reds"]);
});
