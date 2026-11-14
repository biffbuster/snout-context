// Better Auth handoff pilot (2026-11-12): the giver was told "Stop after the first callback", the
// left-off note quoted it, and the receiver asked to pick up stopped "as instructed" with the second
// callback undone. A stop bounds one session: the note leaves it out, the record keeps it as history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leftOff, localViewer, memoryFetch, memorySearch, sessionFacts, stopsSession, storesFor } from "../dist/lib.mjs";

const ANA = "user:aaaaaaaaaaaaaaaa";
// The giver's request, verbatim from the pilot's record.
const TASK = "We're adding a consumer-side cancellation report example to the Stripe package. In packages/stripe/examples/cancellation-report.mjs, implement the first callback today: onSubscriptionCancel creates a report keyed by the Stripe subscription ID, with subscriptionId, reportedAt (Stripe event.created, in epoch seconds), and feedback (the provided cancellation feedback or null). Replayed cancellations for the same subscription must leave its report intact. The second callback, onSubscriptionUpdate, is tomorrow's follow-up. Product decided that late feedback should update the existing report in place, preserving reportedAt, and an update with no report should do nothing. A missing or null feedback value must leave any previously captured feedback intact. Stop after the first callback. Leave the project as you normally would for tomorrow.";
const FILE = "packages/stripe/examples/cancellation-report.mjs";
const giver = {
  v: 1, id: "ed75a583", session: "ed75a583", agent: "claude", started: "2026-11-12T20:55:53.825Z", updated: "2026-11-12T20:55:53.825Z",
  changed: [FILE], rules: ["Stop after the first callback.", "Leave the project as you normally would for tomorrow."], commits: [], branch: "HEAD",
  task: TASK, request: `${TASK.slice(0, 399)}…`,
};
const BILLING = [
  /late feedback should update the existing report in place, preserving reportedAt/,
  /an update with no report should do nothing/,
  /A missing or null feedback value must leave any previously captured feedback intact/,
];

test("where a session was told to stop is that session's limit, not a standing instruction", () => {
  for (const s of ["Stop after the first callback.", "Stop here for now.", "Please stop once the tests pass.", "Leave the rest for tomorrow.", "Only do the parser today.", "Let's just do step 1 today and run the tests.", "Don't start the export yet."]) {
    assert.equal(stopsSession(s), true, s);
  }
  for (const s of ["Stop using var in new code.", "Don't push yet.", "Never commit without asking me.", "The second callback, onSubscriptionUpdate, is tomorrow's follow-up.", "Leave the tests alone."]) {
    assert.equal(stopsSession(s), false, s);
  }
});

test("the record of a session lists no stop among its standing instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "snout-stop-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "user", message: { role: "user", content: "Implement the parser. Never commit without asking me. Stop after the first file." } })}\n`);
  assert.deepEqual(sessionFacts(file, dir).rules, ["Never commit without asking me."]);
});

test("asked to continue, the receiver hears the unfinished callback and the billing rules, not the giver's stop", () => {
  const text = leftOff([giver], { now: Date.parse(giver.updated) + 600_000, dirty: new Set([FILE]), branch: "HEAD", prompt: "Pick up where we left off." });
  assert.doesNotMatch(text, /Stop after the first callback/);
  assert.doesNotMatch(text, /Leave the project as you normally would/);
  assert.match(text, /The second callback, onSubscriptionUpdate, is tomorrow's follow-up\./);
  for (const rule of BILLING) assert.match(text, rule);
  assert.match(text, /Left out above: where that session was told to stop\. .* it does not apply to this one\./);
  assert.match(text, /not committed yet: packages\/stripe\/examples\/cancellation-report\.mjs$/m);
  assert.match(text, /\n- The rest is in its record: snout_memory_fetch session:ed75a583$/, "with a source to check");
  assert.ok(text.length <= 1550, `${text.length} characters`);
});

test("a stop inside a longer sentence is cut from it, and the work it names stays", () => {
  const half = { ...giver, task: "Implement the parser and stop there. The formatter is the follow-up.", request: undefined, rules: [] };
  const text = leftOff([half], { now: Date.parse(giver.updated) + 600_000, dirty: new Set([FILE]), prompt: "Continue." });
  assert.match(text, /It was asked: "Implement the parser\. The formatter is the follow-up\."/);
  assert.match(text, /Left out above: where that session was told to stop/);
  const plain = leftOff([{ ...half, task: "Implement the parser. The formatter is the follow-up." }], { now: Date.parse(giver.updated) + 600_000, dirty: new Set([FILE]), prompt: "Continue." });
  assert.doesNotMatch(plain, /Left out above/, "nothing to leave out");
});

test("the record keeps the stop as history, named as that session's, and a search about it finds it", () => {
  const root = mkdtempSync(join(tmpdir(), "snout-stop-rec-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-stop-cfg-"));
  mkdirSync(join(root, ".snout", "memory"), { recursive: true });
  writeFileSync(join(root, ".snout", "memory", "ed75a583.json"), JSON.stringify(giver));
  const s = storesFor(root, join(root, ".snout"), cfg, "auth");
  const ctx = { stores: s, snoutDir: join(root, ".snout"), viewer: localViewer(root, "auth", ANA), user: ANA, session: "now" };
  const f = memoryFetch(ctx, "session:ed75a583");
  assert.match(f, /^Task: .*Stop after the first callback\./m, "the task stays whole");
  assert.match(f, /^Where that session was told to stop \(for that session only; .*\): "Stop after the first callback\." "Leave the project as you normally would for tomorrow\."$/m);
  assert.doesNotMatch(f, /Standing instructions/, "an older record's stops are not standing instructions");
  assert.match(memorySearch(ctx, "what was the stop instruction for the first callback"), /session:ed75a583/);
});

// Handoff benchmark (2026-11-13): a long ask or last words were cut mid-word ("as …ed"), garbling the note.
test("a long ask and long last words are shortened between words, never inside one", () => {
  const words = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}word`).join(" ");
  const task = `Kitchen hours count half. ${words("ask", 120)}`;
  const long = { ...giver, task, request: undefined, rules: [], outcome: words("said", 60) };
  const text = leftOff([long], { now: Date.parse(giver.updated) + 600_000, dirty: new Set([FILE]), prompt: "Pick up where we left off." });
  assert.ok(text.length <= 1550, `${text.length} characters`);
  assert.match(text, /It was asked: "Kitchen hours count half\. ask000word /, "a decision at the start stays");
  assert.match(text, /- Its last words: said000word /);
  const whole = new Set(`${task} ${long.outcome}`.split(" "));
  for (const line of text.split("\n").filter((l) => /^- (It was asked|Its last words):/.test(l))) {
    assert.match(line, / … /, "shortened, with the cut marked between words");
    const body = line.replace(/^- (It was asked|Its last words): "?/, "").replace(/"$/, "");
    for (const w of body.split(" ").filter((w) => w !== "…")) assert.ok(whole.has(w), `"${w}" is not a whole word of the record`);
  }
});
