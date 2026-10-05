/** One line for the terminal status line, rendered from the ledger. Live counter. */
import type { DecisionRow } from "../types.js";
import { fmtTokens } from "./tokens.js";
import { totalsOf } from "./report.js";

export function renderStatusline(rows: DecisionRow[], mode: string): string {
  if (rows.length === 0) return "snout · watching";
  const t = totalsOf(rows);
  const pct = t.tokensOfferedEst > 0 ? Math.round((t.tokensAvoidedEst / t.tokensOfferedEst) * 100) : 0;
  const tag = mode === "observe" ? "flagged" : "saved";
  const cost = t.jevCostUsd > 0 ? ` · $${t.jevCostUsd.toFixed(4)}` : "";
  return `snout ${pct}% ${tag} · ~${fmtTokens(t.tokensAvoidedEst)} tok${cost}`;
}
