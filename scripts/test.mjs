/** Run the same test files everywhere; Windows needs no worker-process isolation. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const files = readdirSync("test").filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join("test", name));
// Node 24 calls the flag --test-isolation; Node 22 has it as --experimental-test-isolation.
const flags = process.allowedNodeEnvironmentFlags;
const isolation = flags.has("--test-isolation") ? "--test-isolation=none" : flags.has("--experimental-test-isolation") ? "--experimental-test-isolation=none" : null;
const args = ["--test", ...(process.platform === "win32" && isolation ? [isolation] : []), ...files];
// Snout keeps private notes and settings in the user's config folder; a test run gets its own.
const cfg = mkdtempSync(join(tmpdir(), "snout-test-cfg-"));
const result = spawnSync(process.execPath, args, { stdio: "inherit", windowsHide: true, env: { ...process.env, SNOUT_CONFIG_DIR: cfg } });
rmSync(cfg, { recursive: true, force: true });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
