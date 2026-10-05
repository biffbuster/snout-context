/**
 * The Bash ingress parser. Its failure modes are asymmetric: missing a read undercounts,
 * inventing one writes a ledger row about something that never happened. These tests hold
 * that line — every "must not" case below is a fabricated read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTargets, dumpTargets, searchHint } from "../dist/lib.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "snout-bash-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "src/app.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "notes.md"), "# notes\n");
  writeFileSync(join(root, "a file.txt"), "spaces\n");
  return root;
}

test("the plain read commands are recognised", () => {
  const root = project();
  for (const cmd of ["cat notes.md", "head -n 5 notes.md", "tail -c 20 notes.md", "less notes.md", "nl notes.md"]) {
    assert.deepEqual(readTargets(cmd, root), [join(root, "notes.md")], cmd);
  }
});

test("sed, awk and jq skip their program and keep the file", () => {
  const root = project();
  assert.deepEqual(readTargets("sed -n '1,5p' notes.md", root), [join(root, "notes.md")]);
  assert.deepEqual(readTargets("awk '{print $1}' notes.md", root), [join(root, "notes.md")]);
  assert.deepEqual(readTargets("jq '.dependencies' package-lock.json", root), [join(root, "package-lock.json")]);
  // With -e the script came from the flag, so the first operand really is a path.
  assert.deepEqual(readTargets("sed -e 's/a/b/' notes.md", root), [join(root, "notes.md")]);
});

test("every segment of a pipeline and a list is examined", () => {
  const root = project();
  assert.deepEqual(readTargets("cat notes.md | head -3", root), [join(root, "notes.md")]);
  assert.deepEqual(
    readTargets("cat src/app.ts && cat notes.md", root),
    [join(root, "src/app.ts"), join(root, "notes.md")],
  );
  // A grep in the pipeline is not a read command; the cat feeding it is.
  assert.deepEqual(readTargets("cat package-lock.json | grep resolved", root), [join(root, "package-lock.json")]);
});

test("quoted paths survive and unbalanced quotes yield nothing", () => {
  const root = project();
  assert.deepEqual(readTargets("cat 'a file.txt'", root), [join(root, "a file.txt")]);
  assert.deepEqual(readTargets('cat "a file.txt"', root), [join(root, "a file.txt")]);
  assert.deepEqual(readTargets("cat 'a file.txt", root), []);
});

test("a redirect target is written, not read", () => {
  const root = project();
  // out.txt does not exist, but the point is that it must never be claimed even if it did.
  assert.deepEqual(readTargets("cat notes.md > out.txt", root), [join(root, "notes.md")]);
  assert.deepEqual(readTargets("sed -n '1p' < notes.md", root), [join(root, "notes.md")]);
});

test("nothing is claimed for paths we cannot resolve", () => {
  const root = project();
  assert.deepEqual(readTargets("cat missing.md", root), [], "a file that does not exist was not read");
  assert.deepEqual(readTargets("cat src/*.ts", root), [], "an unexpanded glob names no single file");
  assert.deepEqual(readTargets("cat $FILE", root), [], "a variable we cannot expand names no file");
  assert.deepEqual(readTargets("cat $(ls)", root), [], "a substitution names no file");
  assert.deepEqual(readTargets("cat src", root), [], "a directory is not a read");
});

test("commands that are not reads are ignored", () => {
  const root = project();
  for (const cmd of ["rm notes.md", "git diff notes.md", "wc -l notes.md", "grep x notes.md", "npm test"]) {
    assert.deepEqual(readTargets(cmd, root), [], cmd);
  }
});

test("prefixes and absolute command paths do not hide the command", () => {
  const root = project();
  assert.deepEqual(readTargets("/bin/cat notes.md", root), [join(root, "notes.md")]);
  assert.deepEqual(readTargets("sudo cat notes.md", root), [join(root, "notes.md")]);
  assert.deepEqual(readTargets("FOO=1 cat notes.md", root), [join(root, "notes.md")]);
});

test("many files are capped and deduped", () => {
  const root = project();
  for (let i = 0; i < 12; i++) writeFileSync(join(root, `f${i}.txt`), "x");
  const names = Array.from({ length: 12 }, (_, i) => `f${i}.txt`).join(" ");
  assert.equal(readTargets(`cat ${names}`, root).length, 8, "a runaway command must not fan out");
  assert.deepEqual(readTargets("cat notes.md notes.md", root), [join(root, "notes.md")]);
});

// ------------------------------------------------------------------ gating (dumpTargets)
// These feed the blocking hook, so the asymmetry flips: a false match blocks a command the
// agent was right to run. Only whole-file prints straight into the transcript qualify.

test("whole-file prints into the transcript are dump targets", () => {
  const root = project();
  const lock = join(root, "package-lock.json");
  for (const cmd of ["cat package-lock.json", "less package-lock.json", "nl package-lock.json", "/bin/cat package-lock.json", "cd . && cat package-lock.json", "cat notes.md; cat package-lock.json"]) {
    assert.ok(dumpTargets(cmd, root).includes(lock), cmd);
  }
});

test("targeted, piped and redirected reads are never dump targets", () => {
  const root = project();
  for (const cmd of [
    "grep -n left-pad package-lock.json",
    "head -n 20 package-lock.json",
    "tail package-lock.json",
    "sed -n '1,5p' package-lock.json",
    "jq '.packages' package-lock.json",
    "cat package-lock.json | grep left-pad",
    "cat package-lock.json > /dev/null",
    "cat package-lock.json >> out.txt",
    "cat package-lock.json 1>copy",
    "cat package-lock.json &> log",
    "echo cat package-lock.json",
  ]) {
    assert.deepEqual(dumpTargets(cmd, root), [], cmd);
  }
});

test("the search hint is specific for lockfiles and absent where a search makes no sense", () => {
  assert.match(searchHint("lockfile", "package-lock.json"), /grep -n -A3 '"node_modules\/<name>"' package-lock\.json/);
  assert.match(searchHint("lockfile", "Cargo.lock"), /name = "<crate>"/);
  assert.match(searchHint("generated", "src/api/client.ts"), /grep -n '<symbol>' src\/api\/client\.ts/);
  for (const rule of ["secret", "binary", "crafted-path", "always-deny"]) assert.equal(searchHint(rule, "x.lock"), "", rule);
});

test("the search hint never emits an untrusted path it cannot quote", () => {
  assert.equal(searchHint("lockfile", "it's.lock"), "");
  assert.equal(searchHint("lockfile", "a`id`.lock"), "");
  assert.equal(searchHint("lockfile", "a\nb.lock"), "");
  assert.match(searchHint("lockfile", "dir with space/yarn.lock"), /'dir with space\/yarn\.lock'/);
  assert.match(searchHint("lockfile", "-rf.lock"), / \.\/-rf\.lock`/, "a leading dash must not become a flag");
});
