/**
 * Bundles src/ into two single-file ESM outputs with no runtime dependencies.
 *
 * dist/snout.mjs is committed to the repository on purpose: a hook has to run the moment
 * the plugin is installed, and asking a non-technical user to run a build step first is
 * an install failure. CI verifies the committed bundle matches src/.
 */
import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: false, // a user should be able to read the code that gates their files
  legalComments: "none",
  logLevel: "warning",
  // The dashboard page is authored as HTML and bundled as a string.
  loader: { ".html": "text" },
};

await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/snout.mjs", banner: { js: "#!/usr/bin/env node" } });
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/lib.mjs" });

const cli = readFileSync("dist/snout.mjs", "utf8");

if (/console\.log\(/.test(cli)) {
  // stdout is the hook protocol; a stray console.log silently breaks every hook.
  throw new Error("dist/snout.mjs contains console.log — stdout is reserved for the hook protocol");
}

// Node accepts a shebang only on line 1. A second one anywhere is a syntax error that
// unit tests never see, because they import the library bundle rather than run the CLI.
const shebangs = cli.split("\n").filter((l) => l.startsWith("#!")).length;
if (shebangs !== 1 || !cli.startsWith("#!")) {
  throw new Error(`dist/snout.mjs has ${shebangs} shebang line(s); exactly one, on line 1, is required`);
}

// Prove the artifact actually loads and speaks the protocol before we ship it.
const smoke = spawnSync(process.execPath, ["dist/snout.mjs", "version"], { encoding: "utf8" });
if (smoke.status !== 0 || !/snout/.test(smoke.stdout)) {
  throw new Error(`dist/snout.mjs failed to run: ${smoke.stderr || smoke.stdout}`);
}

for (const f of ["dist/snout.mjs", "dist/lib.mjs"]) {
  console.error(`built ${f} — ${(statSync(f).size / 1024).toFixed(1)} KB`);
}
