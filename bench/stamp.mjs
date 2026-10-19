/**
 * What produced a results file: the Snout version and commit it measured. Every harness writes this
 * next to `measuredAt`, so scripts/check-claims.mjs can tell a published number measured on the
 * current release from one left over from an older build.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REPO = new URL("..", import.meta.url);
const git = (...a) => spawnSync("git", a, { cwd: REPO, encoding: "utf8", windowsHide: true }).stdout?.trim() ?? "";

export function stamp() {
  const { version } = JSON.parse(readFileSync(new URL("package.json", REPO), "utf8"));
  // Uncommitted changes under src/ mean the measured build is not exactly `commit`.
  return { snoutVersion: version, commit: git("rev-parse", "--short", "HEAD") || null, dirty: git("status", "--porcelain", "--", "src", "dist") !== "" };
}
