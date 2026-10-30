// Lessons a person reviews (memory/review.ts): proposed only on a test that passed, a decision the
// user gave or a correction the user made; approved only by a person; shown by search a few at a
// time, cited, and never when stale, weak or another project's; never added to a prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveLesson, checkProposals, editLesson, fittingNotes, lessons, listObservations, localViewer, MEMORY_SKILL, memoryFetch, memoryHint, memorySearch,
  promote, promotionPreview, proposals, proposeLesson, rejectLesson, replaceLesson, storesFor, userPrincipal, verified,
} from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const ANA = "user:aaaaaaaaaaaaaaaa";
const QUOTE = "Fuel sales, for the supplier's portal: tab-separated, litres with three decimals, amounts in whole cents.";
const PASS = { command: "python -m pytest -q", result: "7 passed in 0.13s" };

function setup(key = "billing") {
  const root = mkdtempSync(join(tmpdir(), "snout-lessons-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  mkdirSync(join(root, ".snout", "memory"), { recursive: true });
  const s = storesFor(root, join(root, ".snout"), cfg, key);
  const ctx = { stores: s, snoutDir: join(root, ".snout"), projectDir: root, viewer: localViewer(root, key, ANA), user: ANA, session: "now" };
  return { root, cfg, s, ctx };
}
const lesson = (over = {}) => ({ text: "Fuel sales for the supplier's portal export tab-separated with whole cents, not the invoice format.", basis: "decision", applies: "exporting fuel sales for the supplier's portal", evidence: QUOTE, session: "s1", agent: "claude", ...over });
/** A proposal its record backs, approved by the person. */
function approvedLesson(s, over = {}, said = [QUOTE]) {
  const o = proposeLesson(s, ANA, lesson(over));
  checkProposals(s, { session: o.source.session, agent: "claude", test: PASS, commits: [] }, said);
  return approveLesson(s, o.id);
}
const card = (session, agent, extra = {}) => ({ v: 1, id: session, session, agent, started: "2026-10-29T10:00:00Z", updated: "2026-10-29T10:30:00Z", changed: ["berthbook/cli.py"], rules: [], commits: [], test: PASS, task: "Add berthbook export-invoices for finance", ...extra });

test("a proposal is checked against its session's record: a decision needs the user's own words, a test a passing run, a correction both", () => {
  const { s } = setup();
  const decision = proposeLesson(s, ANA, lesson());
  const invented = proposeLesson(s, ANA, lesson({ text: "The portal export needs a VAT column after the amount.", evidence: "the portal needs a VAT column" }));
  const tested = proposeLesson(s, ANA, lesson({ text: "Run the suite with python -m pytest -q from the project root.", basis: "test", evidence: "python -m pytest -q", applies: "running berthbook's tests" }));
  const correction = proposeLesson(s, ANA, lesson({ text: "Invoice amounts have no thousands separator; finance's sheet breaks on 1.234,50.", basis: "correction", evidence: "no, no thousands separator, the sheet breaks on 1.234,50", applies: "formatting amounts in finance exports" }));
  assert.ok([decision, invented, tested, correction].every((o) => o.status === "proposed" && o.lesson.check === "pending"), "an agent's lesson is a proposal, waiting for its record");

  // The user typed the format (case, quote marks and spacing may differ) and the correction; no test has passed yet.
  checkProposals(s, { session: "s1", test: { command: "python -m pytest -q", result: "1 failed, 6 passed" }, commits: [] }, [`Finance sent rules. ${QUOTE.toUpperCase().replace(/ /g, "  ")}`, "No, no thousands separator, the sheet breaks on 1.234,50!"]);
  const state = () => Object.fromEntries(lessons(s).map((o) => [o.id, o.lesson.check]));
  assert.equal(state()[decision.id], "verified");
  assert.equal(state()[invented.id], "pending", "words the user never typed back nothing");
  assert.equal(state()[tested.id], "pending", "no passing run yet");
  assert.equal(state()[correction.id], "pending", "a correction counts once the work meets it: a passing run or a commit");
  checkProposals(s, { session: "s1", test: PASS, commits: [] }, ["No, no thousands separator, the sheet breaks on 1.234,50!"]);
  assert.equal(state()[tested.id], "verified");
  assert.equal(state()[correction.id], "verified");
  assert.match(lessons(s).find((o) => o.id === tested.id).lesson.checked, /python -m pytest -q → 7 passed/);
  // Another session's record checks nothing of this one's.
  const other = proposeLesson(s, ANA, lesson({ text: "Another session's proposal about the portal export format.", session: "s2" }));
  checkProposals(s, { session: "s1", test: PASS, commits: [] }, [QUOTE]);
  assert.equal(state()[other.id], "pending");
  // Each carries what it was asked to: source session, evidence, date, project and where it applies.
  const d = lessons(s).find((o) => o.id === decision.id);
  assert.deepEqual([d.source.session, d.source.evidence, d.project, d.lesson.applies, d.lesson.basis], ["s1", QUOTE, "billing", "exporting fuel sales for the supplier's portal", "decision"]);
  assert.match(d.created, /^\d{4}-\d\d-\d\d/);
});

test("a test lesson is backed only by its cited passing command", () => {
  const { s } = setup();
  const o = proposeLesson(s, ANA, lesson({ text: "Retries reuse the invoice's original key after a timeout.", basis: "test", evidence: "node --test", applies: "retrying invoice charges" }));
  checkProposals(s, { session: "s1", test: { command: "python -m pytest -q", result: "7 passed" }, commits: [] }, []);
  assert.equal(lessons(s).find((x) => x.id === o.id).lesson.check, "pending");
  assert.throws(() => approveLesson(s, o.id), /doesn't show the evidence/);
  checkProposals(s, { session: "s1", test: { command: "node --test", result: "# pass 7" }, commits: [] }, []);
  assert.equal(lessons(s).find((x) => x.id === o.id).lesson.check, "verified");
});

test("a proposal needs a ground, conditions and, for a decision, the user's words; no secrets", () => {
  const { s } = setup();
  assert.throws(() => proposeLesson(s, ANA, lesson({ basis: "hunch" })), /basis must be one of test, decision, correction/);
  assert.throws(() => proposeLesson(s, ANA, lesson({ applies: "" })), /where the lesson applies/);
  assert.throws(() => proposeLesson(s, ANA, lesson({ evidence: "" })), /quote the user's own words/);
  assert.throws(() => proposeLesson(s, ANA, lesson({ text: "Use api_key=sk-abcdefghijklmnopqrstuv for the portal upload." })), /secret/);
  assert.throws(() => proposeLesson(s, ANA, lesson({ session: null })), /no session on record/);
});

test("only a person approves, and only a proposal its record backs; reject, edit and replace keep the history", () => {
  const { s } = setup();
  const backed = proposeLesson(s, ANA, lesson());
  const unbacked = proposeLesson(s, ANA, lesson({ text: "The portal export needs a VAT column after the amount.", evidence: "the portal needs a VAT column" }));
  checkProposals(s, { session: "s1", test: PASS, commits: [] }, [QUOTE]);
  assert.throws(() => approveLesson(s, unbacked.id), /can't be approved/);
  assert.equal(proposals(s)[0].id, backed.id, "review lists the checked proposal first");

  const edited = editLesson(s, backed.id, { applies: "exporting fuel sales for the supplier's portal (export-fuel)" });
  assert.deepEqual([edited.status, edited.lesson.edited, edited.lesson.check], ["proposed", true, "verified"], "an edit is not a verdict");
  const ok = approveLesson(s, backed.id);
  assert.equal(ok.status, "active");
  assert.equal(ok.lesson.review.verdict, "approved");
  assert.throws(() => approveLesson(s, backed.id), /approved already/);

  const no = rejectLesson(s, unbacked.id, "never asked for");
  assert.deepEqual([no.status, no.lesson.review.verdict, no.lesson.review.note], ["archived", "rejected", "never asked for"]);

  // The person's own wording replaces an approved lesson; the old one is kept, superseded.
  const mine = replaceLesson(s, ANA, ok.id, "Fuel sales for the portal: tab-separated, litres to three decimals, whole cents.");
  assert.equal(mine.supersedes, ok.id);
  assert.equal(listObservations(s).find((o) => o.id === ok.id).status, "superseded");
  // A newer proposal can be approved in an approved lesson's place; a near-repeat of it is not proposed at all.
  assert.equal(proposeLesson(s, ANA, lesson({ text: "Fuel sales for the portal export tab-separated; litres three decimals; amounts whole cents.", session: "s3" })).id, mine.id);
  const newer = proposeLesson(s, ANA, lesson({ text: "Since the October portal update, fuel sales also carry a VAT column after the amount and a header row.", session: "s3" }));
  checkProposals(s, { session: "s3", test: PASS, commits: [] }, [QUOTE]);
  assert.throws(() => approveLesson(s, newer.id, { replaces: ok.id }), /not an approved lesson; nothing was approved/);
  assert.equal(listObservations(s).find((o) => o.id === newer.id).status, "proposed");
  assert.equal(approveLesson(s, newer.id, { replaces: mine.id }).supersedes, mine.id);
});

test("search shows a few approved lessons first, cited; never a proposal, a rejected, replaced or stale one, another project's or a weak match", () => {
  const { root, cfg, s, ctx } = setup();
  writeFileSync(join(root, ".snout", "memory", "s1.json"), JSON.stringify(card("s1", "claude")));
  mkdirSync(join(root, "berthbook"));
  writeFileSync(join(root, "berthbook", "fuel.py"), "def sale_cents(s):\n    return round(s.litres * s.price)\n");
  const good = approvedLesson(s);
  const replaced = approvedLesson(s, { text: "Fuel sales for the supplier's portal export comma-separated in euros.", evidence: "comma separated euros for the portal", session: "s0" }, ["comma separated euros for the portal"]);
  const by = approvedLesson(s, { text: "Fuel sales portal export: tab separated, whole cents, three-decimal litres.", session: "s4" });
  const pending = proposeLesson(s, ANA, lesson({ text: "Fuel sales portal export lists litres before the vessel.", evidence: "litres before the vessel", session: "s5" }));
  checkProposals(s, { session: "s5", test: PASS, commits: [] }, ["litres before the vessel"]);
  const rejected = rejectLesson(s, proposeLesson(s, ANA, lesson({ text: "Fuel sales portal export uses a decimal comma for litres.", session: "s6" })).id);
  const held = approvedLesson(s, { text: "Fuel sales totals for the portal export come from sale_cents in fuel.py.", basis: "test", evidence: "python -m pytest -q", files: ["berthbook/fuel.py"], session: "s7" });
  // Saved without content hashes, so the file's modification time decides whether it changed since.
  appendFileSync(join(root, "berthbook", "fuel.py"), "# changed\n");
  const later = new Date(Date.now() + 5000);
  spawnSync(process.execPath, ["-e", `require("fs").utimesSync(${JSON.stringify(join(root, "berthbook", "fuel.py"))}, ${later.getTime() / 1000}, ${later.getTime() / 1000})`]);
  const otherStores = storesFor(join(root, "..", "elsewhere"), join(root, ".snout"), cfg, "elsewhere");
  const foreign = approvedLesson(otherStores, { text: "Fuel sales for the supplier's portal export as semicolon CSV with VAT." });
  const weak = approvedLesson(s, { text: "Portal uploads over 5 MB are refused; split a month by week.", applies: "uploading files to a web portal", evidence: "uploads over 5 MB are refused", session: "s8" }, ["uploads over 5 MB are refused"]);
  // `replaced` is retired the way review retires a lesson: the person's own wording takes its place.
  const retired = replaceLesson(s, ANA, replaced.id, "Fuel sales for the supplier's portal export tab-separated (replaces the comma rule).");

  const out = memorySearch(ctx, "fuel sales export supplier portal format");
  const ids = [...new Set(out.match(/\bo_[a-f0-9]{12}\b/g))];
  const lines = out.split("\n").slice(1);
  assert.ok(lines[0].includes(" lesson "), "a lesson comes first");
  assert.match(lines.find((l) => l.includes(good.id)), /applies when: exporting fuel sales for the supplier's portal +\(a decision the user gave; session:s1, claude, \d{4}-\d\d-\d\d; approved \d{4}-\d\d-\d\d\)/);
  assert.ok(ids.filter((id) => lines.find((l) => l.includes(id))?.includes(" lesson ")).length <= 3, "a few lessons at most");
  for (const [what, id] of Object.entries({ replaced: replaced.id, pending: pending.id, rejected: rejected.id, held: held.id, foreign: foreign.id, weak: weak.id })) assert.ok(!ids.includes(id), `${what} stays out`);
  assert.ok(ids.includes(good.id) || ids.includes(by.id) || ids.includes(retired.id));
  assert.match(out, /lesson lines were approved by the user/);
  // A question about another topic gets none of them.
  assert.doesNotMatch(memorySearch(ctx, "berth booking crosses midnight invoice"), / lesson /);

  // Fetch opens the evidence: what the record showed and the source session's record.
  const f = memoryFetch(ctx, good.id);
  assert.match(f, /a lesson the user approved/);
  assert.match(f, new RegExp(`evidence: "${QUOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(f, /record: +the user said/);
  assert.match(f, /Source session session:s1 · claude/);
  assert.match(f, /Tests: python -m pytest -q → 7 passed/);
  assert.throws(() => memoryFetch(ctx, pending.id), /No observation/, "a proposal can't be opened by an agent");
});

test("the session-start line counts approved lessons, and says nothing from them", () => {
  const cards = [{ session: "s1", agent: "claude", updated: "2026-10-27T10:00:00Z" }];
  assert.match(memoryHint(cards, "now", "codex", null, 1), /1 earlier session is on record in this project \(latest 2026-10-27, claude\), with 1 lesson the user approved\./);
  assert.doesNotMatch(memoryHint(cards, "now", "codex", null, 0), /lesson/);
  assert.equal(memoryHint([], "now", "codex", null, 2), "", "no records, no line");
});

test("an approved lesson is never added to a prompt on its own, whatever it shares with the prompt", () => {
  const { s } = setup();
  const o = approvedLesson(s);
  assert.equal(verified(o), false);
  assert.deepEqual(fittingNotes("Add the fuel sales export for the supplier's portal in the format finance gave", [o]), []);
});

test("over MCP an agent can only propose: a claim that the user asked is ignored, and the proposal is logged", () => {
  const { root, cfg } = setup();
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  writeFileSync(join(root, ".snout", "state.json"), JSON.stringify({ session: "s1" }));
  const call = (id, name, a) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: a } });
  const input = [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    call(3, "snout_memory_propose", { text: lesson().text, applies_when: lesson().applies, basis: "decision", evidence: QUOTE, user_asked: true }),
    call(4, "snout_memory_propose", { text: lesson().text, applies_when: lesson().applies, evidence: QUOTE })].join("\n") + "\n";
  const env = { ...process.env, SNOUT_CONFIG_DIR: cfg };
  delete env.CI; delete env.SNOUT_TOKEN;
  const replies = spawnSync(process.execPath, [CLI, "mcp", root, "--tools", "snout_memory_search,snout_memory_fetch,snout_memory_propose"], { input, encoding: "utf8", env }).stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.match(replies[0].result.instructions, /propose one short lesson with snout_memory_propose; the user reviews it/);
  assert.deepEqual(replies[1].result.tools.map((t) => t.name), ["snout_memory_search", "snout_memory_fetch", "snout_memory_propose"]);
  assert.match(replies[2].result.content[0].text, /^Proposed o_[a-f0-9]{12}\. .*No session sees it until they approve it/);
  assert.match(replies[3].result.content[0].text, /basis is required/);
  const stores = storesFor(root, join(root, ".snout"), cfg);
  assert.deepEqual(lessons(stores).map((o) => [o.status, o.source.session, o.lesson.check]), [["proposed", "s1", "pending"]]);
  assert.ok(readFileSync(join(root, ".snout", "recall.jsonl"), "utf8").includes('"kind":"propose"'));
});

test("the review commands: review lists every field, approve and reject say what happened", () => {
  const { root, cfg } = setup();
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  const env = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root };
  delete env.CI; delete env.SNOUT_TOKEN;
  const cli = (a) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8", env }).stdout;
  const s = storesFor(root, join(root, ".snout"), cfg);
  const o = proposeLesson(s, userPrincipal(root), lesson());
  checkProposals(s, { session: "s1", test: PASS, commits: [] }, [QUOTE]);
  const review = cli(["memory", "review"]);
  for (const field of ["lesson:", "applies:", "ground:", "evidence:", "record:", "source:"]) assert.ok(review.includes(field), field);
  assert.match(review, /1 lesson to review/);
  assert.match(review, /source: +session:s1 · claude · \d{4}-\d\d-\d\d · project /);
  assert.match(cli(["memory", "approve", o.id]), /^Approved o_/);
  assert.match(cli(["memory", "review"]), /No lessons waiting for review/);
  assert.match(cli(["memory", "review", "--all"]), /approved \d{4}-\d\d-\d\d/);
  assert.match(cli(["memory"]), /Lessons: 1 approved\./);
});

test("promoting lessons into a skill shows a preview and writes only with that preview's code", () => {
  const { root, s } = setup();
  const o = approvedLesson(s);
  const pending = proposeLesson(s, ANA, lesson({ text: "A proposal that was never approved by anyone here.", session: "s9" }));
  assert.throws(() => promotionPreview(root, s, [pending.id], "billing-lessons"), /not an approved lesson/);
  assert.throws(() => promotionPreview(root, s, [o.id], "Billing Lessons"), /lower case/);
  assert.throws(() => promotionPreview(root, s, [o.id], "snout-memory"), /Snout's own skill/);
  const p = promotionPreview(root, s, [o.id], "billing-lessons");
  assert.deepEqual(p.files.map((f) => f.path.replace(root, "").replace(/\\/g, "/")), ["/.claude/skills/billing-lessons/SKILL.md", "/.agents/skills/billing-lessons/SKILL.md"]);
  assert.match(p.files[0].content, /^---\nname: billing-lessons\ndescription: Lessons the user approved/);
  assert.match(p.files[0].content, /Applies when: exporting fuel sales for the supplier's portal\./);
  assert.ok(!existsSync(join(root, ".claude", "skills")), "a preview writes nothing");
  assert.throws(() => promote(p, "00000000"), /not this preview's/);
  promote(p, p.code);
  assert.equal(readFileSync(join(root, ".agents", "skills", "billing-lessons", "SKILL.md"), "utf8"), p.files[0].content);
  // The same lessons, now written: a new preview has another code, so an old approval can't overwrite a changed file.
  assert.notEqual(promotionPreview(root, s, [o.id], "billing-lessons").code, p.code);
});

test("the memory skill the plugin ships is the one `snout init codex` writes, and it says when to skip memory", () => {
  assert.equal(readFileSync(fileURLToPath(new URL("../skills/memory/SKILL.md", import.meta.url)), "utf8"), MEMORY_SKILL);
  assert.match(MEMORY_SKILL, /^---\nname: snout-memory\n/);
  assert.match(MEMORY_SKILL, /Skip memory when:/);
  assert.match(MEMORY_SKILL, /snout_memory_propose/);
  assert.ok(MEMORY_SKILL.split(/\s+/).length < 450, "short");
});
