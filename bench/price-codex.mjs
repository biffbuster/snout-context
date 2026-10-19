#!/usr/bin/env node
/**
 * Add a reproducible API-list-price estimate to saved Codex CLI rows, without making API calls.
 * The ChatGPT-plan run itself is not billed at these rates. Codex CLI reports cached reads but
 * does not identify cache-write tokens, so this prices reported cacheWrite (if any) and treats
 * the remaining uncached tokens at the standard input rate. Do not call it an actual bill.
 *
 *   node bench/price-codex.mjs <raw.json> --out <priced.json>
 *   node bench/report.mjs <priced.json> --metric apiEquivalentUsd --margin 5 --out <report-dir>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RATES = {
  "gpt-6-sol": {
    inputPerMillion: 2, cachedInputPerMillion: 0.2,
    cacheWritePerMillion: 2.5, outputPerMillion: 10,
    maxShortContextTokens: 272000,
    checkedAt: "2026-10-19",
    source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
  },
};

export function priceCodex(saved) {
  if (saved.agent !== "codex" || !RATES[saved.model]) throw new Error("unsupported Codex model for API-equivalent pricing");
  const rates = RATES[saved.model];
  const rows = (saved.rows ?? []).map((r) => {
    if (r.error && r.inputTokens === 0) return { ...r, apiEquivalentUsd: null };
    for (const key of ["uncached", "cacheRead", "cacheWrite", "outputTokens", "inputTokens"]) {
      if (!Number.isFinite(r[key]) || r[key] < 0) throw new Error(`${r.task} ${r.arm}: missing or invalid ${key}`);
    }
    if (r.inputTokens > rates.maxShortContextTokens) throw new Error(`${r.task} ${r.arm}: total input exceeds the short-context tier; per-request pricing is unknown`);
    const amount = (r.uncached * rates.inputPerMillion + r.cacheRead * rates.cachedInputPerMillion +
      r.cacheWrite * rates.cacheWritePerMillion + r.outputTokens * rates.outputPerMillion) / 1_000_000;
    return { ...r, apiEquivalentUsd: amount };
  });
  return {
    ...saved, rows,
    priceEstimate: {
      kind: "API list-price equivalent, not an actual ChatGPT-plan charge",
      model: saved.model, rates,
      limitation: "Codex CLI does not separately report cache-write tokens; unreported writes are priced as ordinary uncached input.",
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, flag, out] = process.argv.slice(2);
  if (!source || flag !== "--out" || !out) {
    console.error("usage: node bench/price-codex.mjs <raw.json> --out <priced.json>");
    process.exit(2);
  }
  const priced = priceCodex(JSON.parse(readFileSync(source, "utf8")));
  writeFileSync(out, JSON.stringify(priced, null, 2) + "\n");
  console.log(`Wrote ${out}: ${priced.rows.length} Codex rows, estimated from ${priced.priceEstimate.rates.source}`);
}
