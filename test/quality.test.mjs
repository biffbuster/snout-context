// What may enter the store and what leaves it (memory/quality.ts): no note an instruction file
// already says, no near-repeat of one on record, no agent note nobody asked for, and notes and
// proposals nobody used or reviewed archived, while the person's own notes and approved lessons stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addObservation, applyDistilled, approveLesson, checkProposals, coveredBy, lastUses, likeness, listObservations, localViewer, memoryFetch, memoryPropose,
  memorySave, nearDuplicate, proposeLesson, rejectLesson, restoreObservation, retireUnused, storesFor, verification,
} from "../dist/lib.mjs";

const ANA = "user:aaaaaaaaaaaaaaaa";
const PASS = { command: "node --test", result: "ℹ pass 12" };
const DAY = 86_400_000;

function setup(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "snout-quality-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  mkdirSync(join(root, ".snout", "memory"), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(root, f), body);
  const s = storesFor(root, join(root, ".snout"), cfg, "chargeline");
  const ctx = { stores: s, snoutDir: join(root, ".snout"), projectDir: root, viewer: localViewer(root, "chargeline", ANA), user: ANA, session: "s1", agent: "claude" };
  return { root, s, ctx };
}
const card = (over = {}) => ({ v: 1, id: "s1", session: "s1", agent: "claude", started: "2026-10-29T10:00:00Z", updated: "2026-10-29T10:30:00Z", changed: [], rules: [], commits: [], test: PASS, ...over });
const CLAUDE_MD = `# chargeline

## Working rules
- Run the full suite with \`npm run verify\` before calling work done.
- Amounts are integer cents everywhere; never store floats for money.
`;

test("coveredBy: a test command the instruction file writes out, or a note one paragraph of it nearly says", () => {
  assert.equal(coveredBy({ text: "Run the tests with: npm run verify", tags: ["test"] }, CLAUDE_MD), true);
  assert.equal(coveredBy({ text: "Run the tests with: node --test", tags: ["test"] }, CLAUDE_MD), false, "another command");
  assert.equal(coveredBy({ text: "Money amounts are stored as integer cents, never floats.", tags: [] }, CLAUDE_MD), true);
  assert.equal(coveredBy({ text: "A retry of a charge reuses the invoice's original idempotency key.", tags: [] }, CLAUDE_MD), false);
  assert.equal(coveredBy({ text: "Store cents.", tags: [] }, ""), false, "no instruction file, nothing covered");
});

test("likeness: near-repeats match; a different number or a negation is a different note", () => {
  assert.ok(likeness("Late fees are charged daily in src/fees.ts", "Late fees are charged daily, see src/fees.ts") >= 0.8);
  assert.equal(likeness("Plot rent is 40 euros per season", "Plot rent is 45 euros per season"), 0);
  assert.equal(likeness("Use the retry queue for webhooks", "Don't use the retry queue for webhooks"), 0);
  assert.ok(likeness("Exports go through the CSV writer in src/csv.js", "Webhooks retry three times with backoff") < 0.3);
});

test("save over MCP: an agent's own note is refused, the instruction file's words are refused, a repeat returns the one on record", () => {
  const { ctx } = setup({ "CLAUDE.md": CLAUDE_MD });
  assert.throws(() => memorySave(ctx, { text: "The gateway sandbox is flaky on Mondays.", kind: "gotcha" }), /Not saved: Snout keeps a note only when the user asked/);
  assert.match(memorySave(ctx, { text: "Money is integer cents everywhere, never floats.", kind: "convention", user_asked: true }), /already says this/);
  const first = memorySave(ctx, { text: "Webhook deliveries are retried by the queue worker in src/queue.js.", kind: "fact", user_asked: true });
  assert.match(first, /^Saved o_/);
  assert.match(memorySave(ctx, { text: "Webhook deliveries are retried by the queue worker (src/queue.js).", kind: "fact", user_asked: true }), /^Already remembered as o_/);
  assert.match(memorySave(ctx, { text: "Webhook deliveries are now retried by the scheduler instead of the queue worker in src/queue.js.", kind: "fact", user_asked: true }), /^Saved o_.*replaces/s, "a correction replaces, it is not a repeat");
  assert.equal(listObservations(ctx.stores).filter((o) => o.status === "active").length, 1, "one current note about webhook retries");
});

