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
  let activeCwd: string | null = cwd;
  for (const part of splitCommands(script)) {
    // Codex commonly enters a task checkout before reading a relative path. Track only
    // literal directory changes; after an expression or unknown location change, do not
    // guess that a subsequent relative read still refers to the original project root.
    if (/^\s*(?:Set-Location|cd|sl|Push-Location|pushd|Pop-Location|popd)\b/i.test(part)) {
      const location = /^\s*(?:Set-Location|cd|sl)\s+(?:(?:-LiteralPath|-Path)\s+)?(?:"([^"`$]+)"|'([^'`$]+)'|([^\s"'`;&|<>$(){}\[\]*?]+))\s*$/i.exec(part);
      const path = location?.[1] ?? location?.[2] ?? location?.[3];
      const previousCwd = activeCwd;
      activeCwd = null;
      if (path && !/[`$*?\[\]]/.test(path) && (previousCwd || isAbsolute(path))) {
        const directory = resolve(previousCwd ?? cwd, path);
        try {
          if (existsSync(directory) && statSync(directory).isDirectory()) activeCwd = directory;
        } catch {
          // An unresolved location must not make later relative reads target the root.
        }
      }
      continue;
    }
    const match = WHOLE_READ.exec(part);
    if (!match) continue;
    const path = match[2] ?? match[3] ?? match[4];
    if (!path || path.startsWith("-")) continue;
    // -Path interprets wildcards. -LiteralPath does not, but there is still no reason to
    // guess at a path if the user supplied an expansion or expression.
    if (/[`$*?\[\]]/.test(path) || (!activeCwd && !isAbsolute(path))) continue;
    const abs = resolve(isAbsolute(path) ? path : resolve(activeCwd!, path));
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

const PATH_ARG = String.raw`(?:(?:-LiteralPath|-Path)\s+)?(?:"([^"\x60$]+)"|'([^'\x60$]+)'|([^\s"'\x60;&|<>$(){}\[\]*?]+))`;
const TOTAL_COUNT = new RegExp(String.raw`^\s*(?:Get-Content|gc)\s+${PATH_ARG}\s+-(?:TotalCount|Head|First)\s+(\d+)\s*$`, "i");
const SELECT_FIRST = new RegExp(String.raw`^\s*(?:Get-Content|gc)\s+${PATH_ARG}\s*\|\s*Select-Object\s+(?:-Skip\s+(\d+)\s+-First\s+(\d+)|-First\s+(\d+)(?:\s+-Skip\s+(\d+))?)\s*$`, "i");

/**
 * The one file and the lines a PowerShell command prints, when it is a plain ranged read:
 * `Get-Content file -TotalCount 40` (or -Head, -First), or `Get-Content file | Select-Object
 * -Skip 39 -First 40`, also inside Codex's pwsh -Command wrapper. Window "start:count".
 */
export function powerShellRangeRead(command: string, cwd: string): { abs: string; window: string } | null {
  const wrapped = PWSH_COMMAND.exec(command);
  const exe = wrapped?.[1] ?? wrapped?.[2];
  const script = exe && /(?:^|[\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(exe) ? (wrapped?.[3] ?? wrapped?.[4] ?? command) : command;
  let path: string | undefined, start = 1, count = 0;
  const t = TOTAL_COUNT.exec(script);
  const s = t ? null : SELECT_FIRST.exec(script);
  if (t) { path = t[1] ?? t[2] ?? t[3]; count = Number(t[4]); }
  else if (s) { path = s[1] ?? s[2] ?? s[3]; start = 1 + Number(s[4] ?? s[7] ?? 0); count = Number(s[5] ?? s[6]); }
  if (!path || path.startsWith("-") || !Number.isInteger(count) || count < 1) return null;
  const abs = resolve(isAbsolute(path) ? path : resolve(cwd, path));
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return { abs, window: `${start}:${count}` };
}
