/**
 * Every results file docs/claims.md cites must be in the repository, and, with --strict, must have
 * been measured on this release line (same major.minor as package.json), so a published number
 * never rests on an older build. Files from before results were stamped count as stale.
 *
 *   node scripts/check-claims.mjs            # list each cited file and its version; fail if one is missing
 *   node scripts/check-claims.mjs --strict   # also fail on stale files (the publish workflow runs this)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const strict = process.argv.includes("--strict");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const line = (v) => v?.split(".").slice(0, 2).join(".");
const cited = [...new Set(readFileSync("docs/claims.md", "utf8").match(/[a-z]+-\d{13}\.json/g) ?? [])];

let missing = 0, stale = 0;
for (const name of cited) {
  const file = join("bench/ab-results", name);
  if (!existsSync(file)) { missing++; console.log(`missing  ${name}`); continue; }
  const { snoutVersion, commit, measuredAt } = JSON.parse(readFileSync(file, "utf8"));
  const fresh = line(snoutVersion) === line(version);
  if (!fresh) stale++;
  console.log(`${fresh ? "current" : "stale  "}  ${name}  ${snoutVersion ?? "unstamped"}${commit ? ` @${commit}` : ""}  ${measuredAt?.slice(0, 10) ?? ""}`);
}
console.log(`Claims: ${cited.length} results files cited, ${missing} missing, ${stale} measured before ${line(version)}`);
if (missing || (strict && stale)) process.exitCode = 1;