test("lessons: a repeat of one on record, approved or rejected, is not proposed again; one the instruction file says is refused", () => {
  const { s, ctx } = setup({ "AGENTS.md": CLAUDE_MD });
  const l = { text: "A retry of a charge reuses the invoice's original idempotency key; a new key charged customers twice.", basis: "test", applies: "retrying a charge in chargeline", evidence: "node --test", session: "s1", agent: "claude" };
  const o = proposeLesson(s, ANA, l);
  checkProposals(s, { session: "s1", agent: "claude", test: PASS, commits: [] }, []);
  approveLesson(s, o.id);
  assert.equal(proposeLesson(s, ANA, { ...l, text: "Retrying a charge reuses the invoice's original idempotency key, since a new key charged customers twice.", session: "s2" }).id, o.id);
  const r = proposeLesson(s, ANA, { ...l, text: "Webhook handlers acknowledge first and process the event in the background queue.", applies: "handling provider webhooks", session: "s2" });
  rejectLesson(s, r.id);
  assert.equal(proposeLesson(s, ANA, { ...l, text: "Webhook handlers acknowledge first, then process each event in the background queue.", applies: "handling provider webhooks", session: "s3" }).id, r.id, "turned down once is enough");
  assert.match(memoryPropose(ctx, { text: "Webhook handlers acknowledge first, then process each event in the background queue.", applies_when: "handling provider webhooks", basis: "test", evidence: "node --test" }), /Already on record as .*rejected by the user/);
  assert.throws(() => memoryPropose(ctx, { text: "Amounts are integer cents everywhere; never store floats for money.", applies_when: "any money code in chargeline", basis: "test", evidence: "node --test" }), /instruction file/);
  assert.equal(listObservations(s).length, 2, "the store holds two lessons, not five");
});

test("distill: no test-command note when the instruction file writes the command out; every other rule still saves", () => {
  const { s } = setup();
  const covered = applyDistilled(s, ANA, card({ test: { command: "npm run verify", result: "ℹ pass 40" }, missing: ["flyctl"] }), new Date(), () => false, CLAUDE_MD);
  assert.deepEqual(covered.added.map((o) => o.tags[0]), ["missing"]);
  const kept = applyDistilled(s, ANA, card({ session: "s2" }), new Date(), () => false, CLAUDE_MD);
  assert.match(kept.added[0].text, /^Run the tests with: node --test/);
});

test("decay: proposals unreviewed for 30 days and rule notes unused for 90 are archived; the person's notes and approved lessons stay; use keeps a note", () => {
  const { s, ctx } = setup();
  const long = new Date(Date.now() - 120 * DAY);
  const ruleUsed = applyDistilled(s, ANA, card(), long).added[0];
  const ruleIdle = applyDistilled(s, ANA, card({ session: "s0", test: undefined, missing: ["flyctl"] }), long, () => false).added[0];
  const mine = addObservation(s, ANA, { kind: "fact", text: "Refunds go through the finance queue, never the gateway directly.", via: "manual" }, long);
  const proposal = proposeLesson(s, ANA, { text: "Declined cards are final: never retry a declined charge.", basis: "test", applies: "retrying charges", evidence: "node --test", session: "s1", agent: "claude" }, new Date(Date.now() - 40 * DAY));
  const lesson = proposeLesson(s, ANA, { text: "A retry of a charge reuses the invoice's original idempotency key.", basis: "test", applies: "retrying a charge in chargeline", evidence: "node --test", session: "s1", agent: "claude" }, long);
  checkProposals(s, { session: "s1", agent: "claude", test: PASS, commits: [] }, []);
  approveLesson(s, lesson.id, {}, long);
  appendFileSync(join(ctx.snoutDir, "recall.jsonl"), JSON.stringify({ ts: new Date(Date.now() - 5 * DAY).toISOString(), kind: "inject", items: [ruleUsed.id] }) + "\n");
  const used = lastUses(ctx.snoutDir);
  assert.ok(used.has(ruleUsed.id));
  const gone = retireUnused(s, used).map((o) => o.id).sort();
  assert.deepEqual(gone, [proposal.id, ruleIdle.id].sort());
  const status = Object.fromEntries(listObservations(s).map((o) => [o.id, o.status]));
  assert.equal(status[ruleUsed.id], "active", "fitted to a prompt 5 days ago");
  assert.equal(status[mine.id], "active", "written by the user");
  assert.equal(status[lesson.id], "active", "approved by the user");
  assert.equal(verification(listObservations(s).find((o) => o.id === ruleIdle.id)), "a command-not-found error");
  // Seen again by the rule that saved it: back.
  const back = applyDistilled(s, ANA, card({ session: "s9", test: undefined, missing: ["flyctl"] }), new Date(), () => false);
  assert.equal(back.added[0].id, ruleIdle.id);
  assert.equal(listObservations(s).find((o) => o.id === ruleIdle.id).status, "active");
  assert.equal(restoreObservation(s, mine.id), null, "only a note archived as unused is restored");
});

test("fetch names a note's session and what verified it", () => {
  const { s, ctx } = setup();
  const o = applyDistilled(s, ANA, card()).added[0];
  assert.match(memoryFetch(ctx, o.id), /in session:s1 · verified by: a passing test run/);
});

test("nearDuplicate: a rule's own notes are left to their rules", () => {
  const { s } = setup();
  applyDistilled(s, ANA, card({ test: { command: "npm test", result: "ℹ pass 3" } }));
  assert.equal(nearDuplicate(s, { text: "Run the tests with: npm test -- --watch=false" }), null);
});
