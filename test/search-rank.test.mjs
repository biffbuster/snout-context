// Search ordering (memory/tools.ts rankSearch): among several test commands the one sharing the
// question's words first; at the same score, a past fix before a decision; and "-ied" word forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDistilled, approveLesson, checkProposals, localViewer, memorySearch, proposeLesson, storesFor, variants } from "../dist/lib.mjs";

const ANA = "user:aaaaaaaaaaaaaaaa";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "snout-rank-"));
  const cfg = mkdtempSync(join(tmpdir(), "snout-cfg-"));
  mkdirSync(join(root, ".snout", "memory"), { recursive: true });
  const s = storesFor(root, join(root, ".snout"), cfg, "bikes");
  return { s, ctx: { stores: s, snoutDir: join(root, ".snout"), viewer: localViewer(root, "bikes", ANA), user: ANA, session: "now" } };
}
const card = (session, command) => ({ v: 1, id: session, session, agent: "claude", started: "2026-10-29T10:00:00Z", updated: "2026-10-29T10:30:00Z", changed: [], rules: [], commits: [], test: { command, result: "ok  	dispatch	0.4s · 12 passed" } });
const first = (out) => out.split("\n")[1] ?? "";

test("-ied words meet their -y form", () => {
  assert.ok(variants("retried").includes("retry"));
  assert.ok(variants("applied").includes("apply"));
  assert.deepEqual(variants("tied"), ["tied"], "too short to have an ending");
});

test("several test commands: the one sharing the question's words goes first", () => {
  const { s, ctx } = setup();
  applyDistilled(s, ANA, card("s1", "cd api && uv run pytest -q"));
  applyDistilled(s, ANA, card("s2", "cd dispatch && go test ./..."));
  assert.match(first(memorySearch(ctx, "api tests")), /cd api && uv run pytest/);
  assert.match(first(memorySearch(ctx, "dispatch tests")), /cd dispatch && go test/);
});

test("at the same score, a lesson resting on a verified fix goes before one resting on a decision", () => {
  const { s, ctx } = setup();
  const say = "Payouts to station owners go out weekly on Mondays, never daily.";
  const approve = (o, said = []) => { checkProposals(s, { session: o.source.session, agent: "claude", test: { command: "pytest", result: "4 passed" }, commits: [] }, said); return approveLesson(s, o.id); };
  const decision = approve(proposeLesson(s, ANA, { text: "Station payouts are batched weekly and sent on Mondays.", basis: "decision", applies: "changing station payouts", evidence: say, session: "s1", agent: "claude" }), [say]);
  const fix = approve(proposeLesson(s, ANA, { text: "Station payouts are deduplicated by payout id before sending.", basis: "test", applies: "changing station payouts", evidence: "pytest", session: "s2", agent: "claude" }));
  const out = memorySearch(ctx, "station payouts");
  assert.ok(out.indexOf(fix.id) < out.indexOf(decision.id), out);
});
