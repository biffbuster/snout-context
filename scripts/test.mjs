/** Run the same test files everywhere; Windows needs no worker-process isolation. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const files = readdirSync("test").filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join("test", name));
// Node 24 calls the flag --test-isolation; Node 22 has it as --experimental-test-isolation.
const flags = process.allowedNodeEnvironmentFlags;
const isolation = flags.has("--test-isolation") ? "--test-isolation=none" : flags.has("--experimental-test-isolation") ? "--experimental-test-isolation=none" : null;
const args = ["--test", ...(process.platform === "win32" && isolation ? [isolation] : []), ...files];
const result = spawnSync(process.execPath, args, { stdio: "inherit", windowsHide: true });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
