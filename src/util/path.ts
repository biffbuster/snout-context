/**
 * Whether a program is on PATH, found the way a shell would find it, without running anything.
 * Memory uses it to drop "not installed" notes once the tool is installed.
 */
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function onPath(name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (!/^[\w.+-]+$/.test(name)) return false;
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (statSync(join(dir, name + ext)).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}
