import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, ratioFor, readTranscriptUsage, fmtTokens } from "../dist/lib.mjs";

test("json packs more tokens per byte than prose", () => {
  assert.ok(ratioFor("a.json") < ratioFor("a.md"));
});

test("estimates scale with size and never go negative", () => {
  assert.equal(estimateTokens(0, "a.ts"), 0);
  assert.equal(estimateTokens(-5, "a.ts"), 0);
  assert.ok(estimateTokens(10_000, "a.ts") > estimateTokens(1_000, "a.ts"));
});

test("transcript usage dedupes by requestId, keeping the largest record", () => {
  const lines = [
    JSON.stringify({ requestId: "r1", message: { usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 10 } } }),
    JSON.stringify({ requestId: "r1", message: { usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 40 } } }),
    JSON.stringify({ requestId: "r2", message: { usage: { input_tokens: 7, cache_creation_input_tokens: 50, output_tokens: 3 } } }),
    "not json at all",
    '{"partial": ',
  ].join("\n");
  const u = readTranscriptUsage(lines);
  assert.equal(u.requests, 2, "the two lines for r1 must collapse to one request");
  assert.equal(u.output, 43);
  assert.equal(u.cacheRead, 100);
  assert.equal(u.cacheCreate, 50);
});

test("a torn final line does not throw", () => {
  assert.doesNotThrow(() => readTranscriptUsage('{"message":{"usage":{"input_tok'));
});

test("token formatting is compact", () => {
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(21_400), "21.4k");
  assert.equal(fmtTokens(2_000_000), "2.00M");
});
