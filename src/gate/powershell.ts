/**
 * Conservative native PowerShell ingress for Codex. The Bash parser remains unchanged for
 * Claude and Unix Codex sessions. Literal whole-file prints qualify for gating, including
 * simple commands inside Codex's pwsh.exe -Command wrapper. Pipelines, redirections,
 * expressions and bounded reads deliberately pass through.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const WHOLE_READ = /^\s*(?:Get-Content|gc|type)\s+(?:-Raw\s+)?(?:(-LiteralPath|-Path)\s+)?(?:"([^"]+)"|'([^']+)'|([^\s"'`;&|<>$(){}\[\]*?]+))\s*(?:-Raw)?\s*$/i;
const PWSH_COMMAND = /^\s*(?:"([^"]+)"|([^\s"'`;&|<>]+))\s+(?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*-Command\s+(?:"([\s\S]*)"|'([\s\S]*)')\s*$/i;

export function powerShellDumpTargets(command: string, cwd: string): string[] {
  const wrapped = PWSH_COMMAND.exec(command);
  const exe = wrapped?.[1] ?? wrapped?.[2];
  const script = exe && /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(exe)
    ? (wrapped?.[3] ?? wrapped?.[4] ?? command)
    : command;
  const targets = new Set<string>();
  for (const part of splitCommands(script)) {
    const match = WHOLE_READ.exec(part);
    if (!match) continue;
    const path = match[2] ?? match[3] ?? match[4];
    if (!path || path.startsWith("-")) continue;
    // -Path interprets wildcards. -LiteralPath does not, but there is still no reason to
    // guess at a path if the user supplied an expansion or expression.
    if (/[`$*?\[\]]/.test(path)) continue;
    const abs = resolve(isAbsolute(path) ? path : resolve(cwd, path));
    try {
      if (existsSync(abs) && statSync(abs).isFile()) targets.add(abs);
    } catch {
      // A missing or inaccessible file should never make the hook fail.
    }
  }
  return [...targets];
}

/** Rewrite only one literal PowerShell read; compound scripts retain the deny path. */
export function boundedPowerShellRead(command: string, cwd: string, target: string, lines: number): string | null {
  if (!Number.isInteger(lines) || lines < 1 || lines > 60) return null;
  const match = /^\s*Get-Content\s+-LiteralPath\s+(?:"([^"`$]+)"|'([^'`$]+)'|([^\s"'`;&|<>$(){}\[\]*?]+))\s*$/i.exec(command);
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!path || /[\r\n]/.test(path) || resolve(cwd, path) !== resolve(target)) return null;
  return `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -TotalCount ${lines}`;
}

/** Split only top-level statements; a semicolon inside a quoted path stays literal. */
function splitCommands(script: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === "`") { i++; continue; }
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && script[i + 1] === "'") i++;
        else quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ";" || ch === "\n" || (ch === "&" && script[i + 1] === "&")) {
      parts.push(script.slice(start, i));
      if (ch === "&") i++;
      start = i + 1;
    }
  }
  parts.push(script.slice(start));
  return parts;
}

/** Search hint that never prints a matching file's entire (possibly huge) line. */
export function powerShellSearchHint(relPath: string): string {
  const quoted = relPath.replace(/'/g, "''");
  return ` Need one fact from it? Search instead of reading it whole: \`Select-String -LiteralPath '${quoted}' -Pattern '<name>' | Select-Object -First 10 LineNumber,Matches\`.`;
}
