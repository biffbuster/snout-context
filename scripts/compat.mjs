#!/usr/bin/env node
/**
 * Nightly compatibility check: does the latest Claude Code / Codex release still speak the hook
 * contract Snout relies on? Each agent ships its native binary in a per-platform npm package; this
 * downloads the latest one and checks that every hook name and field Snout reads or writes is
 * still in it. A missing one fails the run (a release that renamed a field would silently turn
 * Snout off); a release we cannot fetch is a warning. Also warns when the price table is stale.
 *
 *   node scripts/compat.mjs            # both agents
 *   node scripts/compat.mjs claude     # one
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLATFORM = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;

/** What Snout depends on, per agent. Keep in sync with src/cli.ts and src/agents/adapt.ts. */
const AGENTS = {
  claude: {
    meta: "@anthropic-ai/claude-code",
    // The native binary is an optional dependency named <meta>-<platform>.
    binaryPackage: (version) => `@anthropic-ai/claude-code-${PLATFORM}@${version}`,
    contract: {
      PreToolUse: "the gate (trim, deny, ask)",
      PostToolUse: "Squeeze and repeat-read answers",
      SessionStart: "status line and memory restore",
      UserPromptSubmit: "repo map suggestions",
      PreCompact: "compaction records",
      hookSpecificOutput: "every hook answer",
      permissionDecision: "gate verdicts",
      additionalContext: "memory restore and map",
      updatedToolOutput: "Squeeze output rewriting",
      transcript_path: "memory restore and spend",
      '"startup","resume","clear","compact"': "SessionStart source \"compact\" (memory restore)",
    },
  },
  codex: {
    meta: "@openai/codex",
    // Platform builds are published as versions of the same package: <version>-<platform>.
    binaryPackage: (version) => `@openai/codex@${version}-${PLATFORM}`,
    contract: {
      PreToolUse: "the gate",
      PostToolUse: "post-tool recording",
      SessionStart: "session start and memory restore",
      UserPromptSubmit: "prompt hook",
      PreCompact: "compaction records",
      hookSpecificOutput: "hook answers",
      permissionDecision: "gate verdicts",
      additionalContext: "memory restore",
      transcript_path: "memory restore",
    },
  },
};

const summary = (line) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n"); };
// npm is a .cmd script on Windows, which Node only starts through a shell. Arguments here are fixed words.
const npm = (...a) => execFileSync("npm", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }).trim();

function largestFile(dir) {
  let best = { size: 0, path: "" };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const b = largestFile(p); if (b.size > best.size) best = b; }
    else { const s = statSync(p).size; if (s > best.size) best = { size: s, path: p }; }
  }
  return best;
}

let failed = false;
const only = process.argv[2];
summary("## Agent compatibility\n");
for (const [name, a] of Object.entries(AGENTS)) {
  if (only && only !== name) continue;
  let version;
  try { version = npm("view", `${a.meta}@latest`, "version"); } catch (e) {
    console.log(`::warning::${name}: could not look up the latest ${a.meta} (${String(e.message).split("\n")[0]})`);
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), `compat-${name}-`));
  try {
    const tgz = npm("pack", a.binaryPackage(version), "--silent", "--pack-destination", dir).split("\n").pop();
    execFileSync("tar", ["-xzf", join(dir, tgz), "-C", dir]);
    const bin = largestFile(join(dir, "package"));
    const blob = readFileSync(bin.path);
    const missing = Object.entries(a.contract).filter(([needle]) => blob.indexOf(needle, 0, "latin1") < 0);
    const line = `${name} ${version} (${PLATFORM}): ${missing.length ? `MISSING ${missing.map(([n, why]) => `${n} (${why})`).join(", ")}` : `all ${Object.keys(a.contract).length} contract points present`}`;
    console.log(missing.length ? `::error::${line}` : line);
    summary(`- ${line}`);
    if (missing.length) failed = true;
  } catch (e) {
    console.log(`::warning::${name} ${version}: could not fetch or read the ${PLATFORM} build (${String(e.message).split("\n")[0]})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Prices: a stale table misreports savings. The date is set by hand when prices are checked.
const asOf = readFileSync(new URL("../src/spend/prices.ts", import.meta.url), "utf8").match(/PRICES_AS_OF = "(\d{4}-\d{2}-\d{2})"/)?.[1];
const age = asOf ? Math.floor((Date.now() - Date.parse(asOf)) / 86_400_000) : Infinity;
const priceLine = `price table checked ${asOf ?? "never"} (${age} days ago)`;
console.log(age > 45 ? `::warning::${priceLine}: re-check list prices` : priceLine);
summary(`- ${priceLine}`);

process.exit(failed ? 1 : 0);
