/** Keep benchmark commands usable inside Codex's Windows sandbox. No global ACL changes. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export function codexToolchainEnv(repo, basePath, workspace) {
  if (process.platform !== "win32") return { PATH: basePath };

  const runtime = process.env.SNOUT_BENCH_CODEX_RUNTIME ?? join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies");
  const pythonDir = process.env.SNOUT_BENCH_CODEX_PYTHON_DIR ?? join(runtime, "python");
  let pnpmBin = process.env.SNOUT_BENCH_CODEX_PNPM_BIN ?? join(runtime, "bin", "fallback");
  const python = join(pythonDir, "python.exe");
  if (!existsSync(python) || !existsSync(join(pnpmBin, "pnpm.cmd"))) {
    throw new Error("Codex benchmark needs sandbox-readable Python and pnpm; set SNOUT_BENCH_CODEX_PYTHON_DIR and SNOUT_BENCH_CODEX_PNPM_BIN");
  }

  // The host's Python is in AppData, which CodexSandboxOffline cannot read. Pytest and
  // its pure-Python dependencies are copied into an ignored, sandbox-readable repo folder.
  const hostPython = process.env.SNOUT_BENCH_HOST_PYTHON ?? "python";
  const found = spawnSync(hostPython, ["-c", "import pytest; from pathlib import Path; print(Path(pytest.__file__).parent.parent); print(pytest.__version__)"], { encoding: "utf8" });
  if (found.status !== 0) throw new Error(`Host Python needs pytest: ${found.stderr || found.error?.message || "unknown error"}`);
  const [site, version] = found.stdout.trim().split(/\r?\n/);
  const pydeps = join(repo, ".snout", "bench-tools", "pydeps");
  const stamp = join(pydeps, ".pytest-source");
  const source = `${site}\n${version}\npydeps-v2\n`;
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== source) {
    mkdirSync(pydeps, { recursive: true });
    const packages = ["_pytest", "pytest", "pluggy", "iniconfig", "packaging", "pygments", "colorama", "py.py"];
    for (const name of readdirSync(site)) {
      if (!packages.includes(name) && !packages.some((pkg) => name.startsWith(`${pkg}-`) && name.endsWith(".dist-info"))) continue;
      cpSync(join(site, name), join(pydeps, name), { recursive: true, force: true, filter: (path) => !/[\\/]__pycache__(?:[\\/]|$)|\.pyc$/.test(path) });
    }
    writeFileSync(stamp, source);
  }

  const env = { ...process.env, PATH: `${pythonDir}${delimiter}${pnpmBin}${delimiter}${basePath}`, PYTHONPATH: pydeps, PYTHONDONTWRITEBYTECODE: "1" };
  const check = spawnSync(python, ["-m", "pytest", "--version"], { encoding: "utf8", env });
  if (check.status !== 0) throw new Error(`Sandbox-readable Python cannot load pytest: ${check.stderr || check.error?.message || "unknown error"}`);
  // Windows pytest otherwise creates its temp files under the operator's AppData,
  // which CodexSandboxOffline cannot read or write.
  const temp = join(workspace, ".snout", "tmp");
  mkdirSync(temp, { recursive: true });
  // Vite pins pnpm in package.json. A different version can silently ignore workspace
  // settings, so fail before using a Codex session if that exact version is not cached.
  const manifest = join(workspace, "package.json");
  const pinned = existsSync(manifest) && /^pnpm@(\d+\.\d+\.\d+)/.exec(JSON.parse(readFileSync(manifest, "utf8")).packageManager ?? "");
  if (pinned) {
    const version = pinned[1];
    const corepackHome = process.env.COREPACK_HOME ?? join(homedir(), "AppData", "Local", "node", "corepack");
    const cached = join(corepackHome, "v1", "pnpm", version);
    // The entry point as the package names it: pnpm 10 ships bin/pnpm.cjs, pnpm 12 bin/pnpm.mjs.
    const entry = pnpmEntry(cached);
    if (!entry) throw new Error(`pnpm ${version} is not cached; run corepack pnpm --version in ${workspace} when the registry is reachable before a Codex pilot`);
    const copy = join(repo, ".snout", "bench-tools", "pnpm", version);
    if (!existsSync(join(copy, entry))) {
      mkdirSync(join(copy, ".."), { recursive: true });
      cpSync(cached, copy, { recursive: true });
    }
    const checkPnpm = spawnSync(process.execPath, [join(copy, entry), "--version"], { cwd: workspace, encoding: "utf8", env: { ...env, COREPACK_ENABLE_NETWORK: "0" } });
    if (checkPnpm.status !== 0 || checkPnpm.stdout.trim() !== version) throw new Error(`Cached pnpm ${version} did not run offline: ${checkPnpm.stderr || checkPnpm.stdout}`);
    pnpmBin = join(repo, ".snout", "bench-tools", "pnpm-bin", version);
    mkdirSync(pnpmBin, { recursive: true });
    writeFileSync(join(pnpmBin, "pnpm.cmd"), `@echo off\r\nnode "${join(copy, entry)}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  }
  return { PATH: `${pythonDir}${delimiter}${pnpmBin}${delimiter}${basePath}`, PYTHONPATH: pydeps, PYTHONDONTWRITEBYTECODE: "1", TEMP: temp, TMP: temp, TMPDIR: temp };
}

/** The cached pnpm's own entry point (its package.json `bin.pnpm`), relative to the package; null when it is not there. */
export function pnpmEntry(dir) {
  try {
    const bin = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).bin;
    const entry = typeof bin === "string" ? bin : bin?.pnpm;
    return entry && existsSync(join(dir, entry)) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Removes a folder a Codex session wrote in. Windows Python makes the folders it creates private
 * (pytest's cache and temp folders), so those belong to the sandbox user and the operator cannot
 * delete them; they are removed as that user, through `codex sandbox` (no model), with the parent
 * folder as its only writable root. Throws if anything is left.
 */
export function removeSandboxed(path) {
  try { rmSync(path, { recursive: true, force: true }); return; } catch (err) { if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTEMPTY"].includes(err.code)) throw err; }
  const codex = process.env.CODEX_CLI_JS || join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  spawnSync(process.execPath, [codex, "sandbox", "-c", 'sandbox_mode="workspace-write"', "--", "powershell.exe", "-NoProfile", "-Command", `Remove-Item -LiteralPath '${path.replace(/'/g, "''")}' -Recurse -Force`], { cwd: dirname(path), encoding: "utf8", timeout: 120_000 });
  rmSync(path, { recursive: true, force: true });
}
