import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tier0, scoreFile, decide, bandOf, labelOf, summarize, THRESHOLDS, HINT_SCORE, DEFAULTS } from "../dist/lib.mjs";
import { repos } from "../eval/dataset.mjs";

const CLI = new URL("../dist/snout.mjs", import.meta.url).pathname;
const cfg = DEFAULTS;

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "snout-sc-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const at = (root, rel) => ({ absPath: join(root, rel), projectDir: root, cfg });

test("a near miss can never act: hints score below the ask threshold", () => {
  assert.ok(HINT_SCORE < THRESHOLDS.askMinConfidence);
  const root = repo({ "src/table.ts": "// do not edit without the migration\nexport const V = 3\n" });
  const scores = scoreFile(at(root, "src/table.ts"));
  assert.deepEqual(scores.find((s) => s.label === "generated"), { label: "generated", score: HINT_SCORE, rule: "generated-hint", hint: true });
  const d = decide({ ...at(root, "src/table.ts"), cfg: { ...cfg, mode: "enforce" } });
  assert.equal(d.verdict, "allow");
  assert.equal(d.rule, "unclassified");
});

test("scores show runner-ups the policy does not report", () => {
  const root = repo({ "vendor/pkg/Cargo.lock": "x" });
  const labels = scoreFile(at(root, "vendor/pkg/Cargo.lock")).map((s) => s.label);
  assert.ok(labels.includes("lockfile") && labels.includes("vendored"));
  assert.equal(tier0(at(root, "vendor/pkg/Cargo.lock")).rule, "lockfile"); // policy order unchanged
});

test("read is 1 minus the strongest flag, and 1 on the allowlist", () => {
  const root = repo({ "src/a.ts": "export const a = 1\n", "__snapshots__/a.snap": "x", "README.md": "# hi" });
  const read = (rel) => scoreFile(at(root, rel)).find((s) => s.label === "read").score;
  assert.equal(read("src/a.ts"), 1);
  assert.equal(read("__snapshots__/a.snap"), 0.2);
  assert.equal(read("README.md"), 1);
});

test("the winning label always carries the top flag score", () => {
  for (const [name, r] of Object.entries(repos)) {
    const root = repo(r.files);
    for (const rel of Object.keys(r.files)) {
      const raw = tier0(at(root, rel));
      if (!raw || raw.verdict === "allow") continue;
      const scores = scoreFile(at(root, rel));
      const top = Math.max(...scores.filter((s) => s.label !== "read").map((s) => s.score));
      const mine = scores.find((s) => s.label === labelOf(raw));
      assert.ok(mine, `${name}/${rel}: winning label ${labelOf(raw)} missing from scores`);
      assert.equal(mine.score, raw.confidence, `${name}/${rel}`);
      assert.ok(raw.confidence >= top || raw.rule === "secret" || raw.rule === "crafted-path", `${name}/${rel}`);
    }
  }
});

test("bands follow the thresholds, and what-if thresholds move them", () => {
  const root = repo({ "package-lock.json": "{}", "__snapshots__/a.snap": "x", "src/a.ts": "x", ".env": "K=1" });
  const band = (rel, t) => bandOf(tier0(at(root, rel)), t);
  assert.equal(band("package-lock.json"), "act");
  assert.equal(band("__snapshots__/a.snap"), "ask");
  assert.equal(band("src/a.ts"), "read");
  assert.equal(band(".env"), "ask");
  assert.equal(band("__snapshots__/a.snap", { denyMinConfidence: 0.9, askMinConfidence: 0.85 }), "read");
  assert.equal(band(".env", { denyMinConfidence: 1, askMinConfidence: 1 }), "ask"); // secrets ignore thresholds
});

test("summarize: per-label files and tokens add up", () => {
  const root = repo({ "package-lock.json": "x".repeat(1920), "src/a.ts": "x".repeat(224), "dist/x.min.js": "x" });
  const files = ["package-lock.json", "src/a.ts", "dist/x.min.js"].map((rel) => ({ rel, bytes: readFileSync(join(root, rel)).length, raw: tier0(at(root, rel)) }));
  const s = summarize(files, "enforce");
  assert.equal(s.files, 3);
  assert.equal(s.labels.reduce((a, r) => a + r.files, 0), 3);
  assert.equal(s.labels.reduce((a, r) => a + r.tokens, 0), s.tokens);
  assert.equal(s.bands.act.files, 2);
  assert.equal(s.outcome.deny.files, 2);
  assert.equal(s.top[0].rel, "package-lock.json");
});

test("in a git repo, scan counts what an agent browses; --all counts everything on disk", () => {
  const root = repo({ ".gitignore": "node_modules/\n", "package-lock.json": "{}", "src/a.ts": "export {}\n", "src/new.ts": "export {}\n", "node_modules/x/i.js": "x" });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", ".gitignore", "package-lock.json", "src/a.ts");
  const scan = (...extra) => JSON.parse(spawnSync(process.execPath, [CLI, "scan", "--json", ...extra], { cwd: root, encoding: "utf8" }).stdout);
  assert.equal(scan().files, 4, "tracked files plus the untracked src/new.ts, not the ignored node_modules");
  assert.equal(scan("--all").files, 5);
});

test("snout scan --json reports a distribution; explain --json carries scores and band", () => {
  const root = repo({ "package-lock.json": "{}", "src/a.ts": "export {}\n", "node_modules/x/i.js": "x" });
  const scan = spawnSync(process.execPath, [CLI, "scan", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(scan.status, 0, scan.stderr);
  const s = JSON.parse(scan.stdout);
  assert.equal(s.files, 3);
  assert.deepEqual(s.labels.map((r) => r.label).sort(), ["lockfile", "read", "vendored"]);
  assert.equal(s.bands.act.files, 2);

  const whatIf = JSON.parse(spawnSync(process.execPath, [CLI, "scan", "--json", "--deny", "1", "--ask", "1"], { cwd: root, encoding: "utf8" }).stdout);
  assert.equal(whatIf.thresholds.askMinConfidence, 1);

  const bad = spawnSync(process.execPath, [CLI, "scan", "--ask", "0.9", "--deny", "0.5"], { cwd: root, encoding: "utf8" });
  assert.match(bad.stdout, /--ask must not be above --deny/);

  const ex = JSON.parse(spawnSync(process.execPath, [CLI, "explain", "package-lock.json", "--json"], { cwd: root, encoding: "utf8" }).stdout);
  assert.equal(ex.label, "lockfile");
  assert.equal(ex.band, "act");
  assert.equal(ex.enforceVerdict, "deny");
  assert.equal(ex.scores[0].label, "lockfile");
});
