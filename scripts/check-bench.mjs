/** Catch benchmark entry-point syntax errors without starting paid agent runs. */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = readdirSync("bench").filter((name) => name.endsWith(".mjs")).sort();
for (const name of files) {
  const file = join("bench", name);
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) {
    console.error(`Syntax check failed: ${file}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`Benchmark syntax: ${files.length} entry points passed`);