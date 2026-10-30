// Repo map: names linked to the files that declare or use them; a request gets candidate paths.
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMap, candidates, renderCandidates, requestNames, shouldSuggest, withoutOutput } from "../dist/lib.mjs";

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

test("a traceback's innermost project frame and a dotted module path locate their files", () => {
  const { map } = buildMap(project({
    "pkg/db/query.py": "def filter(x):\n    return x\n",
    "pkg/db/lookups.py": "class Exact:\n    pass\n",
    "pkg/views.py": "def index(r):\n    return r\n",
    "pkg/__init__.py": "",
  }));
  const tb = [
    "Traceback (most recent call last):",
    '  File "/srv/app/site-packages/pkg/views.py", line 3, in index',
    '  File "/srv/app/site-packages/pkg/db/query.py", line 2, in filter',
    "ValueError: bad",
  ].join("\n");
  const cs = candidates(map, `Saving fails:\n${tb}`);
  assert.equal(cs[0].path, "pkg/db/query.py", "the frame nearest the error ranks first");
  assert.ok(cs.findIndex((c) => c.path === "pkg/views.py") > 0);
  assert.equal(candidates(map, "pkg.db.lookups.Exact is wrong for None")[0]?.path, "pkg/db/lookups.py");
  assert.ok(!candidates(map, "from pkg import views").some((c) => c.path === "pkg/__init__.py"), "a package is not a location");
});

test("a file the issue names by path leads; pasted build logs count little; a reporter's own site file is not the project's", () => {
  const dir = project({
    "build/pipeline.go": "package build\nfunc renderDeferred() {}\nfunc postProcess() {}\n",
    "build/steps.go": "package build\nfunc run() { renderDeferred(); postProcess() }\n",
    "tmpl/transform.go": "package tmpl\nfunc handleWith() { deferNodes() }\n",
    "tmpl/store.go": "package tmpl\nfunc deferNodes() {}\nfunc addDeferred() { handleWith() }\n",
    "docs/layouts/single.html": "<main>{{ .Content }}</main>\n",
  });
  const { map } = buildMap(dir);
  const issue = [
    "Deferred blocks share one escaping mode",
    "```text",
    "INFO  build:  step render deferred count 2 duration 1.7ms",
    "INFO  build:  step postProcess duration 0s",
    "INFO  build:  step render deferred count 2 duration 1.9ms",
    "```",
    "My `layouts/single.html` shows it too. This seems to come from `tmpl/transform.go`, where the block is registered by its body alone.",
  ].join("\n");
  assert.doesNotMatch(withoutOutput(issue), /render deferred/, "the log block is output, not the request");
  assert.match(withoutOutput(issue), /tmpl\/transform\.go/);
  const cs = candidates(map, issue, 4);
  assert.equal(cs[0].path, "tmpl/transform.go");
  assert.equal(cs[0].named, true);
  assert.ok(!cs.some((c) => c.path === "docs/layouts/single.html" && c.named), "a site file named by its tail is the reporter's");
  assert.ok(shouldSuggest(cs, issue));
  assert.match(renderCandidates(cs), /tmpl\/transform\.go \(named in the request/);
  // The same issue without the path: the log's names alone do not fire the hint.
  const noPath = issue.replace(/This seems.*$/, "");
  assert.equal(shouldSuggest(candidates(map, noPath, 4), noPath), false);
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

test("an issue read through MCP gets the files the map ranks for its text; other tools and repeats get nothing new", () => {
  const root = shop();
  spawnSync(process.execPath, [CLI, "mode", "enforce"], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  spawnSync(process.execPath, [CLI, "map", "on"], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const read = (tool_name, body) => {
    const tool_response = [{ type: "text", text: JSON.stringify({ number: 7, title: "Wrong total", body, comments: [{ body: "Seen on discounted orders too." }] }) }];
    const r = spawnSync(process.execPath, [CLI, "squeeze"], { input: JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name, tool_input: { issue_number: 7 }, tool_response }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    return JSON.parse(r.stdout || "{}").hookSpecificOutput?.updatedToolOutput;
  };
  assert.equal(read("mcp__github__issue_read", "`applyTaxRate` rounds the tax wrong when the order has a discount."), undefined, "no map built yet: the hook never builds one itself");
  spawnSync(process.execPath, [CLI, "map"], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } }); // what session start does in the background
  const long = "`applyTaxRate` rounds the tax wrong when the order has a discount. " + "Steps to reproduce: add a discounted item and check out. ".repeat(400);
  const out = read("mcp__github__issue_read", long);
  assert.ok(Array.isArray(out) && out.length === 2, "the issue as it came, plus one note");
  assert.equal(JSON.parse(out[0].text).body, long, "an issue's own text is never shortened");
  assert.match(out[0].text, /"title":"Wrong total"/);
  assert.match(out[1].text, /`src\/tax\.js` \(defines applyTaxRate/);
  // Claude Code passes a result of one text block as a plain string: GitHub's issue reads come this way.
  const asString = JSON.stringify({ issue: { number: 7, title: "Wrong total", body: long } });
  const r = spawnSync(process.execPath, [CLI, "squeeze"], { input: JSON.stringify({ session_id: "s2", cwd: root, hook_event_name: "PostToolUse", tool_name: "mcp__github__issue_read", tool_input: { issue_number: 7 }, tool_response: asString }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const str = JSON.parse(r.stdout || "{}").hookSpecificOutput?.updatedToolOutput;
  assert.ok(typeof str === "string" && str.startsWith(asString + "\n\n"), "a string issue stays a string, whole, with the note after it");
  assert.match(str, /`src\/tax\.js` \(defines applyTaxRate/);
  assert.equal(read("mcp__github__list_issues", "`applyTaxRate` rounds the tax wrong when the order has a discount."), undefined, "a list is not one issue");
  assert.equal(read("mcp__github__get_issue", "The page looks off on mobile, please have a look at it."), undefined, "nothing in the code named, nothing added");
});
