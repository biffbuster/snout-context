import { test } from "node:test";
import assert from "node:assert/strict";
import { standings } from "../src/standings.js";

test("ties on points are broken by goal difference", () => {
  const teams = [
    { name: "Scorers", results: [{ for: 5, against: 4, forfeit: false }, { for: 0, against: 1, forfeit: false }] },
    { name: "Savers", results: [{ for: 3, against: 0, forfeit: false }, { for: 0, against: 1, forfeit: false }] },
  ];
  assert.deepEqual(standings(teams), ["Savers", "Scorers"]);
});

test("a forfeited match is a 0-3 loss, whatever score was entered", () => {
  const teams = [
    { name: "NoShows", results: [{ for: 2, against: 1, forfeit: true }] },
    { name: "Drawers", results: [{ for: 0, against: 0, forfeit: false }] },
  ];
  assert.deepEqual(standings(teams), ["Drawers", "NoShows"]);
});
