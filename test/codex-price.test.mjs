import test from "node:test";
import assert from "node:assert/strict";
import { priceCodex } from "../bench/price-codex.mjs";

test("Codex API-equivalent pricing weights cached input and output without treating it as a bill", () => {
  const saved = { agent: "codex", model: "gpt-6-sol", rows: [{
    task: "t", arm: "off", pass: true,
    inputTokens: 1600, uncached: 1000, cacheRead: 500, cacheWrite: 100, outputTokens: 200,
  }] };
  const priced = priceCodex(saved);
  assert.equal(priced.rows[0].apiEquivalentUsd, 0.00435);
  assert.match(priced.priceEstimate.kind, /not an actual/);
  assert.equal(saved.rows[0].apiEquivalentUsd, undefined, "raw result stays unchanged");
  assert.throws(() => priceCodex({ ...saved, rows: [{ ...saved.rows[0], inputTokens: 272001 }] }), /short-context/);
});
