// CI logs as `gh run view --log` prints them: each step once, failures with their detail, the rest counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf, squeeze, SQUEEZE_IFS } from "../dist/lib.mjs";

const JOB = "verify (ubuntu-latest, 22.x)";
const at = (i) => `2026-10-30T23:32:${String(i % 60).padStart(2, "0")}.${String(i).padStart(7, "0")}Z`;
let clock = 0;
const line = (step, msg) => `${JOB}\t${step}\t${at(clock++)} ${msg}`;

function failedRun() {
  const out = [];
  out.push(line("Set up job", "Current runner version: '2.329.0'"));
  for (let i = 0; i < 8; i++) out.push(line("Set up job", `Download action repository 'actions/setup-node@v5' (SHA:${i}a1b2c3)`));
  out.push(line("Set up job", "Complete job name: verify (ubuntu-latest, 22.x)"));
  for (let i = 0; i < 20; i++) out.push(line("Run npm ci", `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} 12ms (cache hit)`));
  out.push(line("Run npm ci", "added 212 packages, and audited 213 packages in 4s"));
  for (let i = 1; i <= 40; i++) {
    out.push(line("Run npm test", `# Subtest: the feature number ${i} still does what it did before`));
    out.push(line("Run npm test", `ok ${i} - the feature number ${i} still does what it did before`));
    out.push(line("Run npm test", "  ---"), line("Run npm test", `  duration_ms: ${i}.5`), line("Run npm test", "  ..."));
  }
  out.push(line("Run npm test", "not ok 41 - a session's private notes go to the configured folder"));
  out.push(line("Run npm test", "  ---"));
  out.push(line("Run npm test", "  location: '/home/runner/work/app/test/recall.test.mjs:136:1'"));
  out.push(line("Run npm test", "  error: \"ENOENT: no such file or directory, scandir '/tmp/cfg/memory'\""));
  out.push(line("Run npm test", "  stack: |-"));
  out.push(line("Run npm test", "    TestContext.<anonymous> (file:///home/runner/work/app/test/recall.test.mjs:144:17)"));
  out.push(line("Run npm test", "  ..."));
  for (let i = 42; i <= 50; i++) out.push(line("Run npm test", `ok ${i} - another passing test ${i}`));
  out.push(line("Run npm test", "# tests 50"), line("Run npm test", "# pass 49"), line("Run npm test", "# fail 1"));
  out.push(line("Run npm test", "##[error]Process completed with exit code 1."));
  return out.join("\n");
}

test("gh run view --log and --log-failed are CI logs, piped or not; other gh commands are not", () => {
  for (const c of ["gh run view 41145049703 --log-failed", "gh run view 41 --log", "gh run view 41 --log-failed 2>&1 | grep windows", "cd app && gh run view 41 --job 9 --log"]) assert.equal(kindOf(c), "ci", c);
  for (const c of ["gh run view 41", "gh run list --limit 5", "gh pr view 6", "echo 'gh run view 1 --log'"]) assert.notEqual(kindOf(c), "ci", c);
  assert.ok(SQUEEZE_IFS.includes("gh run view *"));
});

test("a failed run keeps each step once, the failing test with its error, location and stack, and the summary", () => {
  const log = failedRun();
  const out = squeeze("ci", log, "/repo/.snout/squeeze/run.log");
  assert.ok(out, "a long log is squeezed");
  assert.equal(out.kind, "ci");
  for (const step of ["Set up job", "Run npm ci", "Run npm test"]) assert.equal(out.text.split("\n").filter((l) => l === `== ${JOB} › ${step}`).length, 1, step);
  assert.match(out.text, /^not ok 41 - a session's private notes go to the configured folder$/m);
  assert.match(out.text, /location: '\/home\/runner\/work\/app\/test\/recall\.test\.mjs:136:1'/);
  assert.match(out.text, /ENOENT: no such file or directory/);
  assert.match(out.text, /recall\.test\.mjs:144:17/);
  assert.match(out.text, /# fail 1/);
  assert.match(out.text, /exit code 1/);
  assert.doesNotMatch(out.text, /2026-10-30T/, "timestamps dropped");
  assert.doesNotMatch(out.text, /ok 5 - the feature number 5 /, "passing tests are counted, not listed");
  assert.match(out.text, /Full log: \/repo\/\.snout\/squeeze\/run\.log/);
  assert.ok(out.afterBytes < out.beforeBytes * 0.2);
});

test("a log that isn't in gh's format is squeezed like any run, failures kept", () => {
  const plain = failedRun().split("\n").map((l, i) => `${i + 1}:${l.split("\t").at(-1)}`).join("\n");
  const out = squeeze("ci", plain, "x.log");
  assert.ok(out);
  assert.match(out.text, /not ok 41/);
  assert.match(out.text, /CI log output/);
});

test("a short log is left alone", () => {
  assert.equal(squeeze("ci", [line("Run npm test", "# tests 2"), line("Run npm test", "# pass 2")].join("\n"), "x.log"), null);
});
