#!/usr/bin/env node
/**
 * Claude Code settings that run Snout inside a Harbor task container: the plugin's own hooks
 * (hooks/hooks.json) pointed at Snout's bundle in the container, plus what enforce mode adds (the
 * read gate and output trimming), with Snout's records kept in <snoutDir> instead of the task's folder.
 * Every hook runs its own process (no local hook server), so a hook never silently goes ungated.
 *
 *   node bench/harbor/settings.mjs <node in container> <snout.mjs in container> <records dir in container>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = process.env.SNOUT_LIB || fileURLToPath(new URL("../../dist/lib.mjs", import.meta.url));
const { gateEntries, squeezeEntries } = await import(pathToFileURL(LIB).href);
const [node, bin, snoutDir] = process.argv.slice(2);
if (!node || !bin || !snoutDir) throw new Error("usage: settings.mjs <node> <snout.mjs> <records dir>");

const plugin = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")).hooks;
const point = (entries) => JSON.parse(JSON.stringify(entries)
  .replaceAll("${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs", bin)
  .replaceAll('"node \\"', `"${node} \\"`));

const hooks = point(plugin);
hooks.PreToolUse = point(gateEntries(bin, false));
hooks.PostToolUse = [...(hooks.PostToolUse ?? []), ...point(squeezeEntries(bin, false))];

process.stdout.write(JSON.stringify({ hooks, env: { SNOUT_MODE: "enforce", SNOUT_DIR: snoutDir } }, null, 2) + "\n");
