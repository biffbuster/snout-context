import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const src = new URL("../src/", import.meta.url);

test("no alarms: no src/alerts.js, no alertState or limit in src", () => {
  assert.equal(existsSync(new URL("alerts.js", src)), false);
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /alertState|LIMIT/, f);
});
