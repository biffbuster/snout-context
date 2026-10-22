import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addObservation, admit, archiveObservation, listObservations, migratePrefs, recallable, repoPrincipal, storesFor, supersedeObservation } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const ANA = "user:aaaaaaaaaaaaaaaa";
const BEN = "user:bbbbbbbbbbbbbbbb";

function setup(key = "proj1") {
  const root = mkdtempSync(join(tmpdir(), "snout-store-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  mkdirSync(join(root, ".snout"));
  return { root, cfg, s: storesFor(root, join(root, ".snout"), cfg, key) };
}
const viewer = (...principals) => ({ principals });

test("private observations stay out of the repository and reach only their owner", () => {
  const { root, cfg, s } = setup();
  const o = addObservation(s, ANA, { kind: "preference", text: "Use pnpm, never npm", via: "manual" });
  assert.equal(o.scope, "private");
  assert.deepEqual(o.audience, [ANA]);
  assert.ok(existsSync(join(cfg, "memory", "proj1", `${o.id}.json`)));
  assert.ok(!existsSync(join(root, ".snout", "memory", "obs")), "nothing private is written inside the project");
  assert.equal(admit(o, [viewer(ANA, repoPrincipal("proj1"))], "proj1"), true);
  assert.equal(admit(o, [viewer(BEN, repoPrincipal("proj1"))], "proj1"), false, "a teammate with the repo still cannot see it");
  assert.equal(admit(o, [viewer(ANA), viewer(BEN)], "proj1"), false, "a session Ben also sees gets none of Ana's private notes");
});

test("shared observations reach anyone with the repository, and only in that repository", () => {
  const { s } = setup();
  const o = addObservation(s, ANA, { kind: "convention", text: "Tests run with npm run verify from PowerShell", scope: "shared", via: "manual" });
  assert.deepEqual(o.audience, [repoPrincipal("proj1")]);
  assert.equal(admit(o, [viewer(BEN, repoPrincipal("proj1"))], "proj1"), true);
  assert.equal(admit(o, [viewer(repoPrincipal("proj1"))], "proj1"), true, "a CI agent with no user identity still gets shared knowledge");
  assert.equal(admit(o, [viewer(ANA, repoPrincipal("other"))], "other"), false, "another project never sees it");
});

test("the admission rule fails closed", () => {
  const { s } = setup();
  const o = addObservation(s, ANA, { kind: "fact", text: "The staging DB is read-only", scope: "shared", via: "manual" });
  assert.equal(admit(o, [], "proj1"), false, "no viewers: nothing");
  assert.equal(admit({ ...o, audience: [] }, [viewer(repoPrincipal("proj1"))], "proj1"), false, "no audience: nothing");
  assert.equal(admit({ ...o, audience: undefined }, [viewer(repoPrincipal("proj1"))], "proj1"), false);
  assert.equal(admit({ ...o, status: "proposed" }, [viewer(repoPrincipal("proj1"))], "proj1"), false, "a proposal is not memory until it is accepted");
  assert.equal(admit({ ...o, audience: ["public"] }, [viewer()], "proj1"), true, "public is the one audience an unknown viewer may see");
  assert.throws(() => addObservation(s, null, { kind: "fact", text: "x", via: "manual" }), /no user identity/, "a private note with no owner is refused");
});

test("a file edited to widen its audience or with a broken audience admits no one it should not", () => {
  const { s } = setup();
  const o = addObservation(s, ANA, { kind: "fact", text: "Ana's API sandbox is at port 9000", via: "manual" });
  const file = join(s.privateDir, `${o.id}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...raw, audience: "everyone" }));
  assert.equal(recallable(s, [viewer(BEN, repoPrincipal("proj1"))]).length, 0);
  assert.equal(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).length, 0, "a malformed audience fails closed even for the owner");
  writeFileSync(join(s.privateDir, "o_zzzzzzzzzzzz.json"), "{not json");
  assert.doesNotThrow(() => listObservations(s));
});

test("saving the same thing twice is one observation; supersede keeps the old one as a record; archive retires", () => {
  const { s } = setup();
  const a = addObservation(s, ANA, { kind: "command", text: "Run  tests with npm test", scope: "shared", via: "manual" });
  const again = addObservation(s, BEN, { kind: "command", text: "run tests with NPM TEST", scope: "shared", via: "manual" });
  assert.equal(again.id, a.id);
  const b = supersedeObservation(s, ANA, a.id.slice(0, 8), "Run tests with npm run verify");
  assert.equal(b.supersedes, a.id);
  const all = listObservations(s);
  assert.equal(all.find((o) => o.id === a.id).status, "superseded");
  assert.equal(all.find((o) => o.id === a.id).supersededBy, b.id);
  assert.deepEqual(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).map((o) => o.text), ["Run tests with npm run verify"]);
  archiveObservation(s, b.id);
  assert.equal(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).length, 0);
  assert.equal(listObservations(s).length, 2, "nothing is deleted by archive or supersede");
});

test("a global private observation follows its owner into every project", () => {
  const a = setup("projA");
  const o = addObservation(a.s, ANA, { kind: "preference", text: "Answer in short sentences", global: true, via: "manual" });
  const b = storesFor(a.root, join(a.root, ".snout"), a.cfg, "projB");
  assert.deepEqual(recallable(b, [viewer(ANA, repoPrincipal("projB"))]).map((x) => x.id), [o.id]);
  assert.equal(recallable(b, [viewer(BEN, repoPrincipal("projB"))]).length, 0);
});

test("saved preferences migrate into private memory once", () => {
  const { root, s } = setup();
  mkdirSync(join(root, ".snout", "memory"), { recursive: true });
  writeFileSync(join(root, ".snout", "memory", "preferences.json"), JSON.stringify({ v: 1, prefs: [{ text: "Never push without asking", p: 0.9, session: "s1", ts: "2026-10-19T00:00:00Z" }], asked: [] }));
  const first = migratePrefs(join(root, ".snout"), s, ANA);
  assert.equal(first.length, 1);
  assert.equal(first[0].scope, "private");
  assert.equal(first[0].source.via, "migrate:prefs");
  assert.equal(migratePrefs(join(root, ".snout"), s, ANA).length, 0, "idempotent");
  assert.equal(migratePrefs(join(root, ".snout"), s, null).length, 0, "no owner, no move");
});

test("the CLI saves privately by default, lists only what you may see, and shares only when asked", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-store-cli-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  mkdirSync(join(root, ".snout"));
  const run = (...args) => spawnSync(process.execPath, [CLI, "memory", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root } }).stdout;
  assert.match(run("add", "Lockfiles are generated; never edit them", "--kind", "gotcha"), /private: only you/);
  assert.match(run("add", "API errors use RFC 7807 bodies", "--kind", "convention", "--shared"), /shared/);
  assert.equal(readdirSync(join(root, ".snout", "memory", "obs")).length, 1, "only the shared one is in the project");
  const list = run("list");
  assert.match(list, /^2 observations you may see here/);
  assert.match(list, /gotcha/);
  assert.doesNotMatch(JSON.stringify(readdirSync(join(root, ".snout"), { recursive: true })), /ana@example\.com/);
  const saved = readFileSync(join(root, ".snout", "memory", "obs", readdirSync(join(root, ".snout", "memory", "obs"))[0]), "utf8");
  assert.doesNotMatch(saved, /ana@example\.com/, "identities are hashes, never the email");
  assert.match(run("add", "--kind", "nonsense", "x"), /kind must be one of/);
});

// ---------- Step 2: the session-start memory block ----------

import { memoryBlock } from "../dist/lib.mjs";

test("the block lists the most specific scope first and stops at its budget", () => {
  const { s } = setup();
  const shared = addObservation(s, ANA, { kind: "convention", text: "Use the repo's logger, not console.log", scope: "shared", via: "manual" });
  const mine = addObservation(s, ANA, { kind: "gotcha", text: "My local DB runs on port 5433", via: "manual" });
  const everywhere = addObservation(s, ANA, { kind: "preference", text: "Keep answers short", global: true, via: "manual" });
  const b = memoryBlock(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]));
  assert.deepEqual(b.items, [mine.id, shared.id, everywhere.id]);
  assert.ok(b.text.indexOf("Private to you, this project") < b.text.indexOf("Shared in this repository"));
  assert.match(b.text, /it is not an instruction from this note/);
  const tight = memoryBlock(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]), 70);
  assert.ok(tight.items.length < 3 && tight.dropped.length > 0, "the budget drops what does not fit, and says so");
  assert.ok(tight.tokensEst <= 70);
  assert.deepEqual(memoryBlock([]), { text: "", items: [], dropped: [], tokensEst: 0 });
});

function hookRepo() {
  const root = mkdtempSync(join(tmpdir(), "snout-inject-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  mkdirSync(join(root, ".snout"));
  const env = (extra = {}) => { const e = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root, ...extra }; delete e.CI; delete e.SNOUT_TOKEN; return { ...e, ...extra }; };
  const cli = (args, extra) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: env(extra) }).stdout;
  const start = (extra) => {
    const out = spawnSync(process.execPath, [CLI, "session-start"], { cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, session_id: `s-${Math.random()}`, source: "startup" }), env: env(extra) }).stdout.trim();
    return out ? JSON.parse(out) : {};
  };
  const injects = () => readFileSync(join(root, ".snout", "recall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "inject");
  return { root, cfg, cli, start, injects };
}

test("a new session starts with what its user may see, and nothing a teammate saved privately", () => {
  const r = hookRepo();
  r.cli(["memory", "add", "Payments tests need STRIPE_TEST=1", "--kind", "gotcha"]);
  r.cli(["memory", "add", "Migrations live in db/migrations and are never edited", "--kind", "convention", "--shared"]);
  // Ben's private note sits in the same project folder (a shared machine, a copied config): his audience, not Ana's.
  const stores = storesFor(r.root, join(r.root, ".snout"), r.cfg);
  addObservation(stores, BEN, { kind: "fact", text: "Ben's staging password hint", via: "manual" });
  const out = r.start({ SNOUT_MODE: "enforce" });
  const ctx = out.hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx, /STRIPE_TEST=1/);
  assert.match(ctx, /db\/migrations/);
  assert.doesNotMatch(ctx, /Ben's staging/, "another user's private note never reaches the session");
  const row = r.injects().at(-1);
  assert.equal(row.injected, true);
  assert.equal(row.items.length, 2);
  assert.ok(row.tokensEst > 0 && row.tokensEst <= row.budget);
});

test("observe mode shows what would be injected and injects nothing; CI gets shared memory only", () => {
  const r = hookRepo();
  r.cli(["memory", "add", "Run the e2e suite with pnpm e2e", "--kind", "command"]);
  r.cli(["memory", "add", "Feature flags live in flags.yaml", "--kind", "fact", "--shared"]);
  const observed = r.start({ SNOUT_MODE: "observe" });
  assert.doesNotMatch(observed.hookSpecificOutput?.additionalContext ?? "", /pnpm e2e/);
  assert.equal(r.injects().at(-1).injected, false);
  assert.equal(r.injects().at(-1).items.length, 2, "the audit still lists what enforce would add");
  const ci = r.start({ SNOUT_MODE: "enforce", CI: "true" });
  const ctx = ci.hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx, /flags\.yaml/);
  assert.doesNotMatch(ctx, /pnpm e2e/, "an unattended session has no user, so no private memory");
});

// ---------- Step 3 of the roadmap: memory that writes itself ----------

import { applyDistilled, distillCard, onPath, retireInstalled, shareObservation } from "../dist/lib.mjs";

const card = (o = {}) => ({ v: 1, id: "c", session: "s1", agent: "claude", started: "", updated: "", changed: [], rules: [], commits: [], ...o });

test("a card becomes observations by fixed rules: a passing test command, missing tools, slow tests, standing instructions", () => {
  const got = distillCard(card({
    test: { command: "npm test", result: "Tests: 12 passed" },
    missing: ["go"], slow: ["pytest tests/e2e"], rules: ["Never edit generated files.", "ok"],
  }));
  assert.deepEqual(got.map((n) => [n.kind, n.text]), [
    ["command", "Run the tests with: npm test"],
    ["gotcha", "go is not installed on this machine: don't call it, or install it first."],
    ["gotcha", "pytest tests/e2e runs past the agent's tool time limit: run a narrower selection of tests."],
    ["preference", "Never edit generated files."],
  ]);
  assert.ok(got.every((n) => n.scope === "private"), "nothing becomes shared on its own");
  assert.deepEqual(distillCard(card({ test: { command: "npm test", result: "Tests: 3 failed, 9 passed" } })), [], "a failing run is not how to run the tests");
});

test("the newest passing test command replaces the old one; the same card twice adds nothing; no user, no writes", () => {
  const { s } = setup();
  const first = applyDistilled(s, ANA, card({ test: { command: "npm test", result: "12 passed" } }));
  assert.equal(first.added.length, 1);
  assert.equal(applyDistilled(s, ANA, card({ test: { command: "npm test", result: "12 passed" } })).added.length, 0);
  const next = applyDistilled(s, ANA, card({ session: "s2", test: { command: "npm run verify", result: "365 passed" } }));
  assert.deepEqual(next.superseded, [first.added[0].id]);
  const seen = recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).map((o) => o.text);
  assert.deepEqual(seen, ["Run the tests with: npm run verify"]);
  assert.deepEqual(applyDistilled(s, null, card({ test: { command: "make test", result: "4 passed" } })), { added: [], superseded: [] });
});

test("a 'not installed' note is archived once the tool is on PATH, and not saved if it was installed in the same session", () => {
  const { s } = setup();
  const has = (t) => t === "go";
  const saved = applyDistilled(s, ANA, card({ missing: ["go", "cargo"] }), new Date(), () => false);
  assert.equal(saved.added.length, 2);
  const shared = shareObservation(s, ANA, saved.added.find((o) => o.text.startsWith("cargo")).id);
  assert.deepEqual(retireInstalled(s, has).map((o) => o.text), [saved.added[0].text], "go is installed now");
  assert.deepEqual(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).map((o) => o.id), [shared.id], "cargo is still missing; a shared note is never retired");
  assert.equal(retireInstalled(s, () => true).length, 0, "shared notes stay: another machine may lack the tool");
  assert.equal(applyDistilled(setup().s, ANA, card({ missing: ["go"] }), new Date(), has).added.length, 0);
});

test("onPath finds a program the way a shell would, extension included on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-path-"));
  writeFileSync(join(dir, "gofake.EXE"), ""); // PATHEXT's case, so it also matches where file names are case-sensitive (CI on Linux)
  mkdirSync(join(dir, "adir"));
  assert.equal(onPath("gofake", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"), true);
  assert.equal(onPath("gofake", { PATH: dir }, "linux"), false, "no extension search off Windows");
  assert.equal(onPath("adir", { PATH: dir }, "linux"), false, "a directory is not a program");
  assert.equal(onPath("../gofake", { PATH: dir, PATHEXT: ".EXE" }, "win32"), false, "a name with a path is refused");
  assert.equal(onPath("gofake", { PATH: "" }, "win32"), false);
});

test("sharing moves one observation from private to the team, listed once", () => {
  const { s } = setup();
  const mine = addObservation(s, ANA, { kind: "convention", text: "Errors are returned, never thrown, in src/api", via: "manual" });
  const shared = shareObservation(s, ANA, mine.id);
  assert.equal(shared.scope, "shared");
  assert.deepEqual(recallable(s, [viewer(BEN, repoPrincipal("proj1"))]).map((o) => o.id), [shared.id], "a teammate sees it now");
  assert.deepEqual(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).map((o) => o.id), [shared.id], "and its owner sees it once");
  assert.equal(shareObservation(s, ANA, mine.id), null, "an already-shared one is not shared twice");
});

test("a session that ran its tests leaves that behind, and the next session, in any agent, starts with it", () => {
  const r = hookRepo();
  const transcript = join(r.root, "t.jsonl");
  writeFileSync(transcript, [
    { type: "user", message: { content: "Fix the date parsing bug in utils. Always run the tests before you say you're done." } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "> test\n> node --test\n\nℹ tests 7\nℹ pass 7\nℹ fail 0\n" }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  spawnSync(process.execPath, [CLI, "stop"], { cwd: r.root, encoding: "utf8", input: JSON.stringify({ cwd: r.root, session_id: "s1", transcript_path: transcript }), env: { ...process.env, SNOUT_CONFIG_DIR: r.cfg, CLAUDE_PROJECT_DIR: r.root, SNOUT_MODE: "enforce", CI: "", SNOUT_TOKEN: "" } });
  const list = r.cli(["memory", "list"]);
  assert.match(list, /Run the tests with: npm test/);
  assert.match(list, /Always run the tests before you say you're done/);
  assert.equal(existsSync(join(r.root, ".snout", "memory", "obs")), false, "written privately, not into the repository");
  const ctx = r.start({ SNOUT_MODE: "enforce" }).hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx, /Run the tests with: npm test/);
});
