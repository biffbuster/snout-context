/** Run the same test files everywhere; Windows needs no worker-process isolation. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const files = readdirSync("test").filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join("test", name));
const args = ["--test", ...(process.platform === "win32" ? ["--test-isolation=none"] : []), ...files];
const result = spawnSync(process.execPath, args, { stdio: "inherit", windowsHide: true });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
