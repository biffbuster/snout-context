/**
 * Every results file docs/claims.md cites must be in the repository, and, with --strict, must have
 * been measured on this exact package version. A release also needs at least one current result;
 * an empty claim ledger must not pass the publish gate. Unstamped files count as stale.
 *
 *   node scripts/check-claims.mjs            # list each cited file and its version; fail if one is missing
 *   node scripts/check-claims.mjs --strict   # also fail on stale files (the publish workflow runs this)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const strict = process.argv.includes("--strict");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const cited = [...new Set(readFileSync("docs/claims.md", "utf8").match(/[a-z]+-\d{13}\.json/g) ?? [])];
const bundle = existsSync("dist/snout.mjs")
  ? createHash("sha256").update(readFileSync("dist/snout.mjs")).digest("hex") : null;

let missing = 0, stale = 0;
for (const name of cited) {
  const file = join("bench/ab-results", name);
  if (!existsSync(file)) { missing++; console.log(`missing  ${name}`); continue; }
  const result = JSON.parse(readFileSync(file, "utf8"));
  const { snoutVersion, commit, measuredAt } = result;
  const measuredBundle = result.bundleSha256 ?? result.frozen?.snoutDistSha256;
  const dirty = result.dirty ?? result.frozen?.snoutDirty;
  const fresh = snoutVersion === version && dirty === false && !!bundle && measuredBundle === bundle;
  if (!fresh) stale++;
  console.log(`${fresh ? "current" : "stale  "}  ${name}  ${snoutVersion ?? "unstamped"}${commit ? ` @${commit}` : ""}  ${measuredAt?.slice(0, 10) ?? ""}`);
}
console.log(`Claims: ${cited.length} results files cited, ${missing} missing, ${stale} not measured on the clean ${version} bundle`);
if (strict && cited.length === 0) console.log("No current results cited; release claims remain unverified.");
if (missing || (strict && (stale || cited.length === 0))) process.exitCode = 1;
