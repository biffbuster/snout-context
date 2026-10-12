// Repo map: names linked to the files that declare or use them; a request gets candidate paths.
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMap, candidates, renderCandidates, requestNames, shouldSuggest } from "../dist/lib.mjs";

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "snout-map-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const shop = () => project({
  "src/tax.js": "export function applyTaxRate(order) { return order.total * TAX_RATE; }\nexport const TAX_RATE = 0.2;\n",
  "src/checkout.js": "import { applyTaxRate } from './tax.js';\nexport function checkout(order) { return applyTaxRate(order); }\n",
  "src/cart.js": "export function addItem(cart, item) { cart.items.push(item); }\n",
  "test/tax.test.js": "import { applyTaxRate } from '../src/tax.js';\n// applyTaxRate rounds\n",
  "node_modules/x/index.js": "export function applyTaxRate() {}\n",
});

test("a request naming a function gets the file that declares it first, then its users", () => {
  const { map } = buildMap(shop());
  const cs = candidates(map, "applyTaxRate returns the wrong total for discounted orders");
  assert.equal(cs[0].path, "src/tax.js");
  assert.deepEqual(cs[0].defines, ["applyTaxRate"]);
  assert.ok(cs.some((c) => c.path === "src/checkout.js"));
  assert.ok(!cs.some((c) => c.path.startsWith("node_modules/")), "dependency folders are not indexed");
  assert.ok(!cs.some((c) => c.path === "src/cart.js"));
});

test("plain words in a request reach camelCase and snake_case names", () => {
  assert.ok(requestNames("the tax rate is wrong").has("taxRate"));
  assert.ok(requestNames("the tax rate is wrong").has("tax_rate"));
});

test("unchanged files are reused on rebuild; the agent gets paths, not contents", () => {
  const dir = shop();
  const first = buildMap(dir);
  const again = buildMap(dir, first.map);
  assert.equal(again.read, 0);
  assert.equal(again.reused, first.read);
  const line = renderCandidates(candidates(first.map, "applyTaxRate"));
  assert.match(line, /src\/tax\.js \(defines applyTaxRate/);
  assert.doesNotMatch(line, /order\.total/);
});

test("a name typed exactly as declared points to its file, even when no other file uses it", () => {
  const { map } = buildMap(shop());
  assert.equal(candidates(map, "addItem is slow")[0]?.path, "src/cart.js");
});

test("ordinary words are not anchors unless some file declares them", () => {
  const dir = project({
    "src/a.js": "export function parseOrder(x) { return x; } // drops the past entries\n",
    "docs/a.md": "Old notes: this drops the past entries.\n",
    "docs/b.md": "More notes about past drops.\n",
  });
  const { map } = buildMap(dir);
  assert.deepEqual(candidates(map, "parseOrder drops past entries").map((c) => c.path), ["src/a.js"]);
});

// The hook: opt-in, paths only, logged, silent when the prompt names nothing the map knows.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const submit = (root, prompt) => {
  const r = spawnSync(process.execPath, [CLI, "prompt-submit"], { input: JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "UserPromptSubmit", prompt }), encoding: "utf8" });
  return JSON.parse(r.stdout || "{}");
};

// SWE pilot 2026-10-08 (pytest-dev__pytest-10356): "Please", "Consider" and "changelog" in the
// issue fired four wrong files and missed the one the fix edits.
test("capitalized English words and file-stem words don't anchor or fire the map", () => {
  const { map } = buildMap(project({
    "src/mark/structures.py": "def get_unpacked_marks(obj):\n    return getattr(obj, 'pytestmark', [])\n",
    "src/nodes.py": "# Please keep in sync. Consider the update.\nclass Node:\n    pass\n",
    "src/compat.py": "# Please note: Consider this update when you resolve imports.\n",
    "doc/changelog.rst": "Changelog\n=========\nPlease read. Consider upgrading.\n",
    "src/changelog.py": "def render(): pass\n",
  }));
  const issue = "Consider MRO when obtaining marks for classes. Please see below; a changelog entry would be nice.";
  const cs = candidates(map, issue, 4);
  assert.ok(!cs.some((c) => c.uses.includes("Please") || c.uses.includes("Consider")), JSON.stringify(cs));
  assert.ok(!cs.some((c) => c.defines.includes("changelog")), JSON.stringify(cs));
  assert.equal(shouldSuggest(cs, issue), false);
  // Written as code, the same request finds the declaring file and fires.
  const asCode = "Consider MRO in `get_unpacked_marks` when obtaining marks. A changelog.py entry too.";
  const cs2 = candidates(map, asCode, 4);
  assert.equal(cs2[0].path, "src/mark/structures.py");
  assert.ok(cs2.some((c) => c.path === "src/changelog.py"));
  assert.equal(shouldSuggest(cs2, asCode), true);
});

test("prompt hook: off by default, then suggests files once `snout map on` is set", () => {
  const root = shop();
  assert.equal(submit(root, "applyTaxRate rounds wrong").hookSpecificOutput, undefined, "off by default");
  spawnSync(process.execPath, [CLI, "map", "on"], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const out = submit(root, "applyTaxRate rounds wrong");
  assert.equal(out.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /`src\/tax\.js` \(defines applyTaxRate/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /order\.total/, "no file contents");
  const log = readFileSync(join(root, ".snout/map-suggestions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.ok(log[0].paths.includes("src/tax.js") && log[0].tokensEst > 0);
  assert.equal(submit(root, "make the button blue").hookSpecificOutput, undefined, "nothing named, nothing added");
  assert.ok(existsSync(join(root, ".snout/map.json")));
});
