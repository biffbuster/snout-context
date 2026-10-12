// Search-result grouping: big tree-wide searches keep a few hits per file, list paths up to a
// cap, and name the saved full output; small or narrow searches are left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf, squeeze, SQUEEZE_IFS } from "../dist/lib.mjs";

test("recognises tree-wide searches, not single-file greps", () => {
  for (const c of ["grep -rn 'fetchUser' .", "grep -r TODO src", "rg handler", "git grep -n cart", "find . -name '*.ts'", "ls -R src", "cd app && rg foo"]) {
    assert.equal(kindOf(c), "search", c);
  }
  for (const c of ["grep foo file.txt", "echo find me", "ls -la"]) assert.notEqual(kindOf(c), "search", c);
  assert.ok(SQUEEZE_IFS.includes("rg *") && SQUEEZE_IFS.includes("grep *"));
});

test("matches are grouped by file: first three per file, the rest counted", () => {
  const lines = [];
  for (let f = 0; f < 60; f++) for (let m = 0; m < 6; m++) lines.push(`src/module${f}/file.ts:${10 + m}:  const value${m} = computeSomething(input, options);`);
  const out = squeeze("search", lines.join("\n"), ".snout/squeeze/x.log");
  assert.ok(out, "large result is grouped");
  assert.match(out.text, /src\/module0\/file\.ts:10:/);
  assert.match(out.text, /\(\+3 more in src\/module0\/file\.ts\)/);
  assert.match(out.text, /… 20 more files with 120 matches, lines not shown:/);
  assert.match(out.text, /src\/module59\/file\.ts \(6\)/, "files past the cap are still named");
  assert.match(out.text, /360 matches in 60 files/);
  assert.match(out.text, /\.snout\/squeeze\/x\.log/);
  assert.ok(out.afterBytes < out.beforeBytes * 0.5);
});

test("path lists keep the first lines and count the rest by directory", () => {
  const paths = [];
  for (let i = 0; i < 400; i++) paths.push(`./node_modules/pkg${i % 7}/lib/file${i}.js`);
  for (let i = 0; i < 40; i++) paths.push(`./src/feature/part${i}.ts`);
  const out = squeeze("search", paths.join("\n"), ".snout/squeeze/y.log");
  assert.ok(out);
  assert.match(out.text, /… 380 more:/);
  assert.match(out.text, /node_modules\/pkg\d\/\s+\d+/);
  assert.match(out.text, /src\/feature\/\s+40/);
});

test("small searches are left alone", () => {
  assert.equal(squeeze("search", "src/a.ts:1:hello\nsrc/b.ts:2:world", ".snout/squeeze/z.log"), null);
});

test("a few files' worth of matches is left whole, even with long absolute paths (PointFive C1)", () => {
  const root = "/private/tmp/claude-501/some-very-long-scratch-directory/bvc_runs/C1/C1_0052_review_security_haiku_low_r1/work";
  const lines = [];
  for (const f of ["services/gateway/mod_31.py", "services/gateway/mod_12.py", "services/billing/mod_34.py"]) for (let m = 0; m < 7; m++) lines.push(`${root}/${f}:${10 + m}:    cursor.execute("SELECT * FROM t WHERE id = " + str(request.args.get("id")))`);
  assert.ok(Buffer.byteLength(lines.join("\n")) > 4000, "over the byte threshold only because of the paths");
  assert.equal(squeeze("search", lines.join("\n"), "x.log"), null);
});

test("path lists count directories below the prefix every path shares", () => {
  const root = "/private/tmp/scratch/run/work";
  const paths = [];
  for (let i = 0; i < 300; i++) paths.push(`${root}/services/billing/mod_${i}.py`);
  for (let i = 0; i < 50; i++) paths.push(`${root}/services/gateway/mod_${i}.py`);
  const out = squeeze("search", paths.join("\n"), "y.log");
  assert.ok(out);
  assert.match(out.text, /services\/billing\/\s+\d+/);
  assert.doesNotMatch(out.text, /^\s+\/private\/\s+\d+/m);
});
