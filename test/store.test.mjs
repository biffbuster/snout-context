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
  const env = (extra = {}) => { const e = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root, SNOUT_MEMORY_NOTES: "1", ...extra }; delete e.CI; delete e.SNOUT_TOKEN; return { ...e, ...extra }; };
  const cli = (args, extra) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: env(extra) }).stdout;
  const start = (extra) => {
    const out = spawnSync(process.execPath, [CLI, "session-start"], { cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, session_id: `s-${Math.random()}`, source: "startup" }), env: env(extra) }).stdout.trim();
    return out ? JSON.parse(out) : {};
  };
  const prompt = (text, extra, session = `p-${Math.random()}`) => {
    const out = spawnSync(process.execPath, [CLI, "prompt-submit"], { cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, session_id: session, prompt: text }), env: env(extra) }).stdout.trim();
    return out ? JSON.parse(out).hookSpecificOutput?.additionalContext ?? "" : "";
  };
  const injects = () => readFileSync(join(root, ".snout", "recall.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "inject");
  return { root, cfg, cli, start, prompt, injects };
}

test("a prompt gets the notes it fits that its user may see, with their source, and nothing a teammate saved privately", () => {
  const r = hookRepo();
  r.cli(["memory", "add", "Payments tests need STRIPE_TEST=1", "--kind", "gotcha"]);
  r.cli(["memory", "add", "Migrations live in db/migrations and are never edited", "--kind", "convention", "--shared"]);
  // Ben's private note sits in the same project folder (a shared machine, a copied config): his audience, not Ana's.
  const stores = storesFor(r.root, join(r.root, ".snout"), r.cfg);
  addObservation(stores, BEN, { kind: "fact", text: "Ben's staging password hint", via: "manual" });
  assert.equal(r.start({ SNOUT_MODE: "enforce" }).hookSpecificOutput, undefined, "a new session starts with no block of notes");
  const ctx = r.prompt("The payments tests fail on staging; the password check or the migrations that live in db may be why.", { SNOUT_MODE: "enforce" });
  assert.match(ctx, /"Payments tests need STRIPE_TEST=1" \(added by you; (?:\w+, )?\d{4}-/);
  assert.match(ctx, /db\/migrations/);
  assert.doesNotMatch(ctx, /Ben's staging/, "another user's private note never reaches the session");
  const row = r.injects().at(-1);
  assert.equal(row.injected, true);
  assert.equal(row.items.length, 2);
  assert.ok(row.tokensEst > 0 && row.tokensEst <= row.budget);
  assert.equal(r.prompt("Tidy the README wording.", { SNOUT_MODE: "enforce" }), "", "a prompt no note fits gets nothing");
});

test("observe mode shows what would be injected and injects nothing; CI gets shared memory only", () => {
  const r = hookRepo();
  r.cli(["memory", "add", "Run the e2e suite with pnpm e2e", "--kind", "command"]);
  r.cli(["memory", "add", "Feature flags live in flags.yaml", "--kind", "fact", "--shared"]);
  const task = "Run the e2e suite after the feature flags change.";
  assert.doesNotMatch(r.prompt(task, { SNOUT_MODE: "observe" }), /pnpm e2e/);
  assert.equal(r.injects().at(-1).injected, false);
  assert.equal(r.injects().at(-1).items.length, 2, "the audit still lists what enforce would add");
  const ctx = r.prompt(task, { SNOUT_MODE: "enforce", CI: "true" });
  assert.match(ctx, /flags\.yaml/);
  assert.doesNotMatch(ctx, /pnpm e2e/, "an unattended session has no user, so no private memory");
});

// ---------- Step 3 of the roadmap: memory that writes itself ----------

import { applyDistilled, cite, distillCard, fittingNotes, generalTestCommand, lessonQuestion, onPath, parseLessons, retireInstalled, retireOneOff, shareObservation } from "../dist/lib.mjs";

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
  assert.equal(got.at(-1).status, "proposed", "an instruction waits for a second session");
  assert.deepEqual(distillCard(card({ test: { command: "npm test", result: "Tests: 3 failed, 9 passed" } })), [], "a failing run is not how to run the tests");
});

test("a test command is saved in the form that holds for the next task: the tests one task picked become a placeholder", () => {
  const g = generalTestCommand;
  assert.equal(g(`cd ../.. && go test ./tpl/... ./hugolib -run "Defer"`), "go test <packages>", "Hugo product test: one issue's packages and filter");
  assert.equal(g("GOTOOLCHAIN=local go test -tags integration -count=1 ./config/..."), "GOTOOLCHAIN=local go test -tags integration -count=1 <packages>", "env and flags stay");
  assert.equal(g("go test ./..."), "go test ./...", "the whole project is not a selection");
  assert.equal(g(`cd web && npm test -- -t "adds items"`), "cd web && npm test", "a subproject cd stays");
  assert.equal(g("python -m pytest -q tests/test_ext_viewcode.py::test_viewcode -k slow"), "python -m pytest -q <tests>");
  assert.equal(g("DJANGO_SETTINGS_MODULE=x python tests/runtests.py admin_views.tests.AdminTest --parallel 1"), "DJANGO_SETTINGS_MODULE=x python tests/runtests.py <tests> --parallel 1");
  assert.equal(g("npx vitest run src/cart.test.ts"), "npx vitest run <tests>");
  assert.equal(g("node --test test/*.test.mjs"), "node --test test/*.test.mjs", "a glob over the suite stays");
  assert.equal(g("npm run verify"), "npm run verify");
  assert.equal(g("node bench/x.mjs --chains pytest --n 1"), "node bench/x.mjs --chains pytest --n 1", "a runner named as a flag's value is not the run");
  assert.equal(g("APP_ENV=test node scripts/test.mjs test/checkout.test.mjs"), "APP_ENV=test node scripts/test.mjs <tests>", "a project's own test script, with one task's file dropped");
  assert.equal(g("./run-tests.sh"), "./run-tests.sh");
  const [n] = distillCard(card({ test: { command: `go test ./hugolib -run "Defer"`, result: "ok  github.com/gohugoio/hugo/hugolib 4.1s" } }));
  assert.equal(n.text, "Run the tests with: go test <packages>");
});

test("an instruction about the task at hand is never saved; another is kept once a second session repeats it", () => {
  const { s } = setup();
  const now = ["Do not switch this dirty checkout, stash, reset, commit, merge, or push yet.", "Do not publish npm as part of this step.", "Use an isolated Git worktree if needed to test a clean build.", "Then ensure there are no conflicts."];
  assert.deepEqual(distillCard(card({ rules: now })), [], "tied to the moment: none becomes a note");
  const seen = () => recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).map((o) => o.text);
  applyDistilled(s, ANA, card({ rules: ["Never edit generated files."] }));
  assert.deepEqual(seen(), [], "said once: a proposal, not injected");
  applyDistilled(s, ANA, card({ rules: ["Never edit generated files."] }));
  assert.deepEqual(seen(), [], "the same session again is not a second session");
  const kept = applyDistilled(s, ANA, card({ session: "s2", rules: ["Never edit generated files."] }));
  assert.deepEqual(kept.added.map((o) => [o.status, o.tags.includes("repeated")]), [["active", true]]);
  assert.deepEqual(seen(), ["Never edit generated files."]);
});

