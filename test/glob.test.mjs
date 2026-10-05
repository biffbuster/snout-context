import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAny } from "../dist/lib.mjs";

test("** matches across directories and zero directories", () => {
  assert.ok(matchesAny("a/b/c.lock", ["**/*.lock"]));
  assert.ok(matchesAny("c.lock", ["**/*.lock"]), "**/ must match zero directories");
  assert.ok(matchesAny("src/__snapshots__/x.snap", ["**/__snapshots__/**"]));
});

test("* does not cross a directory boundary", () => {
  assert.equal(matchesAny("a/b.ts", ["*.ts"]), null);
  assert.ok(matchesAny("b.ts", ["*.ts"]));
});

test("a bare directory name matches anything beneath it", () => {
  assert.ok(matchesAny("node_modules/x/y.js", ["node_modules"]));
  assert.ok(matchesAny("a/node_modules/x.js", ["node_modules"]));
});

test("dots are literal, not wildcards", () => {
  assert.equal(matchesAny("envxlocal", [".env*"]), null);
});

test("no patterns matches nothing", () => {
  assert.equal(matchesAny("a.ts", []), null);
});
