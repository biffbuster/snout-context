import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const src = new URL("../src/", import.meta.url);

test("no pooling by hours: no src/pool.js, no poolByHours or kitchen rule in src", () => {
  assert.equal(existsSync(new URL("pool.js", src)), false);
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /poolByHours|kitchen/, f);
});
