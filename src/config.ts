import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Mode } from "./types.js";
import { recordError, setErrorLog } from "./util/log.js";

export interface Config {
  mode: Mode;
  sizeCapBytes: number;
  alwaysAllow: string[];
  alwaysDeny: string[];
  redact: string[];
  redactExempt: string[];
  /** Prompt coach: "tip" (local rules, default), "jev" (TypeSafe Jev, opt-in, sends the prompt), "off". */
  coach?: "off" | "tip" | "jev";
  /** Answer a re-read of an unchanged file with one line plus a pointer to the earlier copy. Default on. */
  repeatReads?: boolean;
  /** Whole-file reads of long docs and logs return a section map (docs) or the tail (logs). Default on. */
  longDocs?: boolean;
  /** "concise" adds one short output-style instruction at session start (opt-in); default "normal". */
  output?: "normal" | "concise";
  /**
   * Phase 1+ keys. They are declared so the shape is stable and a user's file survives an
   * upgrade, but NOTHING reads them yet. They are omitted from the defaults written to
   * `.snout/config.json` and from `docs/configuration.md`'s active table: a configuration key
   * that silently does nothing is worse than a missing one, because the user believes they
   * have turned something on.
   */
  model?: string;
  tier2?: { enabled: boolean; budgetMs: number };
  injectContextBlock?: boolean;
  maxInjectedFiles?: number;
  maxInjectedTokens?: number;
}

export { DEFAULTS } from "./defaults.js";
import { DEFAULTS } from "./defaults.js";

/** The model Phase 1 will pin. Declared here so the benchmark and docs cite one constant. */
export const PINNED_MODEL = "jev-1.13.0";

export interface Paths {
  projectDir: string;
  snoutDir: string;
  config: string;
  thresholds: string;
  ledger: string;
  turns: string;
  errors: string;
  /** Heartbeat log: one line per hook invocation, so doctor can prove registration. */
  hooks: string;
  state: string;
  map: string;
}

/**
 * Resolves the project root from the hook payload, falling back to the env var Claude Code
 * sets and then to cwd. `cwd` from the hook is the most reliable of the three.
 */
export function resolvePaths(hookCwd?: string): Paths {
  const projectDir = resolve(hookCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const snoutDir = join(projectDir, ".snout");
  adoptLegacyDir(join(projectDir, ".jev"), snoutDir);
  return {
    projectDir,
    snoutDir,
    config: join(snoutDir, "config.json"),
    thresholds: join(snoutDir, "thresholds.json"),
    ledger: join(snoutDir, "ledger.jsonl"),
    turns: join(snoutDir, "turns.jsonl"),
    errors: join(snoutDir, "errors.jsonl"),
    hooks: join(snoutDir, "hooks.jsonl"),
    state: join(snoutDir, "state.json"),
    map: join(snoutDir, "map.json"),
  };
}

/**
 * Registers where errors go, without creating anything. A read-only command such as
 * `version` or `report` must leave no trace in a directory it was merely run from.
 * The directory itself is created lazily by the first write — see ledger/store.ts.
 */
export function attach(paths: Paths): void {
  setErrorLog(paths.errors);
}

/** Creates .snout on demand. Idempotent and cheap enough to call before every write. */
export function ensureDir(snoutDir: string): void {
  try {
    if (!existsSync(snoutDir)) mkdirSync(snoutDir, { recursive: true });
  } catch (err) {
    recordError("ensureDir", err);
  }
}

/**
 * User-level defaults every project inherits: `~/.snout/config.json`, or `$SNOUT_HOME/config.json`.
 * Same keys as the project file; the project file wins key by key.
 */
export function userConfigPath(): string {
  if (!process.env.SNOUT_HOME) adoptLegacyDir(join(homedir(), ".jev"), join(homedir(), ".snout"));
  return join(process.env.SNOUT_HOME || join(homedir(), ".snout"), "config.json");
}

/** Snout was called jev before 0.2.0: move its data folder over once, so history carries on. */
function adoptLegacyDir(legacy: string, current: string): void {
  try {
    if (!existsSync(current) && existsSync(legacy)) renameSync(legacy, current);
  } catch (err) {
    recordError("adoptLegacyDir", err);
  }
}

/**
 * One layer's own keys, exactly as written in its file. A write changes one key in one
 * layer and nothing else — never the merged view, which would copy user defaults and
 * environment overrides into the project file.
 */
export function readLayer(file: string): Partial<Config> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
    // A user who writes `alwaysAllow: []` means it. Only a malformed value is dropped.
    for (const k of ["alwaysAllow", "alwaysDeny", "redact", "redactExempt"] as const) {
      if (raw[k] !== undefined && !Array.isArray(raw[k])) {
        recordError("loadConfig", new Error(`${file}: ${k} must be an array; ignoring it`));
        delete raw[k];
      }
    }
    if (raw.mode !== undefined && !isValidMode(String(raw.mode))) delete raw.mode;
    return raw;
  } catch (err) {
    recordError("loadConfig", err);
    return {};
  }
}

/** Where a key's effective value comes from, for doctor and apply previews. */
export type ConfigSource = "default" | "user" | "project" | "env";

export function configSource(paths: Paths, key: keyof Config): ConfigSource {
  if (key === "mode" && (process.env.SNOUT_DISABLE || isValidMode(process.env.SNOUT_MODE ?? ""))) return "env";
  if (readLayer(paths.config)[key] !== undefined) return "project";
  if (readLayer(userConfigPath())[key] !== undefined) return "user";
  return "default";
}

/**
 * Config resolution order, last wins: defaults, user (~/.snout/config.json), project
 * (.snout/config.json), environment. A malformed file is reported and ignored rather than
 * crashing a hook — the plugin's worst case must be being useless, never being in the way.
 */
export function loadConfig(paths: Paths): Config {
  const cfg: Config = { ...DEFAULTS, ...readLayer(userConfigPath()), ...readLayer(paths.config) };

  const envMode = process.env.SNOUT_MODE;
  if (envMode === "observe" || envMode === "advise" || envMode === "enforce") cfg.mode = envMode;
  if (process.env.SNOUT_DISABLE) cfg.mode = "observe";

  return cfg;
}

export function isValidMode(v: string): v is Mode {
  return v === "observe" || v === "advise" || v === "enforce";
}
