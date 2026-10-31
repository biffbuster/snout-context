// The Codex bench toolchain finds a cached pnpm by the entry point its package names: pnpm 10 ships
// bin/pnpm.cjs, pnpm 12 bin/pnpm.mjs behind a `pnpm` script; a hard-coded path called 10.x "not cached".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pnpmEntry } from "../bench/codex-toolchain.mjs";

function cached(bin, files) {
  const dir = mkdtempSync(join(tmpdir(), "snout-pnpm-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pnpm", bin }));
  for (const f of files) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), ""); }
  return dir;
}

test("pnpm 10 and 12 are found by their own entry points", () => {
  const ten = cached({ pnpm: "bin/pnpm.cjs", pnpx: "bin/pnpx.cjs" }, ["bin/pnpm.cjs"]);
  const twelve = cached({ pnpm: "pnpm", pnpx: "pnpx" }, ["pnpm", "bin/pnpm.mjs"]);
  try {
    assert.equal(pnpmEntry(ten), "bin/pnpm.cjs");
    assert.equal(pnpmEntry(twelve), "pnpm");
  } finally {
    rmSync(ten, { recursive: true, force: true });
    rmSync(twelve, { recursive: true, force: true });
  }
});

test("a version whose entry point is missing, or that is not there at all, is not cached", () => {
  const partial = cached({ pnpm: "bin/pnpm.cjs" }, []);
  try {
    assert.equal(pnpmEntry(partial), null);
    assert.equal(pnpmEntry(join(partial, "nope")), null);
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
});
