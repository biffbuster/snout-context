import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Load the Claude Code plugin hooks from the package, with the benchmark bundle in its place. */
export function shippedClaudeHooks(repo, bin) {
  const hooks = JSON.parse(readFileSync(join(repo, "hooks/hooks.json"), "utf8")).hooks;
  for (const entries of Object.values(hooks)) for (const entry of entries) for (const hook of entry.hooks ?? []) {
    if (hook.command) hook.command = hook.command.replace("${CLAUDE_PLUGIN_ROOT}/dist/snout.mjs", bin);
  }
  return hooks;
}