test("instructions saved before they had to be repeated: one tied to the moment is archived, others become proposals", () => {
  const { s } = setup();
  const old = (text) => addObservation(s, ANA, { kind: "preference", text, via: "distill", session: "s0", tags: ["rule"] });
  const oneOffNote = old("Do not publish npm as part of this step.");
  const general = old("Run the linter before every commit.");
  const mine = addObservation(s, ANA, { kind: "preference", text: "Keep answers short.", via: "manual" });
  const changed = retireOneOff(s);
  assert.deepEqual(changed.map((o) => [o.id, o.status]).sort(), [[general.id, "proposed"], [oneOffNote.id, "archived"]].sort());
  assert.deepEqual(recallable(s, [viewer(ANA, repoPrincipal("proj1"))]).map((o) => o.id), [mine.id], "what the user saved by hand is untouched");
  assert.equal(retireOneOff(s).length, 0, "runs once: nothing left to change");
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

test("lessons (opt-in, off by default): a session that got past a failure is asked once for a lesson, kept as a checked proposal and never shown on a prompt", () => {
  const r = hookRepo();
  const transcript = join(r.root, "t.jsonl");
  const rows = [
    { type: "user", message: { content: "Add checkout as the API notes describe." } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "node scripts/test.mjs" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "Refusing to run the tests: they write to the store. Set APP_ENV=test." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "APP_ENV=test node scripts/test.mjs" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b2", content: "✔ checkout\nℹ tests 3\nℹ pass 3\nℹ fail 0\n" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Checkout is in and the tests pass." }] } },
  ];
  const write = (extra = []) => writeFileSync(transcript, [...rows, ...extra].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const stop = (extra = {}) => { const o = spawnSync(process.execPath, [CLI, "stop"], { cwd: r.root, encoding: "utf8", input: JSON.stringify({ cwd: r.root, session_id: "s1", transcript_path: transcript, ...extra }), env: { ...process.env, SNOUT_CONFIG_DIR: r.cfg, CLAUDE_PROJECT_DIR: r.root, SNOUT_MODE: "enforce", CI: "", SNOUT_TOKEN: "" } }).stdout.trim(); return o ? JSON.parse(o) : {}; };
  write();
  assert.equal(stop().decision, undefined, "off by default: nothing is asked");
  assert.match(r.cli(["memory", "lessons", "on"]), /Lessons on/);
  const ask = stop();
  assert.equal(ask.decision, "block");
  assert.match(ask.reason, /got past it \(`node scripts\/test\.mjs`: Refusing to run the tests/);
  assert.match(ask.reason, /Already kept, don't repeat: "Run the tests with: APP_ENV=test node scripts\/test\.mjs"/, "the rule-based note is shown so the lesson adds to it");
  write([{ type: "assistant", message: { content: [{ type: "text", text: "Lesson: the suite refuses to run without APP_ENV=test; run `APP_ENV=test node scripts/test.mjs`, npm test needs pnpm, which isn't installed." }] } }]);
  assert.equal(stop({ stop_hook_active: true }).decision, undefined, "asked once: the answer ends the session");
  const review = r.cli(["memory", "review"]);
  assert.match(review, /the suite refuses to run without APP_ENV=test/);
  assert.match(review, /proposed, evidence checked/, "the record shows the failure and the passing run");
  assert.match(review, /record: +APP_ENV=test node scripts\/test\.mjs → .*after "Refusing to run the tests/);
  assert.doesNotMatch(r.cli(["memory", "list"]), /the suite refuses/, "a proposal is not in use until a person approves it");
  assert.equal(stop().decision, undefined, "kept once: a later Stop asks nothing");
  const ctx = r.prompt("Add the webhook and run the tests; the suite refuses to run without the right setting.", { SNOUT_MODE: "enforce" });
  assert.match(ctx, /Run the tests with: APP_ENV=test node scripts\/test\.mjs/, "the verified test command is shown");
  assert.doesNotMatch(ctx, /Lesson|refuses to run without APP_ENV/, "an agent-written lesson is not verified, so it is never shown");
});

test("which notes fit a task: tests for a task with tests, a missing tool the task or its scripts use, two shared words otherwise", () => {
  const { s } = setup();
  const testCmd = addObservation(s, ANA, { kind: "command", text: "Run the tests with: APP_ENV=test node scripts/test.mjs", tags: ["test"], via: "distill" });
  const pnpm = addObservation(s, ANA, { kind: "gotcha", text: "pnpm is not installed on this machine: don't call it, or install it first.", tags: ["missing"], via: "distill" });
  const lesson = addObservation(s, ANA, { kind: "fact", text: "Run tests with APP_ENV=test, the suite refuses otherwise", tags: ["lesson"], via: "lesson" });
  const all = [testCmd, pnpm, lesson];
  const ids = (prompt, scripts) => fittingNotes(prompt, all, { scripts }).map((o) => o.id);
  assert.deepEqual(ids("Add checkout and run the tests.", "pnpm run test:unit"), [testCmd.id, pnpm.id], "the test script calls pnpm");
  assert.deepEqual(ids("Add checkout and run the tests.", "node scripts/test.mjs"), [testCmd.id], "pnpm isn't in play");
  assert.deepEqual(ids("Fix the typo in the README.", "pnpm run test:unit"), [], "no tests, no pnpm: nothing");
  assert.deepEqual(ids("Use pnpm to add the dependency."), [pnpm.id]);
  assert.deepEqual(ids("The docs say pnpm is faster; reword that section."), [], "mentioned, not run");
  assert.deepEqual(ids("Add checkout and run the tests.", "node dist/pnpm-shim.mjs doctor"), [testCmd.id], "a word in a path is not running the tool");
  const old = addObservation(s, ANA, { kind: "preference", text: "Do not push or commit the checkout work yet.", tags: ["rule"], via: "distill" });
  const kept = addObservation(s, ANA, { kind: "preference", text: "Never commit generated checkout files.", tags: ["rule", "repeated"], via: "distill" });
  assert.deepEqual(fittingNotes("Commit the checkout work.", [old, kept]).map((o) => o.id), [kept.id], "an instruction counts only once a second session repeated it");
  assert.ok(!ids("Run tests with APP_ENV=test please.").includes(lesson.id), "an agent's lesson is never shown as verified");
  assert.match(cite(testCmd), /^seen in a passing test run; \d{4}-/);
  // Live, 2026-10-23: a slow-command note from another folder reached a prompt about writing a protocol.
  const elsewhere = addObservation(s, ANA, { kind: "gotcha", text: "cd /c/Users/x/field-test/cli && go test ./internal/... runs past the agent's tool time limit: run a narrower selection of tests.", tags: ["slow"], via: "distill" });
  const here = addObservation(s, ANA, { kind: "gotcha", text: "go test ./... runs past the agent's tool time limit: run a narrower selection of tests.", tags: ["slow"], via: "distill" });
  assert.deepEqual(fittingNotes("Fix the parser and run the tests.", [elsewhere, here]).map((o) => o.id), [here.id]);
  assert.deepEqual(fittingNotes("Reword the README intro.", [here]), []);
});

test("lesson replies: up to two, none of 'none', never a secret", () => {
  assert.deepEqual(parseLessons("Lesson: none"), []);
  assert.deepEqual(parseLessons("Done. Lesson: run migrations with `make db` before tests. Lesson: run migrations with `make db` before tests."), ["run migrations with `make db` before tests."]);
  assert.deepEqual(parseLessons("Lesson: deploys need API_KEY=sk-abcdefghijklmnopqrstuv set"), []);
  assert.equal(lessonQuestion({ recovered: undefined }, []), null, "no failure got past: nothing asked");
});

test("a session that ran its tests leaves that behind, and a later prompt that involves tests, in any agent, gets it", () => {
  const r = hookRepo();
  const transcript = join(r.root, "t.jsonl");
  writeFileSync(transcript, [
    { type: "user", message: { content: "Fix the date parsing bug in utils. Always run the tests before you say you're done." } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "> test\n> node --test\n\nℹ tests 7\nℹ pass 7\nℹ fail 0\n" }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const stop = (session) => spawnSync(process.execPath, [CLI, "stop"], { cwd: r.root, encoding: "utf8", input: JSON.stringify({ cwd: r.root, session_id: session, transcript_path: transcript }), env: { ...process.env, SNOUT_CONFIG_DIR: r.cfg, CLAUDE_PROJECT_DIR: r.root, SNOUT_MODE: "enforce", CI: "", SNOUT_TOKEN: "" } });
  stop("s1");
  let list = r.cli(["memory", "list"]);
  assert.match(list, /Run the tests with: npm test/);
  assert.doesNotMatch(list, /Always run the tests before you say you're done/, "an instruction said once is a proposal");
  assert.equal(existsSync(join(r.root, ".snout", "memory", "obs")), false, "written privately, not into the repository");
  stop("s2");
  list = r.cli(["memory", "list"]);
  assert.match(list, /Always run the tests before you say you're done/, "said in a second session: kept");
  // Session start: only the pointer to the records (memoryHint), nothing from them.
  const start = r.start({ SNOUT_MODE: "enforce" }).hookSpecificOutput?.additionalContext ?? "";
  assert.match(start, /^Snout: 2 earlier sessions are on record in this project/);
  assert.doesNotMatch(start, /npm test|Always run the tests/, "no record content at session start");
  const ctx = r.prompt("Fix the time zone parsing and run the tests.", { SNOUT_MODE: "enforce" });
  assert.match(ctx, /Run the tests with: npm test" \(seen in a passing test run: "npm test → ℹ pass 7"; claude, /, "a later prompt that involves tests gets it, with the record it came from");
});
