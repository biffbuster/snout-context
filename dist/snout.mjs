#!/usr/bin/env node

// src/cli.ts
import { copyFileSync, existsSync as existsSync16, mkdirSync as mkdirSync10, mkdtempSync as mkdtempSync2, readdirSync as readdirSync5, readFileSync as readFileSync19, readSync as readSync4, rmSync as rmSync3, statSync as statSync16, writeFileSync as writeFileSync6, writeSync } from "node:fs";
import { createHash as createHash4 } from "node:crypto";
import { spawn as spawn2, spawnSync as spawnSync4 } from "node:child_process";
import { basename as basename6, dirname as dirname10, isAbsolute as isAbsolute11, join as join21, resolve as resolve10 } from "node:path";
import { homedir as homedir6, tmpdir as tmpdir2 } from "node:os";

// src/config.ts
import { existsSync as existsSync2, readFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

// src/util/log.ts
import { appendFileSync, existsSync, statSync, truncateSync } from "node:fs";
var errorLogPath = null;
function setErrorLog(p) {
  errorLogPath = p;
}
function debug(...parts) {
  if (!process.env.SNOUT_DEBUG) return;
  process.stderr.write(`[snout] ${parts.map(fmt).join(" ")}
`);
}
function recordError(where, err) {
  const line = JSON.stringify({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    where,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  });
  debug("error", line);
  if (!errorLogPath) return;
  try {
    if (existsSync(errorLogPath) && statSync(errorLogPath).size > 1048576) {
      truncateSync(errorLogPath, 0);
    }
    appendFileSync(errorLogPath, line + "\n");
  } catch {
  }
}
function fmt(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

// src/defaults.ts
var DEFAULTS = {
  mode: "observe",
  sizeCapBytes: 2e5,
  // Kept deliberately short. Every entry here outranks all of our heuristics, including
  // the size cap, so a broad pattern is a way to silently un-classify large parts of a
  // repo. Test files are NOT listed: they are better judged on merit by the later tiers.
  alwaysAllow: ["README.md", "CLAUDE.md", "AGENTS.md"],
  // Only what the built-in rules do NOT already cover. Duplicating a rule here is how
  // two policies end up disagreeing: the list runs before the rules, so a list entry
  // silently overrides a rule's more nuanced verdict.
  alwaysDeny: ["**/*.lock"],
  // Credential FILES, not files that discuss credentials.
  //
  // Two substring patterns lived here and were wrong: one for "secret" and one for
  // "credential" anywhere in a path. They matched `src/secrets-manager.ts` and
  // `docs/secret-handling.md` — ordinary source and docs that a user then got prompted
  // about on every single read. Because the secret rule deliberately ignores mode, there
  // was no way to turn that off short of editing this list by hand.
  //
  // A name-substring heuristic cannot tell a key from an essay about keys. These patterns
  // name file shapes that hold credentials instead.
  redact: [
    "**/.env",
    "**/.env.*",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/id_ecdsa*",
    "**/*.pem",
    "**/*.p12",
    "**/*.pfx",
    "**/*.keystore",
    "**/*.jks",
    "**/.npmrc",
    "**/.netrc",
    "**/.pgpass",
    "**/.htpasswd",
    "**/credentials",
    "**/credentials.json",
    "**/service-account*.json",
    "**/.aws/**",
    "**/.ssh/**",
    "**/.gnupg/**"
  ],
  // Exceptions to the list above, checked first. `.env.example` is committed on purpose,
  // read constantly, and holds no secret. Treating it as one is pure friction.
  redactExempt: [
    "**/.env.example",
    "**/.env.sample",
    "**/.env.template",
    "**/.env.defaults",
    "**/.env.dist",
    "**/.env.schema",
    "**/.env.test.example"
  ]
};

// src/config.ts
function resolvePaths(hookCwd) {
  const projectDir = projectRootOf(resolve(hookCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
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
    map: join(snoutDir, "map.json")
  };
}
function attach(paths) {
  setErrorLog(paths.errors);
}
function ensureDir(snoutDir) {
  try {
    if (!existsSync2(snoutDir)) mkdirSync(snoutDir, { recursive: true });
  } catch (err) {
    recordError("ensureDir", err);
  }
}
function userConfigPath() {
  if (!process.env.SNOUT_HOME) adoptLegacyDir(join(homedir(), ".jev"), join(homedir(), ".snout"));
  return join(process.env.SNOUT_HOME || join(homedir(), ".snout"), "config.json");
}
function projectRootOf(dir) {
  const declared = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : null;
  if (declared && isInside(dir, declared)) return declared;
  const home = resolve(homedir());
  for (let d = dir; ; d = dirname(d)) {
    if (d === home || dirname(d) === d) return dir;
    if (existsSync2(join(d, ".snout"))) return d;
  }
}
var isInside = (dir, root) => {
  const rel = relative(root, dir);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
};
function adoptLegacyDir(legacy, current) {
  try {
    if (!existsSync2(current) && existsSync2(legacy)) renameSync(legacy, current);
  } catch (err) {
    recordError("adoptLegacyDir", err);
  }
}
function readLayer(file2) {
  if (!existsSync2(file2)) return {};
  try {
    const raw = JSON.parse(readFileSync(file2, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
    for (const k of ["alwaysAllow", "alwaysDeny", "redact", "redactExempt"]) {
      if (raw[k] !== void 0 && !Array.isArray(raw[k])) {
        recordError("loadConfig", new Error(`${file2}: ${k} must be an array; ignoring it`));
        delete raw[k];
      }
    }
    if (raw.mode !== void 0 && !isValidMode(String(raw.mode))) delete raw.mode;
    return raw;
  } catch (err) {
    recordError("loadConfig", err);
    return {};
  }
}
function configSource(paths, key) {
  if (key === "mode" && (process.env.SNOUT_DISABLE || isValidMode(process.env.SNOUT_MODE ?? ""))) return "env";
  if (readLayer(paths.config)[key] !== void 0) return "project";
  if (readLayer(userConfigPath())[key] !== void 0) return "user";
  return "default";
}
function loadConfig(paths) {
  const cfg = { ...DEFAULTS, ...readLayer(userConfigPath()), ...readLayer(paths.config) };
  const envMode = process.env.SNOUT_MODE;
  if (envMode === "observe" || envMode === "advise" || envMode === "enforce") cfg.mode = envMode;
  if (process.env.SNOUT_DISABLE) cfg.mode = "observe";
  if (process.env.SNOUT_REPO_MAP === "1" || process.env.SNOUT_REPO_MAP === "0") cfg.repoMap = process.env.SNOUT_REPO_MAP === "1";
  return cfg;
}
function isValidMode(v) {
  return v === "observe" || v === "advise" || v === "enforce";
}

// src/gate/tier0.ts
import { openSync, readSync, closeSync, statSync as statSync2, readFileSync as readFileSync2 } from "node:fs";
import { relative as relative2, isAbsolute as isAbsolute2, join as join2 } from "node:path";

// src/util/glob.ts
var cache = /* @__PURE__ */ new Map();
function toRegExp(pattern) {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(pattern, compiled);
  return compiled;
}
function matchesAny(relPath, patterns) {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const pattern of patterns) {
    if (toRegExp(pattern).test(p)) return pattern;
    if (!pattern.includes("/") && !pattern.includes("*")) {
      if (p === pattern || p.startsWith(pattern + "/") || p.includes("/" + pattern + "/")) {
        return pattern;
      }
    }
  }
  return null;
}

// src/util/safe.ts
var MAX_PATH = 160;
function safePath(p) {
  return "`" + escapeInline(p, MAX_PATH) + "`";
}
function safeText(s, max = 80) {
  return escapeInline(s, max);
}
function escapeInline(s, max) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c >= 127 && c <= 159 || c === 8232 || c === 8233) {
      out += "\u241B";
      continue;
    }
    if (c >= 8234 && c <= 8238) {
      out += "\u241B";
      continue;
    }
    if (c >= 8294 && c <= 8297) {
      out += "\u241B";
      continue;
    }
    if (ch === "`") {
      out += "'";
      continue;
    }
    out += ch;
  }
  if (out.length > max) {
    const head = out.slice(0, Math.floor(max * 0.6));
    const tail2 = out.slice(-Math.floor(max * 0.3));
    out = `${head}\u2026${tail2}`;
  }
  return out;
}
function looksCrafted(p) {
  for (const ch of p) {
    const c = ch.codePointAt(0);
    if (c < 32 || c >= 127 && c <= 159) return true;
    if (c >= 8234 && c <= 8238) return true;
    if (c >= 8294 && c <= 8297) return true;
  }
  return false;
}

// src/gate/rules.ts
var LABELS = [
  "read",
  "secret",
  "crafted-path",
  "binary",
  "lockfile",
  "license",
  "vendored",
  "minified",
  "always-deny",
  "snapshot",
  "generated",
  "oversized"
];
var HINT_SCORE = 0.4;
var BINARY_EXT = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "bmp",
  "tiff",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "mp3",
  "mp4",
  "wav",
  "mov",
  "avi",
  "webm",
  "flac",
  "ogg",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "so",
  "dylib",
  "dll",
  "exe",
  "bin",
  "o",
  "a",
  "class",
  "jar",
  "wasm",
  "pyc",
  "pyo",
  "db",
  "sqlite",
  "sqlite3",
  "parquet",
  "npy",
  "pkl",
  "onnx",
  "safetensors"
]);
var LOCKFILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "gradle.lockfile",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
  "flake.lock"
]);
var LICENSE_FILES = /* @__PURE__ */ new Set([
  "LICENSE",
  "LICENSE.txt",
  "LICENSE.md",
  "license.txt",
  "COPYING",
  "COPYING.txt",
  // Aggregated third-party notices; vscode's is 179 KB. Found by bench/label.mjs.
  "ThirdPartyNotices.txt",
  "THIRD-PARTY-NOTICES",
  "THIRD-PARTY-NOTICES.txt",
  "THIRD_PARTY_NOTICES",
  "THIRD_PARTY_NOTICES.txt"
]);
var VENDOR_DIRS = [
  "node_modules",
  ".git",
  "vendor",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".nyc_output",
  ".gradle",
  ".terraform",
  "Pods",
  "DerivedData",
  ".snout"
];
var KNOWN_VENDORED_FILES = /* @__PURE__ */ new Set(["class-pclzip.php", "class-phpass.php", "class-IXR.php"]);
var OUTPUT_DIRS = ["dist", "build", "out", "target", "coverage"];
var GENERATED_PATH_SEGMENTS = ["openapi-spec"];
var GENERATED_FILENAME_SUFFIXES = [
  ".generated.json",
  ".generated.yaml",
  ".generated.yml",
  ".gen.json",
  ".gen.yaml",
  ".gen.yml",
  // GitHub Agentic Workflows compiles `x.md` to `x.lock.yml`; found by bench/label.mjs in dotnet/aspnetcore.
  ".lock.yml"
];
var NO_COMMENT_SYNTAX_EXT = /* @__PURE__ */ new Set(["json", "yaml", "yml"]);
var STRONG_MARKERS = [
  "@generated",
  "Code generated by",
  "Generated by protoc",
  "Generated by the protocol buffer compiler",
  "This file was generated",
  "This file is generated",
  "@nocommit-generated",
  "prisma-client-js",
  "autogenerated by",
  "Automatically generated by"
];
var WEAK_MARKERS = [
  "DO NOT EDIT",
  "do not edit",
  "auto-generated",
  "autogenerated",
  "Automatically generated",
  "This is a generated file"
  // biome's codegen banner, found by bench/label.mjs
];
var GENERATOR_HINT = /\b((?:auto-?)?generat\w*|codegen|protoc|openapi|swagger|graphql-codegen|prisma|thrift|grpc|bindgen|sqlc|jooq|wsdl|xsd|scaffold)\b/i;
var BANNER_LINES = 6;
var RULES = [
  // 0. A path carrying control characters or bidi overrides is itself the finding: no
  // legitimate build writes one, and it is how a repository tries to talk to the model
  // through our own output.
  {
    label: "crafted-path",
    run: (s) => looksCrafted(s.rel) ? {
      verdict: "ask",
      tier: 0,
      rule: "crafted-path",
      value: 0,
      confidence: 1,
      reason: `${safePath(s.rel)} contains control or text-direction characters that no ordinary filename needs. Treat it as untrusted.`,
      warn: true
    } : null
  },
  // 1. Credentials. Highest authority: never classified, never sent anywhere, never
  // silently read. `redactExempt` is checked first so a committed `.env.example` — read
  // constantly and holding nothing — is not treated as a key.
  {
    label: "secret",
    run: (s) => {
      if (matchesAny(s.rel, s.cfg.redactExempt)) return null;
      const secret = matchesAny(s.rel, s.cfg.redact);
      if (!secret) return null;
      return {
        verdict: "ask",
        tier: 0,
        rule: "secret",
        value: 0,
        confidence: 1,
        reason: `${safePath(s.rel)} matches a credential pattern (${safeText(secret)}). snout never sends this file anywhere and does not classify it; confirm before it enters the transcript.`,
        warn: true
      };
    }
  },
  // 2. The user's own allowlist outranks every heuristic below it.
  {
    label: "read",
    run: (s) => {
      const allowed = matchesAny(s.rel, s.cfg.alwaysAllow);
      return allowed ? decision("allow", "always-allow", 3, 1, `${safePath(s.rel)} is on your always-allow list (${safeText(allowed)}).`) : null;
    }
  },
  // 3. Binary content. A coding agent gets nothing usable from these bytes.
  {
    label: "binary",
    run: (s, _n, ext) => ext && BINARY_EXT.has(ext) ? low("binary", `${safePath(s.rel)} is a binary ${safeText(ext.toUpperCase(), 12)} file, so reading it yields no usable text.`) : null
  },
  // 4. Lockfiles: enormous, machine-owned, and almost never what the task needs.
  {
    label: "lockfile",
    run: (s, name) => LOCKFILES.has(name) ? low("lockfile", `${safePath(s.rel)} is a dependency lockfile, written by the package manager rather than by hand.`) : null
  },
  // 4b. Standard license text: uniform boilerplate, not project-specific content.
  {
    label: "license",
    run: (s, name) => LICENSE_FILES.has(name) ? low("license", `${safePath(s.rel)} is standard license text, not project-specific content.`) : null
  },
  // 5. Vendored, built and cached trees.
  {
    label: "vendored",
    run: (s) => {
      const top = s.rel.split("/")[0];
      const vendorDir = firstSegmentMatch(s.rel, VENDOR_DIRS) ?? (s.rel.includes("/") && ROOT_VENDOR_DIRS.includes(top) ? top : null) ?? s.ignoredOutputDir(s.rel);
      return vendorDir ? low("vendored", `${safePath(s.rel)} sits inside ${safeText(vendorDir, 40)}/, a directory of installed or generated output rather than source you maintain.`) : null;
    }
  },
  // 5b. Known third-party files with no vendor directory to catch them. See
  // KNOWN_VENDORED_FILES for why this is a short, verified, exact-match list rather than a
  // content heuristic.
  {
    label: "vendored",
    run: (s, name) => KNOWN_VENDORED_FILES.has(name) ? low("vendored", `${safePath(s.rel)} is a known third-party library bundled directly into this tree, not under a vendor directory.`) : null
  },
  // 6. Minified and source-map output.
  {
    label: "minified",
    run: (s, name) => /\.min\.(js|css|mjs|cjs)$/.test(name) || name.endsWith(".map") ? low("minified", `${safePath(s.rel)} is minified or a source map, so its contents are unreadable to a person and to a model.`) : null
  },
  // 7. The user's own denylist, plus anything in .snoutignore.
  {
    label: "always-deny",
    run: (s) => {
      const denied = matchesAny(s.rel, s.cfg.alwaysDeny) ?? matchesAny(s.rel, s.snoutignore);
      return denied ? low("always-deny", `${safePath(s.rel)} is on your always-deny list (${safeText(denied)}).`) : null;
    }
  },
  // 8. Snapshot and recorded-fixture directories: marginal, not worthless.
  {
    label: "snapshot",
    run: (s, name) => (
      // Recorded output only. Plain fixtures/ folders were dropped: Track A's audit found most of
      // them hold hand-written test inputs, and the ask stopped the agent to read them.
      /(^|\/)(__snapshots__|cassettes)(\/|$)/.test(s.rel) || name.endsWith(".snap") ? marginal("snapshot", `${safePath(s.rel)} is a recorded snapshot or fixture; useful only when the task is specifically about it.`) : null
    )
  },
  // 8b. Binary content, detected from the bytes rather than the name.
  //
  // The extension check above misses compiled output with no extension at all — a Go or
  // Rust binary called `server`, a stripped `a.out`. The eval caught one falling through
  // every rule and being scored worth reading. This reuses the same 2 KB head read as the
  // generator-banner check below, so it costs no extra I/O.
  {
    label: "binary",
    run: (s) => {
      const head = s.head();
      return head && isBinary(head) ? low("binary-content", `${safePath(s.rel)} contains binary data rather than text, so reading it yields nothing usable.`) : null;
    }
  },
  // 9. A generated-file marker in the first 2 KB. One small read, still no network.
  {
    label: "generated",
    run: (s) => {
      const marker = generatedMarker(s.head());
      return marker ? low("generated", `${safePath(s.rel)} declares itself generated ("${safeText(marker, 40)}"), so editing it would be overwritten by the tool that produces it.`) : null;
    }
  },
  // 9b. Generated JSON/YAML that carries no comment syntax to write a banner into — path
  // and filename convention only, since content sniffing cannot work here by construction.
  {
    label: "generated",
    run: (s, name, ext) => {
      if (!ext || !NO_COMMENT_SYNTAX_EXT.has(ext)) return null;
      const genDir = firstSegmentMatch(s.rel, GENERATED_PATH_SEGMENTS);
      if (genDir) {
        return low(
          "generated",
          `${safePath(s.rel)} sits inside ${safeText(genDir, 40)}/, a directory convention for machine-generated ${safeText(ext.toUpperCase(), 6)} output that cannot carry a generator banner.`
        );
      }
      const genSuffix = GENERATED_FILENAME_SUFFIXES.find((x) => name.endsWith(x));
      if (genSuffix) {
        return low(
          "generated",
          `${safePath(s.rel)} is named with the "${safeText(genSuffix, 20)}" convention for machine-generated output, which cannot carry a generator banner.`
        );
      }
      return null;
    }
  },
  // 9c. Built API documentation. A `.docset` bundle is Dash/Xcode output by definition, and
  // jazzy stamps every page it renders with its stylesheet. Found by bench/label.mjs in
  // Alamofire/Alamofire's committed docs/.
  {
    label: "generated",
    run: (s, _name, ext) => {
      const docset = s.rel.split("/").slice(0, -1).find((seg) => seg.endsWith(".docset"));
      if (docset) {
        return low("generated", `${safePath(s.rel)} sits inside ${safeText(docset, 40)}/, a documentation bundle built by a docs generator.`);
      }
      if (ext !== "html") return null;
      const text = decode(s.head());
      return text && /<link[^>]+href="[^"]*\bjazzy\.css"/.test(text) ? low("generated", `${safePath(s.rel)} is a page rendered by the jazzy documentation generator.`) : null;
    }
  },
  // 10. Size cap. Not a value judgement: a file this large crowds out everything else.
  {
    label: "oversized",
    run: (s) => {
      const bytes = s.bytes();
      return bytes > s.cfg.sizeCapBytes ? marginal(
        "oversized",
        `${safePath(s.rel)} is ${(bytes / 1024).toFixed(0)} KB, large enough to crowd out the rest of the conversation. Reading a specific range is usually better than the whole file.`
      ) : null;
    }
  }
];
var HINTS = [
  {
    label: "generated",
    rule: "generated-hint",
    test: (s) => {
      const text = decode(s.head());
      if (!text) return false;
      const banner = text.split("\n", BANNER_LINES).join("\n");
      return WEAK_MARKERS.some((m) => banner.includes(m));
    }
  },
  {
    label: "minified",
    rule: "minified-hint",
    test: (s) => {
      const text = decode(s.head());
      return !!text && text.split("\n").some((line) => line.length >= 1e3);
    }
  },
  {
    label: "snapshot",
    rule: "fixture-hint",
    test: (s, name) => /(^|\/)(testdata|golden|goldens|__mocks__)(\/|$)/.test(s.rel) || /\.golden(\.|$)/.test(name)
  },
  {
    label: "oversized",
    rule: "size-hint",
    test: (s) => s.bytes() > s.cfg.sizeCapBytes / 2
  }
];
function firstHit(s) {
  const name = basename(s.rel);
  const ext = extOf(name);
  for (const r of RULES) {
    const d = r.run(s, name, ext);
    if (d) return d;
  }
  return null;
}
function scoreLabels(s) {
  const name = basename(s.rel);
  const ext = extOf(name);
  const best = /* @__PURE__ */ new Map();
  const put = (x) => {
    const prev = best.get(x.label);
    if (!prev || x.score > prev.score) best.set(x.label, x);
  };
  let allowed = false;
  for (const r of RULES) {
    const d = r.run(s, name, ext);
    if (!d) continue;
    if (d.rule === "always-allow") allowed = true;
    else put({ label: r.label, score: d.confidence, rule: d.rule });
  }
  for (const h of HINTS) {
    if (!best.has(h.label) && h.test(s, name)) put({ label: h.label, score: HINT_SCORE, rule: h.rule, hint: true });
  }
  let strongest = 0;
  for (const x of best.values()) strongest = Math.max(strongest, x.score);
  put({ label: "read", score: allowed ? 1 : round2(1 - strongest), rule: allowed ? "always-allow" : "no-rule" });
  return [...best.values()].sort((a, b) => b.score - a.score || LABELS.indexOf(a.label) - LABELS.indexOf(b.label));
}
function labelOf(d) {
  if (!d || d.verdict === "allow") return "read";
  if (d.rule === "binary-content") return "binary";
  return LABELS.includes(d.rule) ? d.rule : "read";
}
function decision(verdict, rule, value, confidence, reason) {
  return { verdict, tier: 0, rule, value, confidence, reason };
}
function low(rule, reason) {
  return decision("deny", rule, 0, 1, reason);
}
function marginal(rule, reason) {
  return decision("ask", rule, 1, 0.8, reason);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function basename(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}
function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m?.[1]?.toLowerCase() ?? null;
}
function insideDoubleQuotes(line, marker) {
  const i = line.indexOf(marker);
  const count = (t) => (t.match(/"/g) ?? []).length;
  return count(line.slice(0, i)) % 2 === 1 || count(line.slice(i + marker.length)) % 2 === 1;
}
var ROOT_VENDOR_DIRS = ["deps"];
function firstSegmentMatch(rel, dirs) {
  const segments = rel.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (dirs.includes(seg)) return seg;
  }
  return null;
}
function parseGitignore(text) {
  const rules = [];
  for (const line of text.split("\n").slice(0, 2e3)) {
    let p = line.trim();
    if (!p || p.startsWith("#")) continue;
    const negate = p.startsWith("!");
    if (negate) p = p.slice(1);
    p = p.replace(/\/\*\*$/, "").replace(/\/+$/, "");
    if (!p) continue;
    const anchored = p.includes("/");
    rules.push({ negate, anchored, re: toRegExp(p.replace(/^\//, "")) });
  }
  return rules;
}
function ignoredOutputDirIn(rel, rules) {
  const segments = rel.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!OUTPUT_DIRS.includes(seg)) continue;
    const dirRel = segments.slice(0, i + 1).join("/");
    let ignored = false;
    for (const r of rules) {
      if (r.re.test(r.anchored ? dirRel : seg)) ignored = !r.negate;
    }
    if (ignored) return seg;
  }
  return null;
}
var utf8 = new TextDecoder("utf-8");
function decode(head) {
  if (!head || head.length === 0) return null;
  try {
    return utf8.decode(head);
  } catch {
    return null;
  }
}
function isBinary(head) {
  if (head.length === 0) return false;
  let suspicious = 0;
  for (const b of head) {
    if (b === 0) return true;
    if (b < 9 || b > 13 && b < 32) suspicious++;
  }
  return suspicious / head.length > 0.3;
}
function generatedMarker(headBuf) {
  const head = decode(headBuf);
  if (!head) return null;
  for (const marker of STRONG_MARKERS) {
    if (head.includes(marker)) return marker;
  }
  const bannerLines = head.split("\n", BANNER_LINES);
  const banner = bannerLines.join("\n");
  for (const marker of WEAK_MARKERS) {
    const line = bannerLines.find((l) => l.includes(marker));
    if (line && !insideDoubleQuotes(line, marker) && GENERATOR_HINT.test(banner)) return marker;
  }
  return null;
}

// src/gate/tier0.ts
function tier0(input) {
  return firstHit(signalsFor(input));
}
function scoreFile(input) {
  return scoreLabels(signalsFor(input));
}
function signalsFor({ absPath, projectDir, cfg }) {
  let head;
  let bytes;
  return {
    rel: toRel(absPath, projectDir),
    cfg,
    head: () => head === void 0 ? head = readHead(absPath) : head,
    bytes: () => bytes === void 0 ? bytes = sizeOf(absPath) : bytes,
    ignoredOutputDir: (rel) => ignoredOutputDirIn(rel, gitignoreRules(projectDir)),
    snoutignore: snoutignore(projectDir)
  };
}
function toRel(absPath, projectDir) {
  const abs = isAbsolute2(absPath) ? absPath : join2(projectDir, absPath);
  const rel = relative2(projectDir, abs);
  return rel.startsWith("..") ? abs.replace(/\\/g, "/") : rel.replace(/\\/g, "/");
}
var gitignoreCache = /* @__PURE__ */ new Map();
function gitignoreRules(projectDir) {
  const hit = gitignoreCache.get(projectDir);
  if (hit) return hit;
  let rules = [];
  try {
    rules = parseGitignore(readFileSync2(join2(projectDir, ".gitignore"), "utf8"));
  } catch {
  }
  gitignoreCache.set(projectDir, rules);
  return rules;
}
function fingerprintOf(absPath) {
  try {
    const st = statSync2(absPath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return void 0;
  }
}
function sizeOf(absPath) {
  try {
    return statSync2(absPath).size;
  } catch {
    return 0;
  }
}
function readHead(absPath) {
  let fd = null;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.allocUnsafe(2048);
    const n = readSync(fd, buf, 0, 2048, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
var snoutignoreCache = /* @__PURE__ */ new Map();
function snoutignore(projectDir) {
  const hit = snoutignoreCache.get(projectDir);
  if (hit) return hit;
  let patterns = [];
  try {
    const raw = readFileSync2(join2(projectDir, ".snoutignore"), "utf8");
    patterns = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#")).slice(0, 500);
  } catch {
    patterns = [];
  }
  snoutignoreCache.set(projectDir, patterns);
  return patterns;
}

// src/gate/policy.ts
var THRESHOLDS = {
  denyMinConfidence: 0.9,
  askMinConfidence: 0.5
};
var MIN_GATE_TOKENS = 2e3;
function worthGating(d, isFile, estimatedTokens) {
  if (d.rule === "secret" || d.rule === "crafted-path") return isFile;
  return isFile && estimatedTokens >= MIN_GATE_TOKENS;
}
function applyMode(d, mode, t = THRESHOLDS) {
  if (d.verdict === "allow") return d;
  if (d.rule === "secret") return d;
  if (d.confidence < t.askMinConfidence) {
    return { ...d, verdict: "allow", suppressedByMode: true, reason: d.reason };
  }
  switch (mode) {
    case "observe":
      return { ...d, verdict: "allow", suppressedByMode: true };
    case "advise":
      return { ...d, verdict: "ask" };
    case "enforce":
      return d.confidence >= t.denyMinConfidence ? d : { ...d, verdict: "ask" };
  }
}
function bandOf(d, t = THRESHOLDS) {
  if (!d) return "read";
  const v = applyMode(d, "enforce", t).verdict;
  return v === "deny" ? "act" : v === "ask" ? "ask" : "read";
}

// src/gate/decide.ts
function decide(input) {
  const raw = tier0(input) ?? // tier1(input) — Phase 1: the turn relevance vector.
  // tier2(input) — Phase 2: one Jev call for an ambiguous file.
  null;
  if (!raw) {
    return {
      verdict: "allow",
      tier: 0,
      rule: "unclassified",
      value: 2,
      confidence: 0,
      reason: "No rule applies and the semantic tier is not enabled yet."
    };
  }
  return applyMode(raw, input.cfg.mode);
}
function withOverride(reason, relPath) {
  const p = safePath(relPath);
  return `${reason} (/snout:explain ${p} \xB7 /snout:allow ${p})`;
}
function searchHint(rule, relPath, opts = {}) {
  if (!TEXT_RULES.has(rule)) return "";
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069'`]/.test(relPath)) return "";
  const safe = relPath.startsWith("-") ? `./${relPath}` : relPath;
  const f = /^[A-Za-z0-9._\/@+-]+$/.test(safe) ? safe : `'${safe}'`;
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const cmd = base === "package-lock.json" || base === "npm-shrinkwrap.json" ? `grep -n -A3 '"node_modules/<name>"' ${f}` : base === "yarn.lock" ? `grep -n -A3 '^"\\?<name>@' ${f}` : base === "Cargo.lock" ? `grep -n -A1 'name = "<crate>"' ${f}` : rule === "lockfile" ? `grep -n '<name>' ${f}` : rule === "minified" || opts.oneLine ? `grep -o '.\\{0,80\\}<symbol>.\\{0,80\\}' ${f}` : `grep -n '<symbol>' ${f}`;
  return ` Need one fact from it? Search instead of reading it whole: \`${cmd}\`.`;
}
var TEXT_RULES = /* @__PURE__ */ new Set(["lockfile", "vendored", "generated", "minified", "snapshot", "oversized", "license"]);

// src/ledger/tokens.ts
var RATIOS = {
  json: 2.22,
  lock: 1.92,
  sum: 1.3,
  // go.sum: hashes tokenize badly
  csv: 1.52,
  svg: 1.73,
  xml: 2.15,
  // mixed type, see above
  yaml: 2.43,
  yml: 2.58,
  toml: 2.08,
  ts: 2.24,
  tsx: 2.41,
  js: 2.34,
  jsx: 2.54,
  // mixed type, see above
  py: 2.45,
  go: 2.2,
  rs: 2.4,
  java: 2.42,
  kt: 2.24,
  cs: 2.49,
  swift: 2.4,
  rb: 2.19,
  php: 2.17,
  c: 2.26,
  h: 2.19,
  cpp: 2.25,
  sh: 2.03,
  sql: 2.19,
  // 8 samples
  html: 2.47,
  css: 2.12,
  md: 2.74,
  rst: 2.58,
  txt: 2.22
  // mixed type, see above
};
var DEFAULT_RATIO = 2.3;
function ratioFor(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m?.[1]?.toLowerCase();
  if (!ext) return DEFAULT_RATIO;
  return RATIOS[ext] ?? DEFAULT_RATIO;
}
var IMAGE_EXT = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp"]);
var IMAGE_TOKENS = 1600;
var isImagePath = (path) => IMAGE_EXT.has(/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "");
function estimateTokens(bytes, path) {
  if (bytes <= 0) return 0;
  if (isImagePath(path)) return Math.min(IMAGE_TOKENS, Math.round(bytes / DEFAULT_RATIO));
  return Math.round(bytes / ratioFor(path));
}
function readTranscriptUsage(text) {
  const byRequest = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = obj?.message?.usage;
    if (!usage) continue;
    const id = obj.requestId || obj.uuid || `${byRequest.size}`;
    const rec = {
      input: usage.input_tokens || 0,
      create: usage.cache_creation_input_tokens || 0,
      read: usage.cache_read_input_tokens || 0,
      output: usage.output_tokens || 0
    };
    const prev = byRequest.get(id);
    if (!prev || rec.output >= prev.output) byRequest.set(id, rec);
  }
  const total = {
    requests: byRequest.size,
    inputUncached: 0,
    cacheCreate: 0,
    cacheRead: 0,
    output: 0
  };
  for (const r of byRequest.values()) {
    total.inputUncached += r.input;
    total.cacheCreate += r.create;
    total.cacheRead += r.read;
    total.output += r.output;
  }
  return total;
}
function fmtTokens(n) {
  if (n < 1e3) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

// src/gate/summary.ts
function summarize(files, mode, t = THRESHOLDS, topN = 10) {
  const labels = /* @__PURE__ */ new Map();
  const bands = { act: { files: 0, tokens: 0 }, ask: { files: 0, tokens: 0 }, read: { files: 0, tokens: 0 } };
  const outcome = { allow: { files: 0, tokens: 0 }, ask: { files: 0, tokens: 0 }, deny: { files: 0, tokens: 0 } };
  const flagged = [];
  let tokens2 = 0;
  for (const f of files) {
    const tok2 = estimateTokens(f.bytes, f.rel);
    tokens2 += tok2;
    const label = labelOf(f.raw);
    const row = labels.get(label) ?? { label, files: 0, bytes: 0, tokens: 0 };
    row.files++;
    row.bytes += f.bytes;
    row.tokens += tok2;
    labels.set(label, row);
    const band = bandOf(f.raw, t);
    bands[band].files++;
    bands[band].tokens += tok2;
    const v = f.raw ? applyMode(f.raw, mode, t).verdict : "allow";
    outcome[v].files++;
    outcome[v].tokens += tok2;
    if (f.raw && label !== "read") {
      flagged.push({ rel: f.rel, label, rule: f.raw.rule, confidence: f.raw.confidence, band, tokens: tok2 });
    }
  }
  flagged.sort((a, b) => b.tokens - a.tokens);
  return {
    files: files.length,
    tokens: tokens2,
    thresholds: { ...t },
    mode,
    labels: [...labels.values()].sort((a, b) => b.tokens - a.tokens || b.files - a.files),
    bands,
    outcome,
    top: flagged.slice(0, topN)
  };
}

// src/gate/bash.ts
import { existsSync as existsSync3, statSync as statSync3 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join3, resolve as resolve2 } from "node:path";
var READ_COMMANDS = /* @__PURE__ */ new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "nl",
  "tac",
  "rev",
  "sed",
  "awk",
  "jq",
  "xxd",
  "od",
  "strings"
]);
var SCRIPT_FIRST = /* @__PURE__ */ new Set(["sed", "awk", "jq"]);
var VALUE_FLAGS = {
  head: /* @__PURE__ */ new Set(["-n", "-c", "--lines", "--bytes"]),
  tail: /* @__PURE__ */ new Set(["-n", "-c", "--lines", "--bytes"]),
  sed: /* @__PURE__ */ new Set(["-e", "-f", "--expression", "--file"]),
  awk: /* @__PURE__ */ new Set(["-f", "-v", "--file", "--assign"]),
  jq: /* @__PURE__ */ new Set(["-f", "--arg", "--argjson", "--slurpfile", "--rawfile", "--indent"]),
  od: /* @__PURE__ */ new Set(["-N", "-j", "-A", "-t", "-w"]),
  xxd: /* @__PURE__ */ new Set(["-l", "-s", "-c", "-g"]),
  strings: /* @__PURE__ */ new Set(["-n", "--bytes"]),
  nl: /* @__PURE__ */ new Set(["-w", "-s", "-v"])
};
var SCRIPT_FLAGS = /* @__PURE__ */ new Set(["-e", "-f", "--expression", "--file"]);
var MAX_TARGETS = 8;
var SEPARATORS = /* @__PURE__ */ new Set(["|", "||", "&&", ";", "&", "\n"]);
function readTargets(command, cwd) {
  const out = [];
  for (const segment of splitSegments(tokenize(command))) {
    for (const p of segmentTargets(segment, cwd)) {
      if (!out.includes(p)) out.push(p);
      if (out.length >= MAX_TARGETS) return out;
    }
  }
  return out;
}
var DUMP_COMMANDS = /* @__PURE__ */ new Set(["cat", "less", "more", "bat", "nl", "tac", "rev"]);
function dumpTargets(command, cwd) {
  const out = [];
  let seg = [];
  const flush = (next) => {
    if (seg.length && next !== "|" && isDump(seg)) {
      for (const p of segmentTargets(seg, cwd)) if (!out.includes(p) && out.length < MAX_TARGETS) out.push(p);
    }
    seg = [];
  };
  const tokens2 = tokenize(command);
  for (let i = 0; i < tokens2.length; i++) {
    const t = tokens2[i];
    if (t === "&" && tokens2[i + 1]?.startsWith(">")) {
      seg = [];
      continue;
    }
    if (SEPARATORS.has(t)) flush(t);
    else seg.push(t);
  }
  flush(void 0);
  return out;
}
function isDump(tokens2) {
  const i = commandIndex(tokens2);
  const raw = tokens2[i];
  if (raw === void 0 || !DUMP_COMMANDS.has(raw.slice(raw.lastIndexOf("/") + 1))) return false;
  return !tokens2.slice(i + 1).some((t) => /^(1|&)?>/.test(t));
}
function commandIndex(tokens2) {
  let i = 0;
  while (i < tokens2.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens2[i]) || tokens2[i] === "sudo" || tokens2[i] === "command" || tokens2[i] === "time")) i++;
  return i;
}
function tokenize(command) {
  const tokens2 = [];
  let cur = "";
  let quote = null;
  let had = false;
  const push = () => {
    if (cur !== "" || had) tokens2.push(cur);
    cur = "";
    had = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      had = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      continue;
    }
    if (c === " " || c === "	") {
      push();
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|") {
      push();
      const next = command[i + 1];
      if (c === "&" && next === "&" || c === "|" && next === "|") {
        tokens2.push(c + next);
        i++;
      } else {
        tokens2.push(c === "\n" ? "\n" : c);
      }
      continue;
    }
    cur += c;
  }
  if (quote) return [];
  push();
  return tokens2;
}
function splitSegments(tokens2) {
  const segments = [];
  let cur = [];
  for (const t of tokens2) {
    if (SEPARATORS.has(t)) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) segments.push(cur);
  return segments;
}
function segmentTargets(tokens2, cwd) {
  let i = commandIndex(tokens2);
  const raw = tokens2[i];
  if (raw === void 0) return [];
  const cmd = raw.slice(raw.lastIndexOf("/") + 1);
  if (!READ_COMMANDS.has(cmd)) return [];
  const valueFlags = VALUE_FLAGS[cmd] ?? /* @__PURE__ */ new Set();
  const out = [];
  let scriptSeen = !SCRIPT_FIRST.has(cmd);
  let sawOperand = false;
  for (i++; i < tokens2.length; i++) {
    const t = tokens2[i];
    if (t === "<") {
      const target = tokens2[++i];
      if (target) add(target);
      continue;
    }
    if (t === ">" || t === ">>" || /^\d?>>?$/.test(t)) {
      i++;
      continue;
    }
    if (t.startsWith(">") || t.startsWith("<")) continue;
    if (t === "--") continue;
    if (t.startsWith("-") && t !== "-") {
      const flag = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (SCRIPT_FLAGS.has(flag)) scriptSeen = true;
      if (valueFlags.has(flag) && !t.includes("=") && flag === t) i++;
      continue;
    }
    if (!scriptSeen && !sawOperand) {
      sawOperand = true;
      continue;
    }
    sawOperand = true;
    add(t);
  }
  return out;
  function add(token) {
    if (/[*?[\]$`~]/.test(token) || token.includes("(")) return;
    const abs = isAbsolute3(token) ? resolve2(token) : resolve2(join3(cwd, token));
    try {
      if (!existsSync3(abs) || !statSync3(abs).isFile()) return;
    } catch {
      return;
    }
    if (!out.includes(abs)) out.push(abs);
  }
}

// src/gate/outline.ts
var MAX_ITEMS = 40;
var IDENT = /^[A-Za-z_$][\w$]{0,63}$/;
var PKG = /^(@[a-z0-9][\w.-]{0,62}\/)?[a-z0-9][\w.-]{0,63}$/i;
var VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}([-+][\w.-]{1,40})?$/;
var DECLARATIONS = [
  {
    ext: /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/,
    pattern: /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)|^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm
  },
  { ext: /\.pyi?$/, pattern: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm },
  { ext: /\.go$/, pattern: /^(?:func\s+(?:\([^)\n]*\)\s*)?|type\s+)([A-Z]\w*)/gm },
  { ext: /\.rs$/, pattern: /^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_]\w*)/gm },
  { ext: /\.(java|kt|cs)$/, pattern: /^\s{0,4}public\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record|[\w<>\[\]]+)\s+([A-Za-z_]\w*)\s*[({<]/gm }
];
function outline(relPath, rule, text) {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return npmLockOutline(text);
  if (rule === "minified" || rule === "secret" || rule === "binary" || rule === "crafted-path") return "";
  const decl = DECLARATIONS.find((d) => d.ext.test(base));
  if (!decl) return "";
  const lineStarts = starts(text);
  const items = [];
  let total = 0;
  for (const m of text.matchAll(decl.pattern)) {
    const name = m[1] ?? m[2];
    if (!name || !IDENT.test(name)) continue;
    total++;
    if (items.length < MAX_ITEMS) items.push(`${name} L${lineOf(lineStarts, m.index ?? 0)}`);
  }
  if (items.length === 0) return "";
  const more = total > items.length ? ` (+${total - items.length} more)` : "";
  return ` Its top-level names, with line numbers: ${items.join(", ")}${more}. Read only the lines you need (Read with offset and limit).`;
}
function npmLockOutline(text) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return "";
  }
  const root = lock.packages?.[""];
  if (!root) return "";
  const names = [
    ...Object.keys(root.dependencies ?? {}),
    ...Object.keys(root.devDependencies ?? {})
  ];
  const items = [];
  for (const name of names) {
    const v = lock.packages?.[`node_modules/${name}`]?.version;
    if (!PKG.test(name) || typeof v !== "string" || !VERSION.test(v)) continue;
    if (items.length < MAX_ITEMS) items.push(`${name} ${v}`);
  }
  if (items.length === 0) return "";
  const more = names.length > items.length ? ` (+${names.length - items.length} more)` : "";
  return ` Direct dependencies as installed: ${items.join(", ")}${more}.`;
}
function starts(text) {
  const out = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}
function lineOf(lineStarts, index) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// src/gate/grep.ts
import { statSync as statSync4 } from "node:fs";
import { isAbsolute as isAbsolute4, join as join4 } from "node:path";
var MAX_LINES = 5e3;
function splitGrepOutput(text, cwd, searchPath) {
  const files = /* @__PURE__ */ new Map();
  let rest = 0;
  const isFileCache = /* @__PURE__ */ new Map();
  const isFile = (p) => {
    const hit = isFileCache.get(p);
    if (hit !== void 0) return hit;
    let ok = false;
    try {
      ok = statSync4(p).isFile();
    } catch {
      ok = false;
    }
    isFileCache.set(p, ok);
    return ok;
  };
  const resolve11 = (p) => isAbsolute4(p) ? p : join4(cwd, p);
  const single = searchPath && isFile(resolve11(searchPath)) ? resolve11(searchPath) : null;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const bytes = Buffer.byteLength(line) + 1;
    if (i >= MAX_LINES || line === "" || line === "--") {
      rest += bytes;
      return;
    }
    const owner = ownerOf(line, resolve11, isFile) ?? single;
    if (owner) files.set(owner, (files.get(owner) ?? 0) + bytes);
    else rest += bytes;
  });
  return { files, rest };
}
function ownerOf(line, resolve11, isFile) {
  for (let i = 1; i < line.length && i < 1024; i++) {
    const c = line[i];
    if (c !== ":" && c !== "-") continue;
    const abs = resolve11(line.slice(0, i));
    if (isFile(abs)) return abs;
  }
  return null;
}

// src/gate/response.ts
function responseText(response, depth = 0) {
  if (depth > 4 || response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map((r) => responseText(r, depth + 1)).join("\n");
  if (typeof response !== "object") return "";
  const o = response;
  const file2 = o.file;
  if (file2 && typeof file2.content === "string") return file2.content;
  if (typeof o.stdout === "string") return o.stdout + (typeof o.stderr === "string" ? o.stderr : "");
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content;
  if (Array.isArray(o.content)) return responseText(o.content, depth + 1);
  if (typeof o.result === "string") return o.result;
  if (Array.isArray(o.filenames)) return o.filenames.filter((f) => typeof f === "string").join("\n");
  return JSON.stringify(o);
}
function responseBytes(response) {
  const text = responseText(response);
  return text ? Buffer.byteLength(text) : 0;
}

// src/ledger/store.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync3, statSync as statSync6 } from "node:fs";
import { dirname as dirname3 } from "node:path";

// src/util/atomic.ts
import { renameSync as renameSync2, unlinkSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
function writeAtomic(path, contents) {
  const tmp = join5(dirname2(path), `.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(tmp, contents);
    renameSync2(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}

// src/util/tail.ts
import { closeSync as closeSync2, openSync as openSync2, readSync as readSync2, statSync as statSync5 } from "node:fs";
var BLOCK = 64 * 1024;
function tailLines(path, maxLines, maxBytes = 8 * 1024 * 1024) {
  let fd = null;
  try {
    const size = statSync5(path).size;
    if (size === 0) return [];
    fd = openSync2(path, "r");
    const chunks = [];
    let pos = size;
    let newlines = 0;
    let read3 = 0;
    while (pos > 0 && newlines <= maxLines && read3 < maxBytes) {
      const len = Math.min(BLOCK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      readSync2(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      read3 += len;
      for (const b of buf) if (b === 10) newlines++;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split("\n");
    if (pos > 0 && lines.length > 1) lines.shift();
    const nonEmpty = lines.filter((l) => l.length > 0);
    return nonEmpty.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
  }
}

// src/ledger/store.ts
function ensureParent(path) {
  const dir = dirname3(path);
  if (!existsSync4(dir)) mkdirSync2(dir, { recursive: true });
}
function appendRow(path, row) {
  try {
    ensureParent(path);
    const line = JSON.stringify(row);
    if (line.length > 4096) {
      recordError("appendRow", new Error(`row too large (${line.length} bytes); dropped`));
      return;
    }
    appendFileSync2(path, line + "\n");
  } catch (err) {
    recordError("appendRow", err);
  }
}
function readRows(path, limit = DEFAULT_LIMIT) {
  if (!existsSync4(path)) return [];
  try {
    const capped = Math.min(limit, MAX_LIMIT);
    const out = [];
    for (const line of tailLines(path, capped)) {
      if (!line || line[0] !== "{") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return out;
  } catch (err) {
    recordError("readRows", err);
    return [];
  }
}
var DEFAULT_LIMIT = 2e3;
var MAX_LIMIT = 2e4;
var ROTATE_KEEP = 5e3;
var ROTATE_BYTES = 8 * 1024 * 1024;
function rotateIfLarge(path) {
  try {
    if (!existsSync4(path) || statSync6(path).size < ROTATE_BYTES) return;
    const keep = tailLines(path, ROTATE_KEEP);
    writeAtomic(path, keep.join("\n") + "\n");
  } catch (err) {
    recordError("rotateIfLarge", err);
  }
}
var readDecisions = (p, limit) => dropEchoes(readRows(p, limit)).map(clampImage);
var ECHO_MS = 1e3;
function dropEchoes(rows) {
  const last = /* @__PURE__ */ new Map();
  return rows.filter((r) => {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) return true;
    const key = [r.session, r.agentId, r.client, r.turn, r.tool, r.path, r.range, r.rule, r.decision, r.bytes, r.tokensAvoidedEst, r.observedOnly ? 1 : 0].join("\0");
    const prev = last.get(key);
    last.set(key, t);
    return prev === void 0 || t - prev >= ECHO_MS;
  });
}
function clampImage(r) {
  if (!isImagePath(r.path ?? "") || r.tokensReadEst <= IMAGE_TOKENS && r.tokensAvoidedEst <= IMAGE_TOKENS) return r;
  return { ...r, tokensReadEst: Math.min(r.tokensReadEst, IMAGE_TOKENS), tokensAvoidedEst: Math.min(r.tokensAvoidedEst, IMAGE_TOKENS) };
}
var readTurns = (p, limit) => readRows(p, limit);
function loadState(path, session) {
  if (existsSync4(path)) {
    try {
      const s = JSON.parse(readFileSync3(path, "utf8"));
      if (s.session === session) return s;
    } catch (err) {
      recordError("loadState", err);
    }
  }
  return { session, turn: 0, goalHash: "", startedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function saveState(path, state) {
  try {
    ensureParent(path);
    writeAtomic(path, JSON.stringify(state));
  } catch (err) {
    recordError("saveState", err);
  }
}

// src/ledger/report.ts
var JEV_USD_PER_MTOK = 0.042;
var isFlagged = (r) => r.value <= 1 && r.rule !== "unclassified";
function totalsOf(rows) {
  const t = {
    decisions: rows.length,
    allow: 0,
    ask: 0,
    deny: 0,
    suppressed: 0,
    tokensReadEst: 0,
    tokensAvoidedEst: 0,
    tokensOfferedEst: 0,
    jevInputTokens: 0,
    jevCostUsd: 0,
    latencies: []
  };
  for (const r of rows) {
    t[r.decision] += 1;
    if (r.decision === "allow" && isFlagged(r)) t.suppressed += 1;
    t.tokensReadEst += r.tokensReadEst || 0;
    if (isFlagged(r)) t.tokensAvoidedEst += r.tokensAvoidedEst || 0;
    t.tokensOfferedEst += Math.max(r.tokensReadEst || 0, r.tokensAvoidedEst || 0);
    t.jevInputTokens += r.jevInputTokens || 0;
    t.latencies.push(r.latencyMs || 0);
  }
  t.jevCostUsd = t.jevInputTokens / 1e6 * JEV_USD_PER_MTOK;
  return t;
}
function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  return sorted[idx] ?? 0;
}
function harnessOf(rows) {
  const reads = [];
  const toolOutput = [];
  const lastGated = /* @__PURE__ */ new Map();
  const overriddenSet = /* @__PURE__ */ new Set();
  for (const r of rows) {
    const key = `${r.session}\0${r.path}`;
    if (r.rule === "reversal") {
      const g = lastGated.get(key);
      if (g) {
        overriddenSet.add(g);
        lastGated.delete(key);
      }
      continue;
    }
    if (r.rule === "tool-output") {
      toolOutput.push(r);
      continue;
    }
    reads.push(r);
    if (r.decision !== "allow" && !r.observedOnly) lastGated.set(key, r);
  }
  const m = /* @__PURE__ */ new Map();
  let gated = 0;
  let fellThrough = 0;
  for (const r of reads) {
    if (r.rule === "unclassified") {
      fellThrough += 1;
      continue;
    }
    const s = m.get(r.rule) ?? { rule: r.rule, reads: 0, flagged: 0, withheld: 0, overridden: 0 };
    s.reads += 1;
    if (isFlagged(r)) s.flagged += r.tokensAvoidedEst || 0;
    const isGated = r.decision !== "allow" && !r.observedOnly;
    if (isGated) gated += 1;
    if (overriddenSet.has(r)) s.overridden += 1;
    else if (isGated) s.withheld += r.tokensAvoidedEst || 0;
    m.set(r.rule, s);
  }
  const classes = [...m.values()].sort((a, b) => b.flagged - a.flagged || b.reads - a.reads);
  return { reads, classes, gated, overridden: [...overriddenSet], fellThrough, toolOutput };
}
function byAgentOf(reads, repeats = /* @__PURE__ */ new Set()) {
  const m = /* @__PURE__ */ new Map();
  for (const r of reads) {
    const key = r.agentId ?? "";
    const s = m.get(key) ?? { agentId: r.agentId, agentType: r.agentType, reads: 0, flaggedReads: 0, offered: 0, flagged: 0, repeated: 0 };
    if (repeats.has(r)) s.repeated += offeredOf(r);
    s.reads += 1;
    s.offered += offeredOf(r);
    if (isFlagged(r)) {
      s.flaggedReads += 1;
      s.flagged += r.tokensAvoidedEst || 0;
    }
    s.agentType ??= r.agentType;
    m.set(key, s);
  }
  return [...m.values()].sort((a, b) => b.flagged - a.flagged || b.reads - a.reads);
}
var offeredOf = (r) => Math.max(r.tokensReadEst || 0, r.tokensAvoidedEst || 0);
function redundancyOf(reads) {
  const seen = /* @__PURE__ */ new Map();
  const repeats = /* @__PURE__ */ new Set();
  const byPath = /* @__PURE__ */ new Map();
  let comparable = 0;
  let tokens2 = 0;
  for (const r of reads) {
    const reachedContext = r.decision === "allow" || r.observedOnly;
    if (!reachedContext || !r.fp) continue;
    comparable += 1;
    const key = `${r.session}\0${r.path}\0${r.fp}\0${r.range ?? ""}`;
    const who = r.agentId ?? "";
    const readers = seen.get(key) ?? /* @__PURE__ */ new Set();
    if (readers.size > 0 && !readers.has(who)) {
      repeats.add(r);
      tokens2 += offeredOf(r);
      const p = byPath.get(r.path) ?? { times: 0, tokens: 0 };
      p.times += 1;
      p.tokens += offeredOf(r);
      byPath.set(r.path, p);
    }
    readers.add(who);
    seen.set(key, readers);
  }
  const top = [...byPath.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.tokens - a.tokens || b.times - a.times);
  return { repeats, comparable, tokens: tokens2, top };
}
function agentLabel(s) {
  if (s.agentId === void 0) return "main";
  return `${safeText(s.agentType ?? "subagent", 24)} ${safeText(s.agentId.slice(0, 8), 8)}`;
}
var pctOf = (n, d) => d > 0 ? `${Math.round(n / d * 100)}%` : "\u2014";
var tok = (n) => n > 0 ? `~${fmtTokens(n)}` : "0";
function renderReport(rows, turns, mode, opts = {}) {
  const h = harnessOf(rows);
  if (h.reads.length === 0 && h.toolOutput.length === 0) {
    return [
      `snout \u2014 no reads recorded${opts.scope ? ` ${opts.scope}` : ""} yet.`,
      "",
      "The plugin records a decision each time the agent reads a file. Ask Claude to read",
      "something, then run /snout:report again."
    ].join("\n");
  }
  const t = totalsOf(h.reads);
  const n = h.reads.length;
  const classified = n - h.fellThrough;
  const withheld = h.classes.reduce((a, s) => a + s.withheld, 0);
  const flaggedReads = h.reads.filter(isFlagged).length;
  const out = [];
  const turnNote = turns.length > 0 ? ` over ${turns.length} turn(s)` : "";
  out.push(`snout \u2014 ${opts.scope ?? "ledger"} \xB7 ${n} read(s)${turnNote} \xB7 mode: ${mode}`);
  out.push("");
  out.push(`  Reads added ~${fmtTokens(t.tokensOfferedEst)} tokens of context. ${flaggedReads} of ${n} read(s) were`);
  out.push(`  low-value: ${tok(t.tokensAvoidedEst)} tokens, ${pctOf(t.tokensAvoidedEst, t.tokensOfferedEst)} of the total.`);
  if (h.toolOutput.length > 0) {
    const toolTokens = h.toolOutput.reduce((a, r) => a + (r.tokensReadEst || 0), 0);
    const tools = [...new Set(h.toolOutput.map((r) => r.tool.startsWith("mcp__") ? "MCP" : r.tool))].join(", ");
    out.push(`  Search, web and MCP output added ${tok(toolTokens)} more (${safeText(tools, 60)}): measured, not classified.`);
  }
  if (mode === "observe") {
    out.push("  Observe mode withholds nothing, so all of it reached the agent.");
  } else {
    out.push(`  ${tok(withheld)} tokens were withheld; the rest you allowed or overrode.`);
  }
  out.push("");
  out.push("  COVERAGE");
  out.push(`    classified     ${String(classified).padStart(5)} of ${n}  ${pctOf(classified, n).padStart(4)}   a rule recognised the file`);
  out.push(`    fell through   ${String(h.fellThrough).padStart(5)} of ${n}  ${pctOf(h.fellThrough, n).padStart(4)}   no rule applies, so it was read as normal`);
  out.push("");
  if (h.classes.length > 0) {
    out.push("  BY CLASS         reads    flagged   withheld   overridden");
    for (const s of h.classes) {
      out.push(
        `    ${s.rule.padEnd(14)} ${String(s.reads).padStart(5)} ${tok(s.flagged).padStart(10)} ${tok(s.withheld).padStart(10)} ${String(s.overridden).padStart(12)}`
      );
    }
    out.push(`    ${"-".repeat(55)}`);
    out.push(
      `    ${"total".padEnd(14)} ${String(classified).padStart(5)} ${tok(t.tokensAvoidedEst).padStart(10)} ${tok(withheld).padStart(10)} ${String(h.overridden.length).padStart(12)}`
    );
    out.push("");
  }
  const red = redundancyOf(h.reads);
  const agents = byAgentOf(h.reads, red.repeats);
  if (opts.byAgent) {
    out.push("  BY AGENT                      reads   low-value   of its reads   share of waste   repeats");
    for (const a of agents) {
      out.push(
        `    ${agentLabel(a).padEnd(26)} ${String(a.reads).padStart(5)} ${tok(a.flagged).padStart(11)} ${pctOf(a.flagged, a.offered).padStart(14)} ${pctOf(a.flagged, t.tokensAvoidedEst).padStart(16)} ${tok(a.repeated).padStart(9)}`
      );
    }
    if (agents.length === 1) out.push("    Only the main agent read files. Subagents appear here when they do.");
    out.push("");
  } else if (agents.length > 1) {
    out.push(`  ${agents.length - (agents.some((a) => a.agentId === void 0) ? 1 : 0)} subagent(s) also read files. Waste per agent: /snout:report --by-agent`);
    out.push("");
  }
  if (agents.length > 1) {
    out.push("  REDUNDANCY");
    if (red.repeats.size === 0) {
      out.push("    No agent re-read a file another agent had already read.");
    } else {
      out.push(
        `    ${red.repeats.size} of ${red.comparable} read(s) (${pctOf(red.repeats.size, red.comparable)}) repeated a read another agent had already made: ${tok(red.tokens)} tokens.`
      );
      for (const p of red.top.slice(0, 3)) out.push(`      ${safePath(p.path)}  re-read ${p.times}\xD7 \xB7 ${tok(p.tokens)} tokens`);
      out.push("    Subagents don't share context; passing a summary down avoids the repeat.");
    }
    out.push("");
  }
  out.push("  FALSE-DENY");
  if (h.gated === 0) {
    out.push(
      mode === "observe" ? "    n/a \u2014 observe mode asks nothing, so there is nothing to override." : "    n/a \u2014 no read has been asked about or denied yet."
    );
  } else {
    out.push(`    ${h.overridden.length} of ${h.gated} ask/deny decision(s) overridden  (${pctOf(h.overridden.length, h.gated)})`);
    if (h.overridden.length > 0) {
      out.push("    Each override is our error. `/snout:allow <path>` stops it recurring:");
      for (const r of h.overridden.slice(-5)) out.push(`      ${r.path}  (${r.rule})`);
    }
  }
  const flagged = h.reads.filter(isFlagged).slice(-5);
  if (flagged.length > 0) {
    out.push("");
    out.push("  MOST RECENT FLAGGED");
    for (const r of flagged) {
      const mark = r.decision === "allow" ? "\xB7" : r.decision === "ask" ? "?" : "\xD7";
      out.push(`    ${mark} ${r.path}  ${r.rule} \xB7 ${tok(r.tokensAvoidedEst)} tokens`);
    }
  }
  out.push("");
  out.push("  `~` marks an estimate, derived from byte length. Withheld content is never read,");
  out.push("  so its tokens cannot be measured. See docs/evaluation.md.");
  const p50 = percentile(t.latencies, 50);
  const p95 = percentile(t.latencies, 95);
  out.push(
    opts.gateInstalled ? `  added latency p50 ${p50} ms \xB7 p95 ${p95} ms (blocks the agent)` : `  recording overhead p50 ${p50} ms \xB7 p95 ${p95} ms (async \u2014 does not delay the agent)`
  );
  if (t.jevInputTokens > 0) out.push(`  Jev requests ${fmtTokens(t.jevInputTokens)} input tokens`);
  if (mode === "observe" && flaggedReads > 0) {
    out.push("");
    out.push("  Next: `/snout:mode advise` to start asking before low-value reads.");
  }
  return out.join("\n");
}

// src/ledger/tips.ts
var MIN_READS = 3;
var MIN_TOKENS = 5e3;
var MAX_CLAUDE_MD_TIPS = 3;
var SAFE_PATH = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029`]{1,200}$/;
function claudeMdLine(path, rule) {
  const p = `\`${path}\``;
  switch (rule) {
    case "lockfile":
      return `- Don't read ${p}: it's a generated lockfile. Ask the package manager for versions instead.`;
    case "generated":
      return `- Don't read ${p}: it's generated. Read or edit its source or generator instead.`;
    case "vendored":
      return `- Don't read ${p}: it's third-party or build output. Only open it if the task is about it.`;
    case "minified":
    case "binary":
    case "binary-content":
      return `- Don't read ${p}: it's minified or binary and yields nothing usable.`;
    default:
      return `- Skip ${p} unless the task is specifically about it: it's low-value for most work.`;
  }
}
function tipsOf(rows, ctx) {
  const h = harnessOf(rows);
  const sessions = new Set(h.reads.map((r) => r.session));
  const nSessions = Math.max(1, sessions.size);
  const tips = [];
  const byPath = /* @__PURE__ */ new Map();
  for (const r of h.reads) {
    if (r.value > 1 || r.rule === "unclassified" || r.rule === "secret" || r.rule === "crafted-path") continue;
    if (!SAFE_PATH.test(r.path)) continue;
    const s = byPath.get(r.path) ?? { rule: r.rule, reads: 0, tokens: 0, sessions: /* @__PURE__ */ new Set() };
    s.reads += 1;
    s.tokens += r.tokensAvoidedEst || 0;
    s.sessions.add(r.session);
    byPath.set(r.path, s);
  }
  const heavy = [...byPath.entries()].filter(([path, s]) => s.reads >= MIN_READS && s.tokens >= MIN_TOKENS && !ctx.claudeMd.includes(path)).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, MAX_CLAUDE_MD_TIPS);
  for (const [path, s] of heavy) {
    const perSession = Math.round(s.tokens / nSessions);
    tips.push({
      id: `claude-md:${path}`,
      kind: "claude-md",
      target: path,
      title: `Tell the agent to stop reading ${path}`,
      evidence: `read ${s.reads}\xD7 across ${s.sessions.size} session(s), ~${fmtK(s.tokens)} tokens, all flagged ${s.rule}`,
      change: `append to CLAUDE.md:  ${claudeMdLine(path, s.rule)}`,
      effect: `~${fmtK(perSession)} fewer tokens per session if the agent follows it; works in every mode`,
      perSession,
      rule: s.rule
    });
  }
  const overridden = /* @__PURE__ */ new Map();
  for (const r of h.overridden) overridden.set(r.path, (overridden.get(r.path) ?? 0) + 1);
  for (const [path, n] of overridden) {
    if (ctx.alwaysAllow.includes(path) || !SAFE_PATH.test(path)) continue;
    tips.push({
      id: `allow:${path}`,
      kind: "allow",
      target: path,
      title: `Stop flagging ${path}`,
      evidence: `you overrode snout on it ${n} time(s) \u2014 snout was wrong`,
      change: `add "${path}" to alwaysAllow in .snout/config.json`,
      effect: "never asked about or blocked again; no token effect",
      perSession: 0
    });
  }
  if (ctx.mode === "observe" && sessions.size >= 3 && h.overridden.length === 0) {
    const flagged = h.reads.reduce((a, r) => a + (r.value <= 1 && r.rule !== "unclassified" ? r.tokensAvoidedEst || 0 : 0), 0);
    const offered = h.reads.reduce((a, r) => a + Math.max(r.tokensReadEst || 0, r.tokensAvoidedEst || 0), 0);
    const share = offered > 0 ? flagged / offered : 0;
    if (share >= 0.15) {
      const perSession = Math.round(flagged / nSessions);
      tips.push({
        id: "mode:advise",
        kind: "mode",
        target: "advise",
        title: "Switch to advise mode",
        evidence: `over ${sessions.size} sessions, ${Math.round(share * 100)}% of read tokens (~${fmtK(perSession)}/session) were low-value, and you never overrode a flag`,
        change: ctx.gateInstalled ? `set mode "observe" \u2192 "advise" in .snout/config.json` : `set mode "observe" \u2192 "advise" in .snout/config.json \u2014 also needs the blocking hook, which is not installed (see /snout:mode)`,
        // Without the blocking hook, advise mode asks nothing: promising a saving would be false.
        effect: ctx.gateInstalled ? `the agent asks before each low-value read; up to ~${fmtK(perSession)} fewer tokens per session, each one your call` : "none until the blocking hook is installed \u2014 then the agent asks before each low-value read",
        perSession: ctx.gateInstalled ? perSession : 0
      });
    }
  }
  return tips.sort((a, b) => b.perSession - a.perSession || a.id.localeCompare(b.id));
}
function fmtK(n) {
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/ledger/statusline.ts
function renderStatusline(rows, mode) {
  if (rows.length === 0) return "snout \xB7 watching";
  const t = totalsOf(rows);
  const pct2 = t.tokensOfferedEst > 0 ? Math.round(t.tokensAvoidedEst / t.tokensOfferedEst * 100) : 0;
  const tag = mode === "observe" ? "flagged" : "saved";
  const cost = t.jevCostUsd > 0 ? ` \xB7 $${t.jevCostUsd.toFixed(4)}` : "";
  return `snout ${pct2}% ${tag} \xB7 ~${fmtTokens(t.tokensAvoidedEst)} tok${cost}`;
}

// src/agents/adapt.ts
var AGENTS = ["gemini", "cursor", "codex"];
function isAgent(a) {
  return typeof a === "string" && AGENTS.includes(a);
}
function toInternal(agent, event, raw) {
  if (agent === "codex") {
    const command = CODEX_EVENTS[event];
    return command ? { command, input: raw } : null;
  }
  if (agent === "gemini") return geminiIn(event, raw);
  return cursorIn(event, raw);
}
function fromInternal(agent, event, out) {
  if (agent === "codex") return out ? JSON.stringify(out) : "";
  if (agent === "gemini") return JSON.stringify(geminiOut(out));
  return JSON.stringify(cursorOut(event, out));
}
var CODEX_EVENTS = {
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
  SessionStart: "session-start",
  UserPromptSubmit: "prompt-submit",
  PreCompact: "pre-compact",
  Stop: "stop"
};
var GEMINI_TOOLS = {
  read_file: "Read",
  run_shell_command: "Bash",
  glob: "Glob",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch"
};
function geminiIn(event, raw) {
  const command = event === "BeforeTool" ? "pre-tool" : event === "AfterTool" ? "post-tool" : event === "SessionStart" ? "session-start" : null;
  if (!command) return null;
  const base = { session_id: str(raw.session_id), cwd: str(raw.cwd), transcript_path: str(raw.transcript_path), hook_event_name: event };
  if (command === "session-start") return { command, input: base };
  const name = str(raw.tool_name) ?? "";
  const ti = raw.tool_input ?? {};
  let toolInput = ti;
  if (name === "read_file") {
    const file_path = str(ti.absolute_path) ?? str(ti.file_path) ?? str(ti.path);
    toolInput = { file_path };
    if (typeof ti.offset === "number") toolInput.offset = ti.offset + 1;
    if (typeof ti.limit === "number") toolInput.limit = ti.limit;
  } else if (name === "run_shell_command") {
    toolInput = { command: str(ti.command) };
  }
  const input = { ...base, tool_name: GEMINI_TOOLS[name] ?? name, tool_input: toolInput };
  if (command === "post-tool") input.tool_response = geminiText(raw.tool_response?.llmContent);
  return { command, input };
}
function geminiText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => typeof p === "string" ? p : str(p?.text) ?? "").join("");
  return "";
}
function geminiOut(out) {
  const h = hso(out);
  const note = str(out?.systemMessage);
  if (!h?.permissionDecision) return note ? { systemMessage: note } : {};
  const reason = str(h.permissionDecisionReason) ?? str(h.additionalContext) ?? "";
  if (h.permissionDecision === "deny") return { decision: "deny", reason, ...note ? { systemMessage: note } : {} };
  if (h.permissionDecision === "ask") return { decision: "ask", reason, ...note ? { systemMessage: note } : {} };
  const u = h.updatedInput;
  if (u && typeof u.limit === "number") {
    const offset = typeof u.offset === "number" ? u.offset - 1 : 0;
    return { decision: "allow", hookSpecificOutput: { tool_input: { offset, limit: u.limit } }, ...note ? { systemMessage: note } : {} };
  }
  return { decision: "allow", ...note ? { systemMessage: note } : {} };
}
function cursorIn(event, raw) {
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const base = {
    session_id: str(raw.conversation_id),
    cwd: str(raw.cwd) ?? str(roots[0]),
    hook_event_name: event
  };
  if (event === "beforeReadFile") return { command: "pre-tool", input: { ...base, tool_name: "Read", tool_input: { file_path: str(raw.file_path) } } };
  if (event === "beforeShellExecution") return { command: "pre-tool", input: { ...base, tool_name: "Bash", tool_input: { command: str(raw.command) } } };
  return null;
}
function cursorOut(event, out) {
  const h = hso(out);
  const decision2 = str(h?.permissionDecision);
  const trimmed = decision2 === "allow" && !!h?.updatedInput;
  const reason = str(h?.permissionDecisionReason) ?? str(h?.additionalContext) ?? "";
  const note = str(out?.systemMessage) ?? reason;
  if (decision2 === "deny" || trimmed) {
    return event === "beforeShellExecution" ? { permission: "deny", user_message: note, agent_message: reason } : { permission: "deny", user_message: note || reason };
  }
  if (decision2 === "ask" && event === "beforeShellExecution") return { permission: "ask", user_message: note, agent_message: reason };
  return { permission: "allow" };
}
function hso(out) {
  return out?.hookSpecificOutput ?? void 0;
}
function str(v) {
  return typeof v === "string" && v ? v : void 0;
}

// src/agents/init.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync3, readFileSync as readFileSync4, realpathSync } from "node:fs";
import { dirname as dirname4, join as join6 } from "node:path";
function selfCommand() {
  let script = process.argv[1] ?? "snout";
  try {
    script = realpathSync(script);
  } catch {
  }
  return `node "${script}"`;
}
var OURS = /snout[\s\S]*\bhook (gemini|cursor|codex)\b/;
function initAgent(agent, projectDir, cmd = selfCommand()) {
  const hook = (event) => `${cmd} hook ${agent} ${event}`;
  if (agent === "cursor") {
    const file3 = join6(projectDir, ".cursor", "hooks.json");
    const cfg2 = load(file3);
    cfg2.version ??= 1;
    cfg2.hooks ??= {};
    const events = ["beforeReadFile", "beforeShellExecution"];
    for (const e of events) {
      cfg2.hooks[e] = (Array.isArray(cfg2.hooks[e]) ? cfg2.hooks[e] : []).filter((h) => !OURS.test(String(h?.command ?? "")));
      cfg2.hooks[e].push({ command: hook(e), timeout: 10 });
    }
    save(file3, cfg2);
    return { file: file3, events };
  }
  const file2 = agent === "gemini" ? join6(projectDir, ".gemini", "settings.json") : join6(projectDir, ".codex", "hooks.json");
  const cfg = load(file2);
  cfg.hooks ??= {};
  const groups = agent === "gemini" ? [["BeforeTool", "read_file|run_shell_command"], ["AfterTool", ".*"], ["SessionStart", void 0]] : [["PreToolUse", "^Bash$"], ["PostToolUse", ".*"], ["SessionStart", void 0], ["UserPromptSubmit", void 0], ["Stop", void 0]];
  for (const [e, matcher] of groups) {
    const kept = (Array.isArray(cfg.hooks[e]) ? cfg.hooks[e] : []).filter(
      (g) => !(Array.isArray(g?.hooks) && g.hooks.some((h) => OURS.test(String(h?.command ?? ""))))
    );
    const entry = { type: "command", command: hook(e) };
    if (agent === "gemini") Object.assign(entry, { name: "snout", timeout: 1e4 });
    kept.push({ ...matcher ? { matcher } : {}, hooks: [entry] });
    cfg.hooks[e] = kept;
  }
  save(file2, cfg);
  return { file: file2, events: groups.map(([e]) => e) };
}
function removeAgent(agent, projectDir) {
  const file2 = agent === "cursor" ? join6(projectDir, ".cursor", "hooks.json") : agent === "gemini" ? join6(projectDir, ".gemini", "settings.json") : join6(projectDir, ".codex", "hooks.json");
  if (!existsSync5(file2)) return { file: file2, removed: 0 };
  const cfg = load(file2);
  let removed = 0;
  for (const [e, list] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((h) => {
      const ours2 = agent === "cursor" ? OURS.test(String(h?.command ?? "")) : Array.isArray(h?.hooks) && h.hooks.some((x) => OURS.test(String(x?.command ?? "")));
      if (ours2) removed++;
      return !ours2;
    });
    if (kept.length) cfg.hooks[e] = kept;
    else delete cfg.hooks[e];
  }
  if (removed) save(file2, cfg);
  return { file: file2, removed };
}
function load(file2) {
  if (!existsSync5(file2)) return {};
  const parsed = JSON.parse(readFileSync4(file2, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file2} is not a JSON object`);
  return parsed;
}
function save(file2, cfg) {
  mkdirSync3(dirname4(file2), { recursive: true });
  writeAtomic(file2, JSON.stringify(cfg, null, 2) + "\n");
}

// src/mcp.ts
import { existsSync as existsSync7, readFileSync as readFileSync6, statSync as statSync8 } from "node:fs";
import { isAbsolute as isAbsolute6, join as join8, relative as relative4, resolve as resolve4 } from "node:path";

// src/audit/context.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync as existsSync6, lstatSync, mkdirSync as mkdirSync4, readdirSync, readFileSync as readFileSync5, realpathSync as realpathSync2, renameSync as renameSync3, rmdirSync, statSync as statSync7, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, dirname as dirname5, extname, isAbsolute as isAbsolute5, join as join7, relative as relative3, resolve as resolve3, sep } from "node:path";
var ACTION = { "one-off": "review", duplicate: "review", "near-duplicate": "merge", contained: "merge", stale: "fix", oversized: "trim", unused: "review" };
var OVERSIZED_TOKENS = 2e3;
var DAY = 864e5;
var MD = /\.(md|mdc|markdown)$/i;
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next", ".snout", "coverage", ".venv", "venv", "__pycache__"]);
var NOT_CONTEXT_DIR = /^(tests?|__tests__|testdata|test-data|fixtures?|golden|snapshots?|__snapshots__|vendor.*|third[_-]?party|external|deps|pods|examples?|samples?|node_modules|bower_components)$/i;
var AGENT_DIR = { ".claude": "claude", ".agents": "codex", ".codex": "codex", ".cursor": "cursor", ".gemini": "gemini", ".windsurf": "windsurf", ".clinerules": "cline", ".github": "copilot" };
var HUMAN_DOCS = /^(readme|license|licence|changelog|changes|history|contributing|code_of_conduct|security|support|governance|maintainers|authors|notice|copying)(\.|$)/i;
var ONE_OFF_DIR = /(^|\/)(archive[sd]?|reports?|plans?|tasks?|sessions?|handoffs?|scratch|\.sdd|\.conversations|\.specstory|history|progress|retros?|postmortems?)\//i;
var DATED = /(^|[^0-9])20\d\d[-_]?[01]\d[-_]?[0-3]\d/;
var LIVING_DIR = /(^|\/)(adrs?|decisions?|rfcs?|skills?|playbooks?|runbooks?|specs?|guides?)\//i;
var REPORT_NAME = /(^|[_\-. ])(plan|plans|summary|summaries|notes?|todo|report|implementation|analysis|findings|progress|status|handoff|scratch|draft|session|investigation|fix|fixes|migration|review|refactor|proposal)([_\-. ]|$)/i;
var AI_TRAILER = /co-authored-by:[^\n]*(claude|anthropic|copilot|cursor|gemini|codex|openai|devin|aider|windsurf|codeium|cline|jules|amp)/i;
var AI_AUTHOR = /\[bot\]|claude|copilot|devin|codex|cursor-agent|gemini-code|jules|aider/i;
function walk(dir, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join7(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1);
    } else if (e.isFile()) out.push(p);
    else if (e.isSymbolicLink()) {
      try {
        if (statSync7(p).isFile()) out.push(p);
      } catch {
      }
    }
  }
}
function projectFiles(projectDir) {
  const set = /* @__PURE__ */ new Set();
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: projectDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    for (const f of out.split("\0")) if (f && !f.split("/").some((s) => SKIP_DIRS.has(s))) set.add(join7(projectDir, f));
  } catch {
    const all = [];
    walk(projectDir, all);
    for (const f of all) set.add(f);
  }
  for (const d of [".claude", ".cursor", ".windsurf", ".clinerules", ".github", ".gemini", ".codex"]) {
    const p = join7(projectDir, d);
    if (existsSync6(p) && statSync7(p).isDirectory()) {
      const all = [];
      walk(p, all);
      for (const f of all) set.add(f);
    }
  }
  for (const f of [".cursorrules", ".windsurfrules", ".clinerules"]) {
    const p = join7(projectDir, f);
    if (existsSync6(p) && statSync7(p).isFile()) set.add(p);
  }
  return [...set];
}
var frontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(" ");
    }
    out[kv[1].toLowerCase()] = v.replace(/^["']|["']$/g, "").trim();
  }
  return out;
};
function classifyContextPath(rel) {
  const p = rel.split(sep).join("/");
  const name = basename2(p);
  const lower = p.toLowerCase();
  if (/(^|\/)claude(\.local)?\.md$/i.test(p)) return { kind: "always", role: "instructions", agents: ["claude"] };
  if (/(^|\/)agents\.md$/i.test(p)) return { kind: "always", role: "instructions", agents: ["codex", "cursor", "copilot", "gemini", "any"] };
  if (/(^|\/)gemini\.md$/i.test(p)) return { kind: "always", role: "instructions", agents: ["gemini"] };
  if (lower === ".cursorrules") return { kind: "always", role: "rules", agents: ["cursor"] };
  if (lower.startsWith(".cursor/rules/") && /\.(mdc|md)$/.test(lower)) return { kind: "always", role: "rules", agents: ["cursor"] };
  if (lower === ".github/copilot-instructions.md") return { kind: "always", role: "instructions", agents: ["copilot"] };
  if (lower.startsWith(".github/instructions/") && MD.test(lower)) return { kind: "described", role: "rules", agents: ["copilot"] };
  if (lower === ".windsurfrules" || lower.startsWith(".windsurf/rules/") && MD.test(lower)) return { kind: "always", role: "rules", agents: ["windsurf"] };
  if (lower === ".clinerules" || lower.startsWith(".clinerules/") && MD.test(lower)) return { kind: "always", role: "rules", agents: ["cline"] };
  if (/^\.claude\/skills\/[^/]+\/skill\.md$/i.test(p)) return { kind: "described", role: "skill", agents: ["claude"] };
  if (/^\.claude\/commands\/.+\.md$/i.test(p)) return { kind: "described", role: "command", agents: ["claude"] };
  if (/^\.claude\/agents\/.+\.md$/i.test(p)) return { kind: "described", role: "agent", agents: ["claude"] };
  if (/^\.(agents|codex)\/skills\/[^/]+\/skill\.md$/i.test(p)) return { kind: "described", role: "skill", agents: ["codex"] };
  if (/^\.(claude|agents|codex)\/skills\//i.test(p) && MD.test(lower)) return { kind: "on-demand", role: "skill file", agents: [AGENT_DIR[p.split("/")[0].toLowerCase()] ?? "any"] };
  if (!MD.test(name)) return null;
  if (lower.startsWith(".github/") && !lower.startsWith(".github/instructions/")) return null;
  const dirs = p.split("/").slice(0, -1);
  if (dirs.some((d) => NOT_CONTEXT_DIR.test(d))) return null;
  const agent = AGENT_DIR[dirs[0]?.toLowerCase() ?? ""];
  return { kind: "on-demand", role: "doc", agents: [agent ?? "any"] };
}
function userFiles(projectDir, home) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join7(home, ".claude");
  const out = [];
  const add = (abs, f) => {
    if (existsSync6(abs)) out.push({ abs, scope: "user", ...f });
  };
  add(join7(claudeDir, "CLAUDE.md"), { kind: "always", role: "instructions", agents: ["claude"] });
  add(join7(claudeDir, "projects", resolve3(projectDir).replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md"), { kind: "always", role: "memory", agents: ["claude"] });
  add(join7(process.env.CODEX_HOME || join7(home, ".codex"), "AGENTS.md"), { kind: "always", role: "instructions", agents: ["codex"] });
  add(join7(home, ".gemini", "GEMINI.md"), { kind: "always", role: "instructions", agents: ["gemini"] });
  const list = (dir, re, role) => {
    if (!existsSync6(dir)) return;
    const all = [];
    walk(dir, all, 9);
    for (const f of all) if (re.test(relative3(dir, f).split(sep).join("/"))) out.push({ abs: f, scope: "user", kind: "described", role, agents: ["claude"] });
  };
  list(join7(claudeDir, "skills"), /^[^/]+\/SKILL\.md$/i, "skill");
  list(join7(claudeDir, "commands"), /\.md$/i, "command");
  list(join7(claudeDir, "agents"), /\.md$/i, "agent");
  return out;
}
var bump = (m, key, ts) => {
  const cur = m.get(key);
  m.set(key, cur ? [cur[0] + 1, ts > cur[1] ? ts : cur[1]] : [1, ts]);
};
function readClaudeTranscript(text, u, since, fallbackTs) {
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes("<command-name>")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : fallbackTs;
    const content = obj.message?.content;
    if (typeof content === "string" || Array.isArray(content) && content.some((c) => typeof c?.text === "string")) {
      const text2 = typeof content === "string" ? content : content.map((c) => c?.text ?? "").join("\n");
      const re = /<command-name>\/?([^<\s]+)<\/command-name>/g;
      let m;
      while (m = re.exec(text2)) if (ts >= since) bump(u.commands, m[1].toLowerCase(), ts);
    }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== "tool_use" || typeof c.name !== "string") continue;
      const input = c.input ?? {};
      const file2 = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name) && file2) u.writes.add(resolve3(file2));
      if (ts < since) continue;
      if (c.name === "Read" && file2) bump(u.reads, resolve3(file2), ts);
      else if (c.name === "Skill" && typeof input.skill === "string") bump(u.skills, input.skill.toLowerCase().split(":").pop(), ts);
      else if ((c.name === "Agent" || c.name === "Task") && typeof input.subagent_type === "string") bump(u.agents, input.subagent_type.toLowerCase().split(":").pop(), ts);
      else if (c.name === "SlashCommand" && typeof input.command === "string") bump(u.commands, input.command.replace(/^\//, "").split(/\s/)[0].toLowerCase(), ts);
    }
  }
}
function collectUsage(projectDir, days, home, ledger) {
  const u = { reads: /* @__PURE__ */ new Map(), skills: /* @__PURE__ */ new Map(), commands: /* @__PURE__ */ new Map(), agents: /* @__PURE__ */ new Map(), writes: /* @__PURE__ */ new Set(), codex: [], sources: [] };
  const since = new Date(Date.now() - days * DAY).toISOString();
  const dir = resolve3(projectDir);
  const root = join7(process.env.CLAUDE_CONFIG_DIR || join7(home, ".claude"), "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
  if (existsSync6(root)) {
    let n = 0;
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const path = join7(root, f);
        readClaudeTranscript(readFileSync5(path, "utf8"), u, since, statSync7(path).mtime.toISOString());
        n++;
      } catch {
      }
    }
    if (n) u.sources.push(`${n} Claude Code session${n === 1 ? "" : "s"}`);
  }
  const codexRoot2 = join7(process.env.CODEX_HOME || join7(home, ".codex"), "sessions");
  if (existsSync6(codexRoot2)) {
    const files = [];
    walk(codexRoot2, files, 8);
    let n = 0;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = statSync7(f);
        if (st.mtimeMs < Date.now() - days * DAY) continue;
        const text = readFileSync5(f, "utf8");
        const cwd = JSON.stringify(dir).slice(1, -1);
        if (!text.includes(`"cwd":"${cwd}`) && !text.includes(`"cwd": "${cwd}`)) continue;
        n++;
        const ts = st.mtime.toISOString();
        const patch = /\*\*\* (?:Add|Update) File: ([^\\\n"]+)/g;
        let m;
        while (m = patch.exec(text)) u.writes.add(resolve3(dir, m[1].trim()));
        u.codex.push([text, ts]);
      } catch {
      }
    }
    if (n) u.sources.push(`${n} Codex session${n === 1 ? "" : "s"}`);
  }
  if (ledger?.length) {
    let n = 0;
    for (const r of ledger) if (r.ts >= since && r.path) {
      bump(u.reads, resolve3(dir, r.path), r.ts);
      n++;
    }
    if (n) u.sources.push("Snout ledger");
  }
  return u;
}
function gitAuthorship(projectDir, maxCommits = 3e3) {
  const out = /* @__PURE__ */ new Map();
  let log = "";
  try {
    log = execFileSync("git", ["log", "--no-merges", `-n${maxCommits}`, "--name-only", "--format=%x1e%an%x1f%ae%x1f%at%x1f%B%x1d"], { cwd: projectDir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { files: out, ever: void 0 };
  }
  for (const rec of log.split("")) {
    if (!rec.trim()) continue;
    const [head, files = ""] = rec.split("");
    const [an = "", ae = "", at = "0", body = ""] = (head ?? "").split("");
    const ai = AI_TRAILER.test(body) || AI_AUTHOR.test(an) || AI_AUTHOR.test(ae);
    const t = Number(at) * 1e3;
    for (const f of files.split("\n")) {
      const rel = f.trim();
      if (!rel) continue;
      const g = out.get(rel) ?? { ai: 0, human: 0, first: t };
      if (ai) g.ai++;
      else g.human++;
      g.first = Math.min(g.first, t);
      out.set(rel, g);
    }
  }
  return { files: out, ever: out.size ? new Set(out.keys()) : void 0 };
}
function authorOf(git, agentWrote) {
  const ai = (git?.ai ?? 0) + (agentWrote ? 1 : 0);
  const human = git?.human ?? 0;
  if (!ai && !human) return "unknown";
  if (ai && human) return "mixed";
  return ai ? "ai" : "human";
}
var normalize = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function shingles(norm, k = 5) {
  const w = norm.split(" ").filter(Boolean);
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  if (!out.size && w.length) out.add(w.join(" "));
  return out;
}
function overlap(a, b) {
  if (!a.size || !b.size) return { jaccard: 0, containment: 0 };
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return { jaccard: inter / (a.size + b.size - inter), containment: inter / small.size };
}
var STOP = new Set("the a an and or of to in for on with is are be by it this that as at from use when if not you your do does can should must will any all each only into than then so no".split(" "));
function topTerms(norm, n = 40) {
  const counts = /* @__PURE__ */ new Map();
  for (const w of norm.split(" ")) if (w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w));
}
function staleRefs(text, fileAbs, projectDir, everExisted, workspaceScripts) {
  const missing = /* @__PURE__ */ new Set();
  const cands = /* @__PURE__ */ new Set();
  const tick = /`([^`\n]{2,160})`/g;
  const link = /\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
  let m;
  while (m = tick.exec(text)) cands.add(m[1].trim());
  while (m = link.exec(text)) cands.add(m[1].trim());
  for (let c of cands) {
    if (/^[a-z]+:\/\//i.test(c) || c.startsWith("mailto:") || /[\s*?{}<>$|=]/.test(c) || c.startsWith("-") || c.startsWith("~") || c.startsWith("@")) continue;
    c = c.replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");
    if (!(c.includes("/") || /\.[a-z0-9]{1,6}$/i.test(c)) || isAbsolute5(c) || /^\.+$/.test(c) || c.endsWith("/")) continue;
    if (/^\d+(\.\d+)+$/.test(c)) continue;
    const fromFile = resolve3(dirname5(fileAbs), c), fromRoot = resolve3(projectDir, c);
    if (!fromFile.startsWith(projectDir) && !fromRoot.startsWith(projectDir)) continue;
    if (existsSync6(fromFile) || existsSync6(fromRoot)) continue;
    if (everExisted) {
      const rels = [relative3(projectDir, fromFile), relative3(projectDir, fromRoot)].map((r) => r.split(sep).join("/"));
      if (rels.some((r) => everExisted.has(r))) missing.add(c);
      continue;
    }
    const parentExists = (p) => {
      const d = dirname5(p);
      return d !== projectDir && existsSync6(d);
    };
    if (c.includes("/") ? parentExists(fromFile) || parentExists(fromRoot) : false) missing.add(c);
  }
  let scripts = null;
  const relDir = relative3(projectDir, dirname5(fileAbs)).split(sep);
  const pkgDir = existsSync6(join7(dirname5(fileAbs), "package.json")) ? dirname5(fileAbs) : relDir[0] === "" || /^\.(claude|cursor|github|windsurf|clinerules|gemini|codex)$/.test(relDir[0] ?? "") ? projectDir : null;
  if (pkgDir && existsSync6(join7(pkgDir, "package.json"))) {
    try {
      scripts = JSON.parse(readFileSync5(join7(pkgDir, "package.json"), "utf8")).scripts ?? {};
    } catch {
      scripts = null;
    }
  }
  if (scripts) {
    const run = /\b(?:npm run|pnpm run|yarn run|bun run)((?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ][^\s`-][^\s`]*)?)*)\s+([A-Za-z0-9:_][A-Za-z0-9:_-]*)/g;
    while (m = run.exec(text)) {
      if (m[1]) continue;
      if (!(m[2] in scripts) && !workspaceScripts?.has(m[2])) missing.add(`npm run ${m[2]}`);
    }
  }
  return [...missing];
}
function auditContext(projectDir, opts = {}) {
  const dir = resolve3(projectDir);
  const home = opts.home ?? homedir2();
  const days = opts.days ?? 30;
  const maxTok = opts.oversizedTokens ?? OVERSIZED_TOKENS;
  const found = [];
  for (const abs of projectFiles(dir)) {
    const c = classifyContextPath(relative3(dir, abs));
    if (c) found.push({ abs, scope: "project", ...c });
  }
  found.push(...userFiles(dir, home));
  const workspaceScripts = /* @__PURE__ */ new Set();
  for (const abs of projectFiles(dir)) {
    if (basename2(abs) !== "package.json") continue;
    try {
      for (const k of Object.keys(JSON.parse(readFileSync5(abs, "utf8")).scripts ?? {})) workspaceScripts.add(k);
    } catch {
    }
  }
  const ignored = (paths) => {
    if (!paths.length) return /* @__PURE__ */ new Set();
    try {
      return new Set(execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: dir, input: paths.join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).split("\n").filter(Boolean));
    } catch (e) {
      return new Set(String(e.stdout ?? "").split("\n").filter(Boolean));
    }
  };
  const usage = opts.noUsage ? { reads: /* @__PURE__ */ new Map(), skills: /* @__PURE__ */ new Map(), commands: /* @__PURE__ */ new Map(), agents: /* @__PURE__ */ new Map(), writes: /* @__PURE__ */ new Set(), codex: [], sources: [] } : collectUsage(dir, days, home, opts.ledger);
  const history = opts.noGit ? { files: /* @__PURE__ */ new Map(), ever: void 0 } : gitAuthorship(dir);
  const git = history.files;
  const now = Date.now();
  const files = [];
  const texts = /* @__PURE__ */ new Map();
  for (const f of found) {
    let text = "";
    let st;
    try {
      st = statSync7(f.abs);
      if (st.size > 2 * 1024 * 1024) continue;
      text = readFileSync5(f.abs, "utf8");
    } catch {
      continue;
    }
    const rel = f.scope === "project" ? relative3(dir, f.abs).split(sep).join("/") : "~/" + relative3(home, f.abs).split(sep).join("/");
    const tokens2 = estimateTokens(st.size, f.abs);
    const fm = frontmatter(text);
    let kind = f.kind;
    if (f.role === "rules" && extname(f.abs) === ".mdc" && fm.alwaysapply !== "true") kind = "described";
    const desc = (fm.name ?? "") + " " + (fm.description ?? text.replace(/^---[\s\S]*?---/, "").trim().split("\n")[0] ?? "");
    const perSession = kind === "always" ? tokens2 : kind === "described" ? estimateTokens(Buffer.byteLength(desc), "x.md") : 0;
    let use;
    const id = (fm.name || (f.role === "skill" ? basename2(dirname5(f.abs)) : basename2(f.abs).replace(MD, ""))).toLowerCase();
    if (f.role === "skill") use = usage.skills.get(id) ?? usage.skills.get(basename2(dirname5(f.abs)).toLowerCase());
    else if (f.role === "command") use = usage.commands.get(relative3(join7(dirname5(f.abs).split(`${sep}commands`)[0], "commands"), f.abs).replace(MD, "").split(sep).join(":").toLowerCase()) ?? usage.commands.get(id);
    else if (f.role === "agent") use = usage.agents.get(id);
    const read3 = usage.reads.get(f.abs);
    if (read3) use = use ? [use[0] + read3[0], read3[1] > use[1] ? read3[1] : use[1]] : read3;
    if (f.scope === "project" && usage.codex.length) {
      for (const [t, ts] of usage.codex) if (t.includes(rel)) use = use ? [use[0] + 1, ts > use[1] ? ts : use[1]] : [1, ts];
    }
    const g = f.scope === "project" ? git.get(rel) : void 0;
    const created = new Date(g?.first ?? st.mtimeMs).toISOString();
    files.push({
      path: rel,
      abs: f.abs,
      scope: f.scope,
      kind,
      role: f.role,
      agents: f.agents,
      bytes: st.size,
      tokens: tokens2,
      perSession,
      uses: kind === "always" || opts.noUsage ? null : use?.[0] ?? 0,
      lastUsed: use?.[1] ?? null,
      author: authorOf(g, usage.writes.has(f.abs)),
      created,
      flags: [],
      savePerSession: 0
    });
    texts.set(f.abs, text);
  }
  const byReal = /* @__PURE__ */ new Map();
  for (const f of files) {
    try {
      if (!lstatSync(f.abs).isSymbolicLink()) byReal.set(realpathSync2(f.abs), f);
    } catch {
    }
  }
  for (const f of files) {
    try {
      if (lstatSync(f.abs).isSymbolicLink()) {
        const t = byReal.get(realpathSync2(f.abs));
        if (t) f.linkTo = t.path;
      }
    } catch {
    }
  }
  const flag = (f, code, reason, save3 = 0, action = ACTION[code]) => {
    f.flags.push({ code, reason, action });
    f.savePerSession = Math.max(f.savePerSession, save3);
  };
  const old = (f) => now - Date.parse(f.created) > days * DAY;
  for (const f of files) {
    const name = basename2(f.path);
    if (f.kind === "always" && f.tokens > maxTok && !f.linkTo)
      flag(f, "oversized", `loaded into every session at ~${fmtTokens(f.tokens)} tokens; over ${fmtTokens(maxTok)}, move detail into skills or docs read on demand`, f.tokens - maxTok);
    if (f.kind === "described" && old(f) && f.uses === 0)
      flag(f, "unused", `not invoked in ${days} days; its description still costs ~${fmtTokens(f.perSession)} tokens every session`, f.perSession);
    const stem = name.replace(MD, "");
    const oneTime = DATED.test(f.path) || ONE_OFF_DIR.test(f.path) || !f.path.includes("/") && /^[A-Z0-9_-]+$/.test(stem);
    const report = f.kind === "on-demand" && f.role === "doc" && !HUMAN_DOCS.test(name) && !LIVING_DIR.test(f.path) && oneTime && (REPORT_NAME.test(stem) || DATED.test(stem) || ONE_OFF_DIR.test(f.path));
    if (report && f.author !== "human" && f.author !== "unknown" && old(f) && !f.uses)
      flag(f, "one-off", `${f.author === "ai" ? "AI-written" : f.author === "mixed" ? "partly AI-written" : "a"} ${name.replace(MD, "").toLowerCase().includes("plan") ? "plan" : "report"} ${opts.noUsage ? `over ${days} days old (reads not observed)` : `not read in ${days} days`}`);
    else if (f.kind === "on-demand" && f.role === "doc" && f.author === "ai" && !HUMAN_DOCS.test(name) && old(f) && f.uses === 0)
      flag(f, "unused", `AI-written and not read in ${days} days`);
    let stale = f.scope === "project" && f.kind !== "on-demand" ? staleRefs(texts.get(f.abs) ?? "", f.abs, dir, history.ever, workspaceScripts) : [];
    if (stale.length) {
      const ig = ignored(stale.filter((x) => !x.startsWith("npm run ")));
      stale = stale.filter((x) => !ig.has(x));
    }
    if (stale.length)
      flag(f, "stale", `mentions ${stale.length} thing${stale.length === 1 ? "" : "s"} that no longer exist${stale.length === 1 ? "s" : ""}: ${stale.slice(0, 4).join(", ")}${stale.length > 4 ? ", \u2026" : ""}`);
  }
  const comparable = files.filter((f) => !f.linkTo && (texts.get(f.abs) ?? "").length > 80).sort((a, b) => b.tokens - a.tokens).slice(0, 1500);
  const shared = (a, b) => a.agents.some((x) => b.agents.includes(x));
  const agentContext = (f) => f.kind !== "on-demand" || f.role !== "doc" || f.agents[0] !== "any" || REPORT_NAME.test(basename2(f.path).replace(MD, "")) || !f.path.includes("/");
  const tail2 = (p) => p.replace(/^\.[a-z]+\//i, "");
  const mirror = (a, b) => a.path !== b.path && tail2(a.path) === tail2(b.path) && !shared(a, b);
  const norm = new Map(comparable.map((f) => [f.abs, normalize(texts.get(f.abs))]));
  const sh = new Map(comparable.map((f) => [f.abs, shingles(norm.get(f.abs))]));
  const hash = /* @__PURE__ */ new Map();
  for (const f of comparable) {
    const h = createHash("sha256").update(norm.get(f.abs)).digest("hex");
    const first2 = hash.get(h);
    if (!first2) {
      hash.set(h, f);
      continue;
    }
    if (!agentContext(first2) && !agentContext(f)) continue;
    if (first2.kind === "always" && f.kind === "always" && basename2(first2.path).toLowerCase() === basename2(f.path).toLowerCase()) continue;
    if (mirror(first2, f)) {
      flag(f, "duplicate", `mirror of ${first2.path} for another agent; a symlink keeps them in step`);
      continue;
    }
    const [keep, drop] = first2.perSession > f.perSession ? [f, first2] : [first2, f];
    if (shared(keep, drop) || keep.kind === "on-demand" || drop.kind === "on-demand") flag(drop, "duplicate", `same text as ${keep.path}`, drop.perSession);
    else flag(drop, "duplicate", `same text as ${keep.path}; different agents load each, so no session pays twice, but the copies will drift: a symlink keeps them in step`);
  }
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const a = comparable[i], b = comparable[j];
      if (a.flags.some((x) => x.code === "duplicate") || b.flags.some((x) => x.code === "duplicate")) continue;
      const sa = sh.get(a.abs), sb = sh.get(b.abs);
      if (Math.min(sa.size, sb.size) < 20 || Math.min(a.tokens, b.tokens) < 300 || !agentContext(a) && !agentContext(b) || mirror(a, b)) continue;
      if (a.kind === "always" && b.kind === "always" && basename2(a.path).toLowerCase() === basename2(b.path).toLowerCase()) continue;
      const o = overlap(sa, sb);
      const [small, big] = sa.size <= sb.size ? [a, b] : [b, a];
      const rank = (f) => f.kind === "always" ? 0 : f.kind === "described" ? 1 : 2;
      if (rank(big) > rank(small) || small.flags.some((x) => x.code === "near-duplicate" || x.code === "contained")) continue;
      const pays = shared(small, big) || small.kind === "on-demand" || big.kind === "on-demand";
      if (o.jaccard >= 0.8) flag(small, "near-duplicate", `${Math.round(o.jaccard * 100)}% the same as ${big.path}${pays ? "" : " (loaded by different agents)"}`, pays ? small.perSession : 0);
      else if (o.containment >= 0.6) flag(small, "contained", `${Math.round(o.containment * 100)}% of it repeats ${big.path}${pays ? "" : " (loaded by different agents)"}`, pays ? Math.round(small.perSession * o.containment) : 0);
    }
  }
  const instr = files.filter((f) => f.kind !== "on-demand" && (f.role === "instructions" || f.role === "rules" || f.role === "memory") && (texts.get(f.abs) ?? "").length > 200);
  const terms = new Map(instr.map((f) => [f.abs, topTerms(normalize(texts.get(f.abs)))]));
  const conflictCandidates = [];
  for (let i = 0; i < instr.length; i++) {
    for (let j = i + 1; j < instr.length; j++) {
      const a = instr[i], b = instr[j];
      if (a.flags.some((x) => /duplicate/.test(x.code)) || b.flags.some((x) => /duplicate/.test(x.code))) continue;
      const ta = terms.get(a.abs), tb = terms.get(b.abs);
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      const o = inter / Math.max(1, Math.min(ta.size, tb.size));
      if (o >= 0.3) conflictCandidates.push({ a: a.path, b: b.path, overlap: Math.round(o * 100) / 100 });
    }
  }
  conflictCandidates.sort((x, y) => y.overlap - x.overlap);
  files.sort((a, b) => b.savePerSession - a.savePerSession || b.flags.length - a.flags.length || b.perSession - a.perSession || b.tokens - a.tokens);
  return { projectDir: dir, days, files, conflictCandidates: conflictCandidates.slice(0, 12), sources: usage.sources };
}
var when = (iso) => iso ? iso.slice(0, 10) : "never";
var AGENT_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", copilot: "Copilot", gemini: "Gemini CLI", windsurf: "Windsurf", cline: "Cline" };
function perAgent(always) {
  const by = {};
  for (const f of always) for (const ag of f.agents) if (ag !== "any") by[ag] = (by[ag] ?? 0) + f.tokens;
  return { max: Math.max(0, ...Object.values(by)), by };
}
function byAgentNote(by) {
  const groups = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(by)) groups.set(v, [...groups.get(v) ?? [], AGENT_NAMES[k] ?? k]);
  if (Object.keys(by).length < 2) return "";
  return ` (${[...groups.entries()].sort((x, y) => y[0] - x[0]).map(([v, names]) => `${names.join(", ")} ~${fmtTokens(v)}`).join(" \xB7 ")})`;
}
function totals(a) {
  const sum = (fs, k) => fs.reduce((s, f) => s + f[k], 0);
  const always = a.files.filter((f) => f.kind === "always"), described = a.files.filter((f) => f.kind === "described"), onDemand = a.files.filter((f) => f.kind === "on-demand");
  const flagged = a.files.filter((f) => f.flags.length);
  const known = a.files.filter((f) => f.author !== "unknown");
  return {
    always: { files: always.length, perSession: perAgent(always).max, byAgent: perAgent(always).by },
    described: { files: described.length, perSession: sum(described, "perSession") },
    onDemand: { files: onDemand.length, tokens: sum(onDemand, "tokens") },
    flagged: flagged.length,
    savePerSession: sum(flagged, "savePerSession"),
    flaggedOnDemandTokens: sum(flagged.filter((f) => f.kind === "on-demand"), "tokens"),
    aiShare: known.length ? known.filter((f) => f.author !== "human").length / known.length : null
  };
}
function renderAudit(a, opts = {}) {
  const t = totals(a);
  const lines = [
    `Agent context for ${a.projectDir} \xB7 usage from the last ${a.days} days${a.sources.length ? ` (${a.sources.join(", ")})` : " (no session history found)"}`,
    "",
    `  Always loaded             ${String(t.always.files).padStart(4)}   ~${fmtTokens(t.always.perSession)} tokens every session${byAgentNote(t.always.byAgent)}`,
    `  Skills, commands, agents  ${String(t.described.files).padStart(4)}   ~${fmtTokens(t.described.perSession)} tokens of descriptions every session`,
    `  Other docs                ${String(t.onDemand.files).padStart(4)}   ~${fmtTokens(t.onDemand.tokens)} tokens when read`
  ];
  if (t.aiShare !== null) lines.push(`  Written with AI           ${String(Math.round(t.aiShare * 100) + "%").padStart(4)}   of files with known authorship`);
  const list = opts.all ? a.files : a.files.filter((f) => f.flags.length);
  lines.push("");
  if (!list.length) {
    lines.push("Nothing flagged: no unused, duplicate, stale or oversized agent context.");
  } else {
    lines.push(`${t.flagged} flagged \xB7 ~${fmtTokens(t.savePerSession)} tokens per session to save${t.flaggedOnDemandTokens ? ` \xB7 ~${fmtTokens(t.flaggedOnDemandTokens)} more in docs agents may read` : ""}`, "");
    lines.push(`  ${"SAVE/SESSION".padEnd(13)}${"TOKENS".padEnd(8)}${"KIND".padEnd(11)}${"LAST USED".padEnd(12)}${"AUTHOR".padEnd(8)}PATH`);
    for (const f of list.slice(0, opts.all ? 500 : 40)) {
      lines.push(`  ${(f.savePerSession ? "~" + fmtTokens(f.savePerSession) : "\u2014").padEnd(13)}${fmtTokens(f.tokens).padEnd(8)}${f.kind.padEnd(11)}${(f.kind === "always" ? "\u2014" : when(f.lastUsed)).padEnd(12)}${f.author.padEnd(8)}${f.path}`);
      for (const fl of f.flags) lines.push(`  ${"".padEnd(52)}\u21B3 ${fl.code} (${fl.action}): ${fl.reason}`);
    }
    if (list.length > 40 && !opts.all) lines.push(`  \u2026 ${list.length - 40} more (--all, or --json)`);
  }
  if (a.conflictCandidates.length) {
    lines.push("", "Instruction files that cover the same ground (check them for contradictions; `--map` gives an agent what it needs):");
    for (const c of a.conflictCandidates.slice(0, 6)) lines.push(`  ${c.a}  \u2194  ${c.b}`);
  }
  if (list.length) lines.push(
    "",
    "Nothing is changed. Actions: merge (share or combine the repeated text) \xB7 fix (update dead references) \xB7 trim (move detail to docs read on demand) \xB7 review (read it, then keep, update or archive).",
    "Review before archiving: one-off reports and copies often still hold rationale, pending work or examples. `--map` gives your agent a compact list to judge.",
    "  snout audit context --archive <paths>     # move out of the repo after you confirm; --restore undoes it"
  );
  return lines.join("\n");
}
function renderMap(a) {
  const lines = [
    `# Agent context map: ${basename2(a.projectDir)} \xB7 ${a.days}-day usage`,
    "# path | kind | role | tokens | per-session | uses | last used | author | flags"
  ];
  for (const f of a.files) {
    lines.push([f.linkTo ? `${f.path} -> ${f.linkTo}` : f.path, f.kind, f.role, f.tokens, f.perSession, f.uses === null ? "-" : f.uses, f.kind === "always" ? "-" : when(f.lastUsed), f.author, f.flags.map((x) => `${x.code}\u2192${x.action}(${x.reason})`).join("; ") || "-"].join(" | "));
  }
  if (a.conflictCandidates.length) {
    lines.push("", "# Pairs to check for contradicting instructions (topic overlap 0-1):");
    for (const c of a.conflictCandidates) lines.push(`${c.a} <> ${c.b} | ${c.overlap}`);
  }
  lines.push("", "# Judge each flagged file: keep, trim, merge, fix or archive. Archive only what holds nothing still needed: rationale, pending work and examples count; never remove a file someone still relies on.");
  return lines.join("\n");
}
function toJson(a) {
  return { ...a, totals: totals(a), files: a.files.map(({ abs: _abs, ...f }) => f) };
}
var archiveRoot = (projectDir) => join7(resolve3(projectDir), ".snout", "archive");
function archiveFiles(projectDir, paths, now = /* @__PURE__ */ new Date()) {
  const dir = resolve3(projectDir);
  const id = now.toISOString().replace(/[:.]/g, "-");
  const base = join7(archiveRoot(dir), id);
  const files = [];
  const todo = [];
  for (const p of paths) {
    const abs = resolve3(dir, p);
    const rel = relative3(dir, abs);
    if (!rel || rel.startsWith("..") || isAbsolute5(rel)) throw new Error(`${p} is outside the project`);
    if (rel.split(sep)[0] === ".snout" || rel.split(sep)[0] === ".git") throw new Error(`${p} can't be archived`);
    if (!existsSync6(abs) || !statSync7(abs).isFile()) throw new Error(`${p} is not a file`);
    const buf = readFileSync5(abs);
    files.push({ path: rel.split(sep).join("/"), bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
    todo.push([abs, join7(base, rel)]);
  }
  if (!todo.length) throw new Error("no files given");
  mkdirSync4(base, { recursive: true });
  const manifest = { id, created: now.toISOString(), files };
  writeFileSync2(join7(base, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const [from, to] of todo) {
    mkdirSync4(dirname5(to), { recursive: true });
    renameSync3(from, to);
  }
  return manifest;
}
function listArchives(projectDir) {
  const root = archiveRoot(projectDir);
  if (!existsSync6(root)) return [];
  const out = [];
  for (const id of readdirSync(root).sort()) {
    try {
      out.push(JSON.parse(readFileSync5(join7(root, id, "manifest.json"), "utf8")));
    } catch {
    }
  }
  return out;
}
function restoreArchive(projectDir, id) {
  const dir = resolve3(projectDir);
  if (!/^[0-9TZ-]+$/.test(id)) throw new Error(`no archive ${id}`);
  const base = join7(archiveRoot(dir), id);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync5(join7(base, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`no archive ${id}`);
  }
  const restored = [], skipped = [];
  for (const f of manifest.files) {
    const from = join7(base, f.path), to = resolve3(dir, f.path);
    if (relative3(dir, to).startsWith("..")) {
      skipped.push(f.path);
      continue;
    }
    if (!existsSync6(from)) {
      if (!existsSync6(to)) skipped.push(f.path);
      continue;
    }
    if (existsSync6(to)) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync4(dirname5(to), { recursive: true });
    renameSync3(from, to);
    restored.push(f.path);
  }
  if (!skipped.length) {
    const prune = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(join7(d, e.name));
      try {
        if (d !== base) rmdirSync(d);
      } catch {
      }
    };
    prune(base);
    try {
      renameSync3(join7(base, "manifest.json"), join7(archiveRoot(dir), `${id}.restored.json`));
      rmdirSync(base);
    } catch {
    }
  }
  return { restored, skipped };
}

// src/mcp.ts
var HEAD_LINES = 60;
var HEAD_BYTES = 6 * 1024;
var MAX_BYTES = 256 * 1024;
var TOOLS = [
  {
    name: "snout_read",
    description: "Read a file from this project. Prefer this over reading whole files: for lockfiles, generated code, vendored libraries, minified bundles and build output it returns the first lines, an outline of the file with line numbers, and a search command, instead of tens of thousands of tokens. Ordinary source files come back in full. Pass offset and limit (1-based line numbers) to read a specific range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the project root." },
        offset: { type: "number", description: "1-based line to start from." },
        limit: { type: "number", description: "Number of lines to read." }
      },
      required: ["path"]
    }
  },
  {
    name: "snout_classify",
    description: "Say what kind of file this is before reading it: source, lockfile, generated, vendored, minified, build output or secret, with a confidence score and roughly how many tokens a whole read would cost.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  },
  {
    name: "snout_audit_context",
    description: 'Audit this project\'s agent context: instruction files (CLAUDE.md, AGENTS.md, rules files), skills, commands, subagents and AI-written docs. Reports what each costs per session, when it was last used, who wrote it, and flags unused, duplicate, stale and oversized ones. format "map" returns one compact line per file plus instruction pairs to check for contradictions, for you to judge what to keep. Read-only: it never moves or deletes anything; archiving is done by the user with `snout audit context --archive`.',
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["report", "map"], description: "report (default): flagged files ranked by tokens saved per session. map: every file, one line each." },
        days: { type: "number", description: "Usage window in days (default 30)." }
      }
    }
  }
];
function startMcp(projectDir, cfg, version, write2) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const reply = handle(line, projectDir, cfg, version);
      if (reply) write2(JSON.stringify(reply) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
function handle(line, projectDir, cfg, version) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }
  const { id, method, params } = msg;
  if (id === void 0 || id === null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "snout", version }
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      try {
        const text = callTool(String(params?.name ?? ""), params?.arguments ?? {}, projectDir, cfg);
        return ok({ content: [{ type: "text", text }] });
      } catch (err) {
        return ok({ content: [{ type: "text", text: err.message }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}
function callTool(name, args, projectDir, cfg) {
  if (name === "snout_audit_context") {
    const days = Number.isFinite(args.days) && args.days > 0 ? Math.min(365, Math.floor(args.days)) : 30;
    const audit = auditContext(projectDir, { days });
    return cap(args.format === "map" ? renderMap(audit) : renderAudit(audit));
  }
  const abs = inProject(String(args.path ?? ""), projectDir);
  const rel = toRel(abs, projectDir);
  if (!existsSync7(abs) || !statSync8(abs).isFile()) throw new Error(`No such file: ${rel}`);
  const bytes = statSync8(abs).size;
  const d = tier0({ absPath: abs, projectDir, cfg });
  const band = bandOf(d);
  const tokens2 = estimateTokens(bytes, rel);
  if (name === "snout_classify") {
    if (!d) return `${rel}: source \xB7 band read \xB7 ~${fmtTokens(tokens2)} tokens if read whole. No rule flags it, so it is read in full.`;
    return `${rel}: ${d.rule} \xB7 confidence ${d.confidence.toFixed(2)} \xB7 band ${band} \xB7 ~${fmtTokens(tokens2)} tokens if read whole.
${d.reason}`;
  }
  if (name !== "snout_read") throw new Error(`Unknown tool: ${name}`);
  if (d?.rule === "secret") throw new Error(`${rel} looks like a secret or credential. Ask the user before reading it.`);
  if (d?.rule === "binary" || d?.rule === "binary-content") throw new Error(`${rel} is binary; reading it yields nothing usable.`);
  const text = readFileSync6(abs, "utf8");
  const lines = text.split("\n");
  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 0;
  if (offset || limit) {
    const from = Math.max(1, offset || 1);
    const to = Math.min(lines.length, limit ? from + limit - 1 : lines.length);
    return cap(`${rel} (lines ${from}\u2013${to} of ${lines.length})

${lines.slice(from - 1, to).join("\n")}`);
  }
  if (d && band === "act" && worthGating(d, true, tokens2)) {
    const oneLine2 = bytes / Math.max(1, lines.length) > 1e3;
    const map = outline(rel, d.rule, text);
    const hint = searchHint(d.rule, rel, { oneLine: oneLine2 });
    const note = `${rel}: ${d.reason} (~${fmtTokens(tokens2)} tokens).`;
    if (oneLine2) return `${note} It is one very long line, so no head is shown.${map}${hint}`;
    let used = 0, n = 0;
    for (const l of lines.slice(0, HEAD_LINES)) {
      if (used + l.length + 1 > HEAD_BYTES) break;
      used += l.length + 1;
      n++;
    }
    return `${note} Showing lines 1\u2013${n} of ${lines.length}.${map} Call snout_read again with offset and limit for other lines.${hint}

${lines.slice(0, n).join("\n")}`;
  }
  return cap(text);
}
function inProject(p, projectDir) {
  if (!p) throw new Error("path is required");
  const abs = resolve4(isAbsolute6(p) ? p : join8(projectDir, p));
  const r = relative4(projectDir, abs);
  if (r.startsWith("..") || isAbsolute6(r)) throw new Error("snout_read only reads files inside the project.");
  return abs;
}
function cap(s) {
  return Buffer.byteLength(s) > MAX_BYTES ? s.slice(0, MAX_BYTES) + `

[truncated at ${MAX_BYTES / 1024} KB; pass offset and limit to read further]` : s;
}

// src/dashboard/server.ts
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync as readFileSync13, statSync as statSync13, unwatchFile, watchFile } from "node:fs";
import { basename as basename5, isAbsolute as isAbsolute8, join as join15 } from "node:path";

// src/dashboard/summary.ts
var TIMELINE_POINTS = 240;
var FEED = 60;
var CHART_FILES = 8;
var HISTORY = 6;
var DAILY_DAYS = 14;
var READ_FILES = 3e3;
var isFlagged2 = (r) => r.value <= 1 && r.rule !== "unclassified";
var clientOf = (r) => r.client ?? "claude";
var agentOf = (r) => agentLabel({ agentId: r.agentId, agentType: r.agentType });
var RULE_LABEL = { "binary-content": "binary", unclassified: "source" };
var labelOfRule = (rule) => RULE_LABEL[rule] ?? rule;
function bump2(m, key, inContext, heldBack) {
  const s = m.get(key) ?? { key, reads: 0, inContext: 0, heldBack: 0 };
  s.reads += 1;
  s.inContext += inContext;
  s.heldBack += heldBack;
  m.set(key, s);
  return s;
}
function mcpServerOf(tool) {
  if (!tool || !tool.startsWith("mcp__")) return null;
  return tool.split("__")[1] || null;
}
function mcpSlices(rows, overridden) {
  const m = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const server = mcpServerOf(r.tool);
    if (!server) continue;
    const held = r.rule === "tool-output" || overridden.has(r) ? 0 : r.tokensAvoidedEst || 0;
    bump2(m, server, r.tokensReadEst || 0, held);
  }
  return m;
}
var byHeld = (a, b) => b.heldBack - a.heldBack || b.inContext - a.inContext;
function summarizeLedger(rows, now = /* @__PURE__ */ new Date()) {
  const h = harnessOf(rows);
  const overridden = new Set(h.overridden);
  const labels = /* @__PURE__ */ new Map();
  const clients = /* @__PURE__ */ new Map();
  const files = /* @__PURE__ */ new Map();
  const agents = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Map();
  const details = /* @__PURE__ */ new Map();
  const sessions = /* @__PURE__ */ new Map();
  const timeline = [];
  const feed = [];
  let inContext = 0;
  let heldBack = 0;
  let couldHoldBack = 0;
  let gated = 0;
  const day = now.toISOString().slice(0, 10);
  const today = { day, reads: 0, inContext: 0, heldBack: 0 };
  const daily = /* @__PURE__ */ new Map();
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const k = new Date(now.getTime() - i * 864e5).toISOString().slice(0, 10);
    daily.set(k, { day: k, reads: 0, inContext: 0, heldBack: 0 });
  }
  for (const r of h.reads) {
    const acted = r.decision !== "allow" && !r.observedOnly;
    const held2 = acted && !overridden.has(r) ? r.tokensAvoidedEst || 0 : 0;
    const reached = r.decision === "allow" || r.observedOnly || r.trimmed || overridden.has(r);
    const read3 = reached ? r.tokensReadEst || 0 : 0;
    if (acted) gated += 1;
    if (r.observedOnly && isFlagged2(r)) couldHoldBack += r.tokensAvoidedEst || 0;
    inContext += read3;
    heldBack += held2;
    const dd = daily.get(r.ts.slice(0, 10));
    if (dd) {
      dd.reads += 1;
      dd.inContext += read3;
      dd.heldBack += held2;
    }
    if (r.ts.startsWith(day)) {
      today.reads += 1;
      today.inContext += read3;
      today.heldBack += held2;
    }
    bump2(labels, labelOfRule(r.rule), read3, held2);
    bump2(clients, clientOf(r), read3, held2);
    bump2(files, r.path, read3, held2);
    bump2(agents, agentOf(r), read3, held2);
    bump2(models, r.model || "unknown", read3, held2);
    const s = sessions.get(r.session) ?? { key: r.session, reads: 0, inContext: 0, heldBack: 0, first: r.ts, last: r.ts, clients: [] };
    sessions.set(r.session, s);
    bump2(sessions, r.session, read3, held2);
    if (r.ts < s.first) s.first = r.ts;
    if (r.ts > s.last) s.last = r.ts;
    if (!s.clients.includes(clientOf(r))) s.clients.push(clientOf(r));
    timeline.push({ ts: r.ts, inContext, heldBack });
    const row = {
      ts: r.ts,
      client: clientOf(r),
      agent: agentOf(r),
      tool: r.tool,
      path: r.path,
      rule: labelOfRule(r.rule),
      outcome: r.trimmed ? "trimmed" : acted ? r.decision === "ask" ? "asked" : "held back" : r.observedOnly && isFlagged2(r) ? "would hold back" : "read",
      inContext: read3,
      heldBack: held2,
      reason: r.reason.slice(0, 240)
    };
    feed.push(row);
    const d = details.get(r.path) ?? { label: labelOfRule(r.rule), reason: "", trimmed: 0, last: r.ts, history: [] };
    if (isFlagged2(r) || d.label === "source") d.label = labelOfRule(r.rule);
    if (row.outcome !== "read") d.reason = row.reason;
    if (r.trimmed) d.trimmed += 1;
    if (r.ts > d.last) d.last = r.ts;
    d.history.push(row);
    if (d.history.length > HISTORY) d.history.shift();
    details.set(r.path, d);
  }
  const toolOutput = h.toolOutput.reduce((a, r) => a + (r.tokensReadEst || 0), 0);
  const red = redundancyOf(h.reads);
  const asked = inContext + heldBack + toolOutput;
  const sliceFiles = [...files.values()];
  const held = sliceFiles.filter((f) => f.heldBack > 0).sort(byHeld).slice(0, CHART_FILES);
  const full = sliceFiles.filter((f) => f.heldBack === 0 && f.inContext > 0).sort((a, b) => b.inContext - a.inContext);
  const chart = [...held, ...full.slice(0, Math.max(held.length ? 2 : CHART_FILES, CHART_FILES - held.length))].slice(0, CHART_FILES);
  return {
    generatedAt: now.toISOString(),
    rows: rows.length,
    reads: h.reads.length,
    gated,
    overridden: overridden.size,
    inContext,
    heldBack,
    couldHoldBack,
    toolOutput,
    repeated: red.tokens,
    savedShare: asked > 0 ? heldBack / asked : 0,
    latency: { p50: percentile(h.reads.map((r) => r.latencyMs || 0), 50), p95: percentile(h.reads.map((r) => r.latencyMs || 0), 95) },
    byLabel: [...labels.values()].sort(byHeld),
    byClient: [...clients.values()].sort(byHeld),
    byAgent: [...agents.values()].sort(byHeld).slice(0, 12),
    byModel: [...models.values()].sort(byHeld),
    byMcpServer: [...mcpSlices([...h.reads, ...h.toolOutput], overridden).values()].sort(byHeld),
    topHeld: sliceFiles.filter((f) => f.heldBack > 0).sort(byHeld).slice(0, 10),
    topRead: sliceFiles.filter((f) => f.inContext > 0).sort((a, b) => b.inContext - a.inContext).slice(0, 10),
    files: chart.map((f) => {
      const d = details.get(f.key);
      return { ...f, label: d.label, reason: d.reason, trimmed: d.trimmed, last: d.last, history: d.history.slice().reverse() };
    }),
    readFiles: sliceFiles.filter((f) => f.key).sort((a, b) => b.inContext + b.heldBack - (a.inContext + a.heldBack)).slice(0, READ_FILES).map((f) => ({ ...f, label: details.get(f.key).label, last: details.get(f.key).last })),
    sessions: [...sessions.values()].sort((a, b) => a.last < b.last ? 1 : -1).slice(0, 20),
    timeline: thin(timeline, TIMELINE_POINTS),
    recent: feed.slice(-FEED).reverse(),
    today,
    daily: [...daily.values()]
  };
}
function thin(xs, max) {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}
function dailyAggregates(rows, sinceDay = "") {
  const h = harnessOf(rows);
  const overridden = new Set(h.overridden);
  const m = /* @__PURE__ */ new Map();
  for (const r of h.reads) {
    const day = r.ts.slice(0, 10);
    if (day < sinceDay) continue;
    const acted = r.decision !== "allow" && !r.observedOnly;
    const held = acted && !overridden.has(r) ? r.tokensAvoidedEst || 0 : 0;
    const reached = r.decision === "allow" || r.observedOnly || r.trimmed || overridden.has(r);
    const client2 = clientOf(r);
    const server = mcpServerOf(r.tool);
    const label = server ? mcpLabel(server) : labelOfRule(r.rule);
    const model = (r.model || "").slice(0, 64);
    const key = `${day}\0${client2}\0${model}\0${label}`;
    const d = m.get(key) ?? { day, client: client2, model, label, reads: 0, gated: 0, inContext: 0, heldBack: 0, couldHoldBack: 0 };
    d.reads += 1;
    if (acted) d.gated += 1;
    d.inContext += reached ? r.tokensReadEst || 0 : 0;
    d.heldBack += held;
    if (r.observedOnly && isFlagged2(r)) d.couldHoldBack += r.tokensAvoidedEst || 0;
    m.set(key, d);
  }
  for (const r of h.toolOutput) {
    const server = mcpServerOf(r.tool);
    const day = r.ts.slice(0, 10);
    if (!server || day < sinceDay) continue;
    const client2 = clientOf(r);
    const model = (r.model || "").slice(0, 64);
    const label = mcpLabel(server);
    const key = `${day}\0${client2}\0${model}\0${label}`;
    const d = m.get(key) ?? { day, client: client2, model, label, reads: 0, gated: 0, inContext: 0, heldBack: 0, couldHoldBack: 0 };
    d.reads += 1;
    d.inContext += r.tokensReadEst || 0;
    m.set(key, d);
  }
  return [...m.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
}
var mcpLabel = (server) => `mcp-${server.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "server"}`;

// src/dashboard/page.html
var page_default = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snout Dashboard</title>
<link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABsCAMAAACVZkoAAAABiVBMVEVMaXH37+rSp42xh3OcZkvi0cfcwrb69/cjGRvt4N80Jil1NEvXsKfh1szKmXvOtKS8nIekoqJTUFChkYw3NDWCfXxnZWXhha70X6XyXaLrU5fnVZfxWZ7qV5n2Z6zlVJXoUZQJAwL2Y6n2bbPyWaHuWJySUzL2aq/tVZl8QSHiT5F2Ph+NTi2ZVzehYD6mZEKISSrhVJMWCgmERST4ocbmWZdvOx6dWzvpXZuraUb4q832c7bzZqiwbkv0k7h5OiZ+RCr3msDsYJ/6s9Ttj7CxZju2dFHRQH32ervKPXfYQ4PBOXLaTYv5qbO7bkPliKipL2DwZqPEdktuMxjhR4q+e1ioXjRpLRR1NR9yGjW2NGpsJyKQJEzFhGGcKlYtBwufVi+TTynNf1L1mKD4gcFhFynpS49FERmGTzVcIRLegJ+CH0HNTIGUSTbyd6f1hbHXdpfhlmiGOyzWi1+PWT36maaqP2vcX5F7LiqqcVXodKK8TXvMjm3MaY33jaS1gGOVPF6ZPEPWhY4t9OjKAAAAGHRSTlMAEtLd/lh6BP4u/v6sRviOwnDNk9yftsrAyv1DAAAACXBIWXMAAAAAAAAD6AF+hNEZAAAUJklEQVRo3tWa91sbybKGhxwd1/ZRRBIogHJAlgAF0MHCgI6NLGGLKOM1YBYhvCyLDHL8z0+F7p4RZu997rPsD7dskxS+t7+qrq4ZrGn/v2Lgf3l4YOCfFB/o/PxX4v8QBL1r11DXXxhBPxkYGuInDPwTqx/oG+2+e/dud3f/0HUJWvNQfzc+frd7tO/2CeD9+nq+rWPs7Hy+291ndBo/d/Xf/1YsFvFheEL3nVvX7xq9LF5mZyCyRWQgBEw7L/5ez2UWo4iBj/fftj4IRMIUkQgwIAJlAhffd/+ydybLdESBPozeqv5AT29vKhTyhiBS4QjbAJkYvdd/735PL/4MuDAi5BGacO826+B+b2/IK4IQIoyws46+ABVARVSgEfBo/20RDGj3elPn3iBGNBpkhHCYi2Fnvci5zxIB5yhCJtwduh2CAW2oN+X98CEaTWAAQjDoTaUwE1ky+/Pnz8ABJYD6KYIjg9a7by0B5+cfovMUCY5gKJWSiS/S5izOEAAUCrIx3LdbScKA1td7/uEDiE+pSIhEsA8cnICQ/uNsdv1u160Y0AMGgH4+EJgKoHwAADARwOAVCw5j8lPhVErnIm9uwYIB7Q4bMBVQMTUVpUAGL29NFAf7Q16vZML0FHu6biEDWAEAAMJPFUBCFCRuDN6bYVbnbyRB9u9XAW4BrgDQf/pUB4hiSSQ4F8hA6gonJCq02HMLPeDDudQPKAJZkglGEADKDzSBLbi887ct6CH9KTJAeRBQ+4Ebg5fXH1UEISaYmRn9ewBQgrQFpqgAQL/CBE/JBSagQhBtMqqqAgCoHfwfy3BAnq+GDFACePHKAvhEGxI/omhUAUgTaGdAv76eg2sCfzFwGp7SQzvgqSEEgcgBNoVgMCH2pdyb8twEgI5DceB/HG3hp0N9EEMKAeaA3uv6hkJAA3hLiFOCvKAaOOfdGI5c3u8QGECFO11/gXDn/jeMu933hvgZ0IbBAIN+heT17SgaczSh12OQ5GVHCme/yTMR1tTV3w0nF8wR/TcSjF729vbOzFxeFtc/MwKVQL5z9RXdgKmpeYYA/Xl5UnrlTmSEmd4+MTBrWn/Ptx0RowM/+z8KQ8/5OfsGh3k/T2KBQKd6pfLzXuTlY3cUAEHRkqgM7os5vev+JZzaeHDiGX59e+KZ13t+LsDDMzD0dYMJMOzNP31DoiReEV9LgnlRiKo363sSY8+byu6QFnTUnuIOq+MEs/6t73oS4MyDnotzB9RRKoLjTl9XbwSeHvZGA5U3HKx/zYIAOzBvIMC6DIL6H7//8W6nC9cHrgrxLI2N3ddbvpDHoQONRISd7iC4GMaRoxjxTlXeHEEQQyeAKEFj7JH473/88e7VqyxcJPT36uI0Nha/DXXuz35o+bB6nnvYBRDOwjqCXmbAqScSCiYClYp0g6L2tFarwacAbYi9t6+zr96BtlB/8SIbvgf6l6yuj62XfZ0Av7D9kFTJEAxFsuvFxFQ0uBd6+/b169fPsi9evXsHb7v+KjsDw5c3uMeBVUM5I13WhqeR/LNnkVBPfyorxiY5tMJm6/8ZQBoA0w+NXaHIzPpOogZf7e29fcsQz168eAUYCELxe0ewMDyIH0j+NYCmwnLp4sqGEG4AmFf6eTxrgCAMBNEa1NaeRHgm4gXFK4p3jNQZsHyQf/0W9qRBPCUIwpFeBcDHAx86+bP5Mzx78vkpqkYvEgRrVFaE8PpmBKZgjlfv+GvUf/t2L+HNol4EZ7YUD5AIEsEaMJ5Mfecf8vn8fF44AEE1hQSfvZUpowk6hGDQKQxB+nt7iT2oF5xZUTwkIGB6jFwOqQ48Otrf19XVO5+vIQLIYwrgS5o+veFI8XPozRR58FYRdCJch8CfkH5wyluk65UwjawhnlxDJyehVA/e7cDQMuVyuvXxX+2T/NZWLa8iQATgAXSEnfCbgO6BQLiWixc6i5JP1EJFvl5hYRIH+eDZSXi0/18vm3PPnz/XMmaz2e4sNdrb+0dbtZqujwQB8ABKcSdbqag6uJ6HnxieYfWF9qKVSjgrlp8S2qB+cnKWP/vRaMUKGd/c3NxzzeaZnHT6SytLm9uHh0dblZrRBiTAtri+nj/CPOx1MigXDBGh1Sdqb47ezGRRXS5dxNnZ1taPhsNuM5vGx8d8Pm3SYjk4qFZXllYvjg/rR2+2towIeRp5QilMwyE14qmfKDoC9h2Kw1O9l1B+YbxcgOQr9bP80dHucsk5abPZ3G63yaQdHJA+AGzuAgGoIEIt/ykPVgEB9NgEtOPI+s7MPB8H8OZvKjyJRKkb4umTSEwFahVq05Xa1Hw0DKcYlp64ThDqZ5+2jg53V5eqB5ZJCptbq2KsAMDy6tr2Rr3OCADx6RMD1GACjUIxzuzsFMPeILTrGp0GR8ags6EWmOeRLBTOZiOYeBzWvSeoj+KftkC+vr25vFI9cFrAefDeoq2gOgNsIkEcECCOEOMTWsYnTYL74jq/cUhcifHyg3QhIqsNOi/I8xP4sRMUR3WQr2+sra5Uqwcc8IW2vLy8BLGyhBZgEmQAxf4+MhBCfj6KZ3MWT8WsPFbC3GJfiwZPlyJw02ImzFdqmKJQ6Menjf39Q3q/ejy+v4sGVA9k5lcAYHV1lRjYAiKI1/c3jo+PNzY29jcIAULcFuC7H+vifM+K22Mz8i4d3KoJp1gdNu7JyY/j4+3d3bW1kcM4rWp7bXVppcryS7D4Ze3jxy+NNhEgwO4xwB4ebuxybG8jxAaUQ63CDFHym+4CFcXNERFZ0g5x4qOJeXjyyY/t7d3N1Xa7AfEdXdgAA5bIANh3jRaE9ttHiC+Qh2VhwcjjjbWLi82Li4u1NUI4lggwEtbydCUi71TxycqHnag58D2Bp8lUAuR31zZhbaVSKZZMplvfN0B/dZkMqJZaH3/D0PADEqyCHWTBRs/mKsXm5uZaBwNVPw8/+vgnrsv52ggXHsB85c/OtoX8SsnvSKYLZnOh3Fpbwx9UUZ/lAeDlby+JoA0OAMEuJAlQGlQaq50IsDl5pyNFrRbIT9GhSXNpgLpXjQJKHjMv5f0OewHa3hicOoVlUQGtq99+e0mhwT/hAedgudTgQEcMLhADbAsMOSSrWZkGRFp5/rp8zGrHtpuBrguRKVEGWlcvZSAAW/AFFZdL/hLFCiAs6S4IG4gBY+vmAJM2Nqjs9dV7QN6EXX+CwgFtMCn0FyGEA0jQgPqIQZQEwgrujGUuhk1hw7bYnDcEbhfYu5R6li/5nVaQp1NnDPXh9JuYK1T9pL9I+ovCAbKgXUrGZEgblpY7qkEk45g5DHGM0rTjYfEoj/py+Wr9cxiZNMmz/qK2qAO0khQOIvD7MRtgQ2NpSZaDzAabYQj8ET60iRtoGQtdug/Lz1D+lf7c87kruf7cYk5bXJRF0Eqm02kigEACv78jGctycwoQQ+CPWBqaOiy+6ndYrXL5CDAhDXiO0WyCPDugA3xppQuFAhCkrRjI4OdgJxBiiUGYRAQ1kGV+bGUFj1a/3+m0THpsHg9mH9I/dh3geVP4v5iTAB8/kj4S2K2SgIMgqohQEufmCp1drKgCleGv04kHrcUD44aZ008AegkIglNBsEgAYIDQRwvsyWQHgcPhFF74QaNUxb8cfvkHF43STidOGR4P6ptMSl9aoAM8bwoD2AFdv4D6dkIAYauD3XDK8HcEfK8ewWUrcag9XL4O4NNzIAlOFQAZkObVYxXaIYDCKtWtdhgbnfj2sEDnAf3BxVosSprHK48HBz1Wl/oyAwTg06vgPRHkJMDHVkEHEAEIwALydju8OYh4PFJSrtcilo2LpoXbDIs36EsAQYAI79+/Z4IFTAEmoCz0CcDeGXJ9FnJCLdkzqXtuoyHXbDYs3wBA5wDqKw8A4P3pKQCcaq2rq3S6XCYAZABBWHWa/9CesKMI6POKLUqffijVbWax9g59gwWobSgDsuD0tOnUVlZisH4AYAMEAAYpCACw2C4sFxkn421KX7e+EwAIMoYksL4kaKYPDrSlZX+hUFYZgCVz4pkAq4DWiplQ8h4OJe0m+6HtsL6xCHQbjMeBIJijqbhqLlMGClQAsAGsAoBUBcgkfLIYtpoAcJtR2OamAjARgMqB2WTWXRBp8PkkApdBplrVljr0uQep9fOXmH+7yL6QFnWPYioHoIaaJpkKkyIYM9SiT20FJLBWNXuG5KU+7X+5cLvSvwbgYettbgGALCZDwDcZ9kAA+AwEE4atMFfVypnMtfULByzcBWj5mH67xdoBYBabDuof3TDL8iPr9QBb2IJMxlAKyoM0ALABYvsrfZV/Wr1TAkwaASgg+zYPfwd1ICqAPqm/RJDJGLeDJHiuZUQBwOCO21+EVW5GkLdzA8QvZQXaDACUBbMRwCw/qb5AuxEB1GgwIS3QMmXpPwOoNmhRMHQY2akfIQElnSpQ6tAeNNMJ3BGyLWAdZOiDBPApAk20IMpA2p6ULlj1hsSHoQUBJm8GkEbQrjSZOgBMshINADILDEAGyM0PVah7wAVhtWL5YznQoWRRBEaraUPYRD9S7styHBunUqT9MKGCLdDKIgFc/twGZAWo8xgrQQfgNmCTJSh2gpv6Ee4MkKa+pFoC6svDSR7MguC9JiqAZyC5C60dQcch1wXuh0k6gjxu7gQI4ObD0K2fCja3KgBDYyYEPBa5GUwwQFoAOPQJhAEcTv6WGzDpUzHwTnDbzELWLA5jm+FgsrERIivGtqC3ZK4CjfXtYga0irQjDoTFaucCwFMJ2pHYD3In8nGgZgHhAXUGsT3oMZgPVXfOjONWFPpIoKkW3AnABGyA0+GkirBIB8RZbMNiEAt3YzmgHSjvFgUqJwWb4YCEdpBRh/MEAUAHkJcjEsBB8jH81oEXBn4nA9j5QMSKJAM8EsDj5ooUDFwAHnqe2W0cUsdFQ5yQHVmTQyBWgERgFvza6ccrALzHYLVIAAv2RwSgpuDmXLjdCkFsAbMVr6yqDjqoSD/D10njHWOyJq4HO5XxowW+95cacPdwe225UXJC/i1UkBY+EuSdRrYAhxLlAQKY7Y7G2i7ck/Pb9WmJHKDNeA3AkVQAfoegwOuB0tLaPtxbq+9fNEoOHof1YZjbIgJ4qARoSygAWwtujMErdxuxNB8PYjzI4IymF4GG4skY/BMXZH7df6u/sXYYd2HUgYA78qScS8kH1MdCwLCx/RQmW3oEXgkE9eN2rCBOKJO4Vu0ESMbEBZi8JHTy/ndaHaULWMQvQw/ig67DdimGlyUWfTa3cAmqlfPlIH9lM32Pxx89uPNwcLC+3Uirs0HMR9QJfDcD+NFqTIATDNiPux7Ab1Uex4ddI3jDg5Igr02E/2rZ3AR5H5i/1OOD+Bvwh8ODhxclbgummwZEBIgZXDc44Iit1V0P6T9yxIfj9bYBgK9ObHwmqCaoKsBsHh9xuZ7gr+wfDA7HjxuiDkmcysDnkwhQA0KfAPAbBYAG/EL/sSE+OOj6HovJtfPFGY4HFnHVRj1R1gBY3RpE7/Clg2BBOykcGJNzutIHAKWPCHBTglJAVqzWCQB+9ewCgP2SX78wFJ/t3KStTrwjoPIA52/bJV86ODxcX0sWVAaMYzIBwO0g2AdWsQvxrgh5gFBQR5gCTXsIAPHDht+qCJwH/uTV6fuFhWmMhdOrgtXioSZMbWfsO2wAeumT+DDkAPeBqRNA7gUEIBMIgO8MkYrDUdqAdwEjux7D58F4vB2z6jkonE7P/tsQs7lmelIcRiazb8QFO+expsEGAoD9hkdMhpLAp66aNbolpvagXziAf0v7COB6NAx9AAEuYk55qyJN8rMYOsN0E24Q8Ejkw5fGXY8eIfpw/LBtFymgGuQpvRPAeGPKQXc+HI7GoYu7EAO4LmLiZomjuTA7PT0r498KIpee5A3nGyZ2fCHUb7x+gUXATUDctaLrBAWgdyEEiJEDDkf70KUC1/MdHgCAg+QpJV4SoP+SYKEwSYNIGVyLS3QAWHMUVBdSF2pcBFQDshWIm2JWduBmAL/UBwKDCzINZbg3lzEhgP5KI4DxUjFjBIDyo/thYL+DjLZ2ALgEAOkvTP+MYCCAi2QDABLUL6xoTIZjTOQAP8AvLgUA3/dCADkZWhsE8OjBIL6LC2sAHo6BPm6+hQXegrOzKhuSAAAyDPD4sQRIGwAy44YUIICDHFAAYiSzYxG6cBs+dDFBO+Z3+q8W9JjWw2BDrpAxwS7A1wxog5SCw3aBJ5IyXApn8ESU6xcOOKQDlHsekO1W6APowBNh5WADCzQHa8/dgKATzJbNpokRKsInT7gGDksevlIpI4FpXKRBOoDzEAEghiPG85ETCEbihky69ltw05gMyOV+dsFgwand7GvLbUgAG9SK8U4QBwP4fGMGB4gAfrl01YS4KiQhFZMX9bhLbqe4ayRWqsZOST8nEHI3EuTS5vGrwTjNI6Qf/14omG2FcvMU74s1KQ8ZmQPuAwyQTDe/fv0T4uvXZjlp9TQO1TJcVAKlNErnckYEI4Asw0L5/YgExxpsF1A99x+K3CkjiKGAOyH1n9gVqP/6658UgOBJbtfjegaSMORe5RZzKjoBpmVPnJ1tejITX8gBNmAjXVDyjCB3owBgA0Af1H+lQI6vzTQMBHHRheJtu6NUuqIbzIsGCzpzwMdDrjA2jhYI/Xoblv8fYyycltX9EulAzI/6hkATClAFFC7X9zRO+S/FLe6fCPCjaosLadO474p3IDaBcrlTHzxoqkJkAHjvVvPXawB/fi2XL3gqhk6Cv0SKLYpf9BgZWB+/kADTBdhpcx/ppfHDi0zZ6D/HqWyK0oFYK/31ZwDgbF2MbIx8b6XxlxYrLfmLlg4XqDUvGDyYLthgz4812yMjIxfJsUzzugHCAiTw/Re6O33RQLqbHwAAAABJRU5ErkJggg==">
<style>
/* An app dashboard: white cards on a warm off-white, one accent (Snout pink) that always means
   "kept out of context", and provider colors only where they encode a model.
   Shape scale: cards 14px, tiles and inputs 10px, buttons 8px, badges 6px. */
:root {
  --bg: #f2f1ed; --card: #ffffff; --tile: #f6f5f1; --ink: #1a1418; --ink-2: #3b3d37; --muted: #6b6d65; --faint: #9c9e96;
  --line: #e9e8e2; --seg: #e2e3dc; --bar-in: #dcdcd5; --without: #e4e3dc; --accent: #e653ba; --accent-ink: #b0307f; --accent-soft: #fbe6f3; --accent-hi: #ee8fcf;
  --ok: #15803d; --ok-soft: #e7f5ec; --info: #1d4ed8; --info-soft: #eaf0fe; --warn: #b45309; --warn-soft: #fdf1e1; --up: #15803d; --down: #b91c1c;
  --shadow: 0 1px 2px rgba(60, 20, 45, 0.04), 0 8px 24px -12px rgba(120, 40, 90, 0.14);
  --shadow-lg: 0 1px 2px rgba(60, 20, 45, 0.05), 0 24px 48px -24px rgba(120, 40, 90, 0.28);
  --sans: "Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: #0c0c0e; --card: #16161a; --tile: #1d1d22; --ink: #f4f4f5; --ink-2: #d4d4d8; --muted: #a1a1aa; --faint: #71717a;
  --line: #26262c; --seg: #2a2a31; --bar-in: #4a4a52; --accent: #ec5fb0; --accent-ink: #f37fc2; --accent-soft: #3a1a2d;
  --ok: #4ade80; --ok-soft: #13291c; --info: #7aa2ff; --info-soft: #172241; --warn: #fbbf24; --warn-soft: #2e2310; --up: #4ade80; --down: #f87171; --shadow: none; color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 14px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
button, select { font: inherit; color: inherit; }
.num { font-variant-numeric: tabular-nums; }

/* Top navigation */
.nav { background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
.nav-in { max-width: 1320px; margin: 0 auto; height: 60px; padding: 0 24px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 17px; letter-spacing: -0.02em; }
.brand i { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }
.tabs { display: flex; gap: 4px; height: 60px; }
.tab { border: 0; background: none; padding: 0 14px; color: var(--muted); font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s; }
.tab:hover { color: var(--ink); }
.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.nav-r { display: flex; justify-content: flex-end; align-items: center; gap: 10px; min-width: 0; }
.live { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.live i { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.live.on i { background: var(--ok); box-shadow: 0 0 0 0 rgba(21, 128, 61, 0.45); animation: ping 2.4s ease-out infinite; }
@keyframes ping { 0% { box-shadow: 0 0 0 0 rgba(21, 128, 61, 0.45); } 70%, 100% { box-shadow: 0 0 0 7px rgba(21, 128, 61, 0); } }
.proj { font: 12.5px var(--mono); color: var(--ink-2); background: var(--tile); border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.wrap { max-width: 1320px; margin: 0 auto; padding: 24px 24px 56px; }
.head { display: flex; align-items: flex-end; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.head h1 { font-size: 24px; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 4px; font-weight: 650; }
.head .sub { color: var(--muted); font-size: 13.5px; }
.head .sub b { color: var(--ink); font-weight: 600; }
.head .sub span + span::before { content: "\xB7"; margin: 0 8px; color: var(--faint); }
.head-r { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
select { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-size: 13px; max-width: 220px; }
.seg-switch { display: inline-flex; background: var(--tile); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
.seg-switch button { border: 0; background: none; padding: 5px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--muted); cursor: pointer; }
.seg-switch button.on { background: var(--card); color: var(--ink); box-shadow: 0 1px 2px rgba(17, 17, 19, 0.08); }
.seg-switch button.on[data-mode="enforce"] { color: var(--accent-ink); }
.btn { border: 1px solid var(--line); background: var(--card); padding: 7px 13px; border-radius: 8px; font-size: 13px; font-weight: 550; cursor: pointer; white-space: nowrap; transition: transform 0.1s, background 0.15s; }
.btn:hover { background: var(--tile); }
.btn:active { transform: translateY(1px); }
.btn.dark { background: var(--ink); color: var(--card); border-color: var(--ink); }
.btn.dark:hover { opacity: 0.9; }
.btn.accent { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn[disabled] { cursor: default; opacity: 1; }
.btn.done { color: var(--ok); }
.link { color: var(--info); font-size: 13px; font-weight: 550; background: none; border: 0; cursor: pointer; padding: 0; display: inline-flex; gap: 6px; align-items: center; }
.link:hover { text-decoration: underline; }

.banner { display: flex; align-items: center; gap: 14px; background: var(--accent-soft); color: var(--ink); border-radius: 10px; padding: 11px 14px; margin-bottom: 16px; font-size: 13.5px; }
.banner b { color: var(--accent-ink); }
.banner .btn { margin-left: auto; }

.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); padding: 18px 20px; min-width: 0; position: relative; }
.card-h { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.card-h h2 { font-size: 14.5px; font-weight: 600; margin: 0; letter-spacing: -0.005em; }
.card-h p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.card-h .r { margin-left: auto; }
.grid { display: grid; gap: 16px; margin-bottom: 16px; }
.g-row2 { grid-template-columns: minmax(250px, 0.8fr) minmax(0, 1.15fr) minmax(0, 1.35fr); }
.g-row3 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.g-2 { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }

/* Model strip: one card, columns split by hairlines, a segmented meter per model */
.models { display: grid; grid-template-columns: repeat(var(--n, 4), minmax(0, 1fr)); padding: 18px 0; margin-bottom: 16px; }
.model { padding: 0 22px; border-left: 1px solid var(--line); min-width: 0; }
.model:first-child { border-left: 0; }
.m-id { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; min-width: 0; }
.logo { width: 32px; height: 32px; border-radius: 8px; background: var(--tile); border: 1px solid var(--line); display: grid; place-items: center; flex: none; color: var(--ink); }
.logo svg { width: 18px; height: 18px; display: block; }
.logo.sm { width: 20px; height: 20px; border-radius: 6px; border: 0; background: transparent; }
.logo.sm svg { width: 15px; height: 15px; }
.logo b { font-size: 12px; font-weight: 700; color: var(--muted); }
.m-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-sub { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-row { display: flex; align-items: flex-end; gap: 16px; }
.m-val { font-size: 27px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }
.m-note { font-size: 12.5px; margin-top: 3px; color: var(--muted); white-space: nowrap; }
.m-note b { font-weight: 600; color: var(--c, var(--ink)); }
.meter { flex: 1; display: flex; gap: 3px; height: 28px; align-items: stretch; min-width: 90px; max-width: 150px; margin-left: auto; margin-bottom: 4px; }
.meter i { flex: 1; min-width: 2px; border-radius: 1.5px; background: var(--seg); transition: background 0.3s ease; }
.meter i.f { background: var(--c); }
.models-empty { grid-column: 1 / -1; padding: 4px 22px; color: var(--muted); font-size: 13.5px; }

/* Today tiles */
.band { display: grid; grid-template-columns: minmax(0, 1.25fr) repeat(3, minmax(0, 1fr)); padding: 18px 0; margin-bottom: 16px; }
.band > div { padding: 0 22px; border-left: 1px solid var(--line); min-width: 0; }
.band > div:first-child { border-left: 0; }
.band .k { font-size: 12.5px; color: var(--muted); }
.band .v { font-size: 27px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.15; margin-top: 4px; }
.band .hero .v { color: var(--accent-ink); font-size: 32px; }
.band .s { font-size: 12.5px; color: var(--muted); margin-top: 3px; }
.band .spark { display: flex; align-items: flex-end; gap: 2px; height: 26px; margin-top: 10px; max-width: 260px; }
.band .spark i { flex: 1; min-width: 2px; background: var(--accent); opacity: 0.75; border-radius: 1.5px 1.5px 0 0; }
.band .spark i.now { opacity: 1; }
.tiles { display: grid; gap: 10px; }
.tile { background: var(--tile); border-radius: 10px; padding: 12px 14px; }
.tile .k { font-size: 12.5px; color: var(--muted); }
.tile .v { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; margin-top: 2px; }
.tile .s { font-size: 12px; color: var(--muted); margin-top: 1px; }
.tile.hl .v { color: var(--accent-ink); }

/* Live feed */
.feed { display: grid; }
.frow { display: grid; grid-template-columns: 62px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); font-size: 13px; }
.frow:first-child { border-top: 0; }
.frow .when { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.frow .what { display: flex; align-items: center; gap: 8px; min-width: 0; }
.frow .path { font: 12.5px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.frow.fresh { animation: fresh 2.2s ease-out; }
@keyframes fresh { from { background: var(--accent-soft); } to { background: transparent; } }
.badge { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 3px 8px; border-radius: 6px; white-space: nowrap; background: var(--tile); color: var(--ink-2); }
.badge.full { background: var(--ok-soft); color: var(--ok); }
.badge.cut { background: var(--accent-soft); color: var(--accent-ink); }
.badge.ask { background: var(--warn-soft); color: var(--warn); }
.badge.would { background: transparent; color: var(--accent-ink); box-shadow: inset 0 0 0 1px var(--accent); }
.badge.run { background: var(--info-soft); color: var(--info); }

/* Charts */
.chart-box { position: relative; }
svg.trend { width: 100%; height: 250px; display: block; overflow: visible; }
svg text { fill: var(--muted); font: 11px var(--sans); }
.legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 9px; height: 9px; border-radius: 2px; background: var(--c); }
.tip { position: absolute; pointer-events: none; background: var(--ink); color: var(--card); font-size: 12px; padding: 7px 9px; border-radius: 8px; white-space: nowrap; transform: translate(-50%, -100%); opacity: 0; transition: opacity 0.12s; z-index: 2; }
.tip b { font-weight: 600; }

/* Cost table */
.total { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.total .v { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; }
.total .d { font-size: 12.5px; font-weight: 600; }
.total .d.up { color: var(--down); }
.total .d.down { color: var(--up); }
.total .s { font-size: 12.5px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 0 10px 8px 0; white-space: nowrap; }
td { padding: 9px 10px 9px 0; border-top: 1px solid var(--line); vertical-align: middle; }
th.n, td.n { text-align: right; padding-right: 0; padding-left: 10px; }
td.n { font-variant-numeric: tabular-nums; white-space: nowrap; }
td.strong { font-weight: 600; }
.who { display: flex; align-items: center; gap: 8px; min-width: 0; }
.who .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); flex: none; }
.who span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
td.path { font: 12.5px var(--mono); word-break: break-all; }
.reason { color: var(--muted); font: 12px var(--sans); margin-top: 2px; word-break: normal; }
.scroll { overflow-x: auto; }

/* Context mix: one column per file type, split by dashed rules like a timeline */
.mix { display: grid; grid-template-columns: repeat(var(--n, 4), minmax(0, 1fr)); height: 264px; }
.mcol { display: flex; flex-direction: column; border-left: 1px dashed var(--line); padding: 0 0 0 0; min-width: 0; }
.mcol .top { padding: 0 10px 0 12px; }
.mcol .k { font-size: 13px; font-weight: 600; line-height: 1.25; min-height: 2.5em; }
.mcol .v { font-size: 19px; font-weight: 650; letter-spacing: -0.02em; margin-top: 2px; }
.mcol .s { font-size: 12px; color: var(--muted); line-height: 1.3; }
.mcol .s.cut { color: var(--accent-ink); font-weight: 600; }
.mcol .bar { margin-top: auto; display: flex; flex-direction: column; justify-content: flex-end; }
.mcol .pct { font-size: 13px; font-weight: 600; padding: 0 0 6px 12px; }
.mcol .stack { display: flex; flex-direction: column; justify-content: flex-end; transition: height 0.6s cubic-bezier(0.2, 0.7, 0.2, 1); min-height: 3px; }
.mcol .stack i { display: block; transition: height 0.6s cubic-bezier(0.2, 0.7, 0.2, 1); }
.mcol .in { background: var(--bar-in); }
.mcol .out { background: var(--accent); }
.mix-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; gap: 12px; flex-wrap: wrap; }

/* Spend bars */
svg.bars { width: 100%; height: 160px; display: block; }
svg.bars rect.b { fill: var(--ink); opacity: 0.85; }
svg.bars rect.b.today { fill: var(--accent); opacity: 1; }
.split { display: flex; height: 12px; border-radius: 6px; overflow: hidden; gap: 2px; margin: 6px 0 14px; }
.split i { display: block; background: var(--c); min-width: 2px; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; font-size: 13px; }
.kv dt { color: var(--muted); display: flex; align-items: center; gap: 8px; }
.kv dt i { width: 9px; height: 9px; border-radius: 2px; background: var(--c); }
.kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }

/* Settings */
.set { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 14px 0; border-top: 1px solid var(--line); }
.set:first-of-type { border-top: 0; padding-top: 0; }
.set h3 { font-size: 14px; margin: 0 0 3px; font-weight: 600; }
.set p { margin: 0; font-size: 13px; color: var(--muted); max-width: 62ch; }
code { font: 12.5px var(--mono); background: var(--tile); border-radius: 5px; padding: 1px 5px; }

.empty { padding: 36px 20px; text-align: center; color: var(--muted); }
.empty h3 { color: var(--ink); font-size: 17px; margin: 0 0 6px; font-weight: 600; }
.empty ol { text-align: left; display: inline-block; margin: 12px 0 0; padding-left: 20px; line-height: 1.9; }
.none { color: var(--muted); font-size: 13px; padding: 8px 0; }
.sk { background: linear-gradient(90deg, var(--tile), var(--line), var(--tile)); background-size: 200% 100%; animation: sk 1.4s ease-in-out infinite; border-radius: 10px; }
@keyframes sk { from { background-position: 100% 0; } to { background-position: -100% 0; } }
footer { color: var(--faint); font-size: 12px; text-align: center; margin-top: 24px; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 16px); opacity: 0; background: var(--ink); color: var(--card); font-size: 13px; padding: 10px 14px; border-radius: 10px; transition: opacity 0.2s, transform 0.2s; pointer-events: none; z-index: 10; max-width: calc(100% - 32px); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
[hidden] { display: none !important; }

/* The landing page's look, the same as Snout Cloud: a warm off-white fading into pink over a fine
   white grid, glassy navigation, and the pink that means "kept out of context". */
body {
  background-color: var(--bg);
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.75) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.75) 1px, transparent 1px),
    radial-gradient(1200px 520px at 12% 108%, rgba(255, 255, 255, 0.9), transparent 60%),
    linear-gradient(180deg, #f2f3ef 0%, #f1ebee 38%, #f3e0ec 72%, #f4d9ea 100%);
  background-size: 56px 56px, 56px 56px, 100% 100%, 100% 100%;
  background-attachment: fixed;
  min-height: 100dvh;
}
.nav { background: rgba(255, 255, 255, 0.72); backdrop-filter: saturate(1.4) blur(14px); -webkit-backdrop-filter: saturate(1.4) blur(14px); border-bottom: 1px solid rgba(26, 20, 24, 0.06); }
.nav-in { height: 62px; }
.brand { gap: 9px; font-size: 18px; letter-spacing: -0.03em; }
.brand img { width: 30px; height: 25px; object-fit: contain; display: block; }
.brand small { font-weight: 600; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent-ink); background: var(--accent-soft); border-radius: 6px; padding: 3px 7px; }
.tabs { height: auto; gap: 2px; background: rgba(26, 20, 24, 0.04); border-radius: 11px; padding: 3px; }
.tab { padding: 7px 14px; border-radius: 8px; border-bottom: 0; margin: 0; font-weight: 550; }
.tab[aria-selected="true"] { background: var(--card); box-shadow: 0 1px 2px rgba(26, 20, 24, 0.08); }
.head h1 { font-size: 34px; line-height: 1.1; letter-spacing: -0.035em; font-weight: 750; margin-bottom: 6px; }
.card { border-color: rgba(26, 20, 24, 0.06); }
code { font: 12px var(--mono); background: var(--tile); border-radius: 5px; padding: 1px 5px; }

/* Logo motion: a model or MCP server that is working today moves; everything else moves on hover. */
.logo svg { transition: transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1); transform-origin: 50% 50%; }
.logo.live[data-k="claude"] svg { animation: spin 14s linear infinite; }
.logo.live[data-k="openai"] svg { animation: spin 22s linear infinite; }
.logo.live[data-k="gemini"] svg { animation: twinkle 2.6s ease-in-out infinite; }
.logo.live[data-k="cursor"] svg, .logo.live[data-k="copilot"] svg { animation: bob 2.8s ease-in-out infinite; }
:is(.mchip, tr, .mrow, .stat):hover .logo[data-k="claude"] svg, .logo[data-k="claude"]:hover svg { animation: spin 2.4s linear infinite; }
:is(.mchip, tr, .mrow, .stat):hover .logo[data-k="openai"] svg, .logo[data-k="openai"]:hover svg { animation: spin 3s linear infinite; }
:is(.mchip, tr, .mrow, .stat):hover .logo[data-k="gemini"] svg, .logo[data-k="gemini"]:hover svg { animation: twinkle 1.2s ease-in-out infinite; }
:is(.mchip, tr, .mrow, .stat):hover .logo:is([data-k="cursor"], [data-k="copilot"]) svg { animation: bob 1s ease-in-out infinite; }
.logo.live { position: relative; }
.logo.live::after { content: ""; position: absolute; inset: -3px; border-radius: inherit; border: 1.5px solid var(--accent); opacity: 0; animation: halo 2.6s ease-out infinite; pointer-events: none; }
.logo.sm.live::after { border-radius: 50%; inset: -2px; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes twinkle { 0%, 100% { transform: scale(1) rotate(0deg); } 50% { transform: scale(0.72) rotate(45deg); } }
@keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
@keyframes halo { 0% { opacity: 0.7; transform: scale(0.9); } 80%, 100% { opacity: 0; transform: scale(1.35); } }
.pop { animation: pop 0.55s cubic-bezier(0.2, 1.5, 0.4, 1) both; animation-delay: var(--d, 0s); }
@keyframes pop { from { opacity: 0; transform: translateY(6px) scale(0.92); } }

/* Context flow: repo (or folder) cards on the left, the report for the one you point at on the right */
.flow-card { padding: 26px 26px 22px; border-radius: 18px; box-shadow: var(--shadow-lg); margin-bottom: 16px; overflow: hidden; }
.flow-top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 400px); gap: 24px; align-items: end; margin-bottom: 22px; }
.eyebrow { font: 600 11.5px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent-ink); margin-bottom: 10px; }
.flow-top h2 { font-size: 40px; line-height: 1.04; letter-spacing: -0.045em; margin: 0; font-weight: 750; max-width: 620px; }
.flow-info { color: var(--ink-2); font-size: 14px; line-height: 1.55; min-height: 66px; }
.flow-info b { color: var(--ink); }
.flow-info .mono { font-family: var(--mono); font-size: 12.5px; }
.ents { display: grid; gap: 12px; align-content: start; position: relative; z-index: 1; }
.ent { background: #faf9f6; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px 8px; box-shadow: 0 1px 2px rgba(60, 20, 45, 0.05), 0 10px 22px -16px rgba(60, 20, 45, 0.3); transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s; }
.ent.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft), 0 12px 26px -16px rgba(176, 48, 127, 0.45); transform: translateX(4px); }
.ent-h { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; cursor: pointer; min-width: 0; }
.ent-h i { width: 7px; height: 7px; background: var(--ink); border-radius: 1.5px; flex: none; transform: translateY(-1px); }
.ent-h b { font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ent-h .mono, .ent-r .mono { font: 11px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); white-space: nowrap; }
.ent-h .r { margin-left: auto; }
.ent-r { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 7px; margin: 0 -7px; border-radius: 6px; font: 12.5px var(--mono); color: var(--ink-2); cursor: pointer; transition: background 0.15s, color 0.15s; }
.ent-r .src { display: inline-flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ent-r .v { white-space: nowrap; font-variant-numeric: tabular-nums; }
.ent-r .v em { font-style: normal; color: var(--accent-ink); margin-left: 6px; }
.ent-r:hover { background: var(--tile); }
.ent-r.on { background: var(--accent); color: #fff; }
.ent-r.on .v em { color: #fff; }
.ent-r .mlogo { width: 16px; height: 16px; border-radius: 4px; }
.ent-r .mlogo svg { width: 10px; height: 10px; }
.ents .more { font-size: 12.5px; padding: 2px 4px; }

/* MCP servers */
.mcp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.mtile { background: #faf9f6; border: 1px solid var(--line); border-radius: 12px; padding: 14px 15px; display: grid; gap: 10px; min-width: 0; transition: transform 0.2s, box-shadow 0.2s; }
.mtile:hover { transform: translateY(-2px); box-shadow: var(--shadow); }
.mtile-h { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mtile-h .nm { font-weight: 650; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mtile-h .sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mtile-h .live-tag { margin-left: auto; font: 600 10.5px var(--mono); color: var(--ok); background: var(--ok-soft); padding: 2px 6px; border-radius: 5px; letter-spacing: 0.04em; }
.mtile .big { font-size: 24px; font-weight: 700; letter-spacing: -0.03em; color: var(--accent-ink); line-height: 1.1; }
.mtile .big small { font-size: 12.5px; color: var(--muted); font-weight: 500; letter-spacing: 0; margin-left: 4px; }
.wbars { display: grid; grid-template-columns: 58px minmax(0, 1fr) 48px; gap: 4px 8px; align-items: center; font-size: 11.5px; color: var(--muted); }
.wbars i { display: block; height: 8px; border-radius: 2px; transform-origin: left; animation: grow 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
.wbars .n { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.rec { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; line-height: 1.4; color: var(--ink-2); padding-top: 9px; border-top: 1px dashed var(--line); }
.rec i { width: 16px; height: 16px; border-radius: 50%; flex: none; display: grid; place-items: center; font: 700 10px var(--sans); font-style: normal; background: var(--tile); color: var(--muted); margin-top: 1px; }
.rec.ok i { background: var(--ok-soft); color: var(--ok); }
.rec.warn i { background: var(--warn-soft); color: var(--warn); }
.mlogo { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; flex: none; background: color-mix(in srgb, var(--b) 13%, white); color: var(--b); position: relative; }
.mlogo svg { width: 20px; height: 20px; display: block; transition: transform 0.4s cubic-bezier(0.2, 0.7, 0.2, 1); }
.mlogo b { font: 700 13px var(--sans); }
.mlogo.live::after { content: ""; position: absolute; inset: -3px; border-radius: 12px; border: 1.5px solid var(--b); opacity: 0; animation: halo 2.6s ease-out infinite; }
.mlogo.live svg, .mlogo.live b { animation: bob 3.2s ease-in-out infinite; }
.mtile:hover .mlogo svg, .gal-i:hover .mlogo svg { animation: wiggle 0.9s ease-in-out; }
@keyframes wiggle { 0%, 100% { transform: rotate(0) scale(1); } 30% { transform: rotate(-10deg) scale(1.12); } 60% { transform: rotate(8deg) scale(1.08); } }
.gallery { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.gal-i { display: inline-flex; align-items: center; gap: 8px; padding: 5px 11px 5px 5px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); font-size: 12.5px; color: var(--muted); }
.gal-i .mlogo { width: 26px; height: 26px; border-radius: 50%; filter: grayscale(1); opacity: 0.65; transition: filter 0.25s, opacity 0.25s; }
.gal-i .mlogo svg { width: 14px; height: 14px; }
.gal-i:hover { color: var(--ink); }
.gal-i:hover .mlogo { filter: none; opacity: 1; }
.gal-i.seen { color: var(--ink); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.gal-i.seen .mlogo { filter: none; opacity: 1; }

.mrow .logo { width: 28px; height: 28px; border-radius: 8px; }
.mrow .logo svg { width: 16px; height: 16px; }

@media (max-width: 1100px) {
  .flow-top { grid-template-columns: minmax(0, 1fr); }
  .flow-top h2 { font-size: 32px; }
}
@media (max-width: 860px) {
  .ent.on { transform: none; }
}
@media (max-width: 560px) {
  .flow-card { padding: 18px 16px; }
  .flow-top h2 { font-size: 27px; }
}

/* Repo map: relationship lines between folders, file badges */
.ents.erd-gutter { padding-left: 58px; }
.ents .erd { position: absolute; left: 0; top: 0; overflow: visible; }
.erd .lk { cursor: pointer; }
.erd .lk path { fill: none; stroke: #d3cdc6; transition: stroke 0.2s, opacity 0.2s; }
.erd .lk .hit { stroke: transparent; stroke-width: 12; }
.erd .lk circle { fill: var(--card); stroke: #d3cdc6; stroke-width: 1.2; }
.erd .lk text { font: 700 9px var(--mono); fill: var(--muted); }
.erd .lk.on path:not(.hit) { stroke: var(--accent); }
.erd .lk.on circle { stroke: var(--accent); fill: var(--accent-soft); }
.erd .lk.on text { fill: var(--accent-ink); }
.ents.has-on .erd .lk:not(.on) { opacity: 0.35; }
.ent-r .lab { font: 10px var(--mono); text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent-ink); background: var(--accent-soft); border-radius: 4px; padding: 1px 5px; margin-left: 6px; }
.ent-r.on .lab { background: rgba(255, 255, 255, 0.25); color: #fff; }
.fb { font-style: normal; margin-left: 8px; font-size: 11.5px; }
.ent-r .fb.cut { color: var(--accent-ink); font-weight: 600; }
.ent-r .fb.would { color: var(--accent-ink); border: 1px dashed currentColor; border-radius: 4px; padding: 0 4px; }
.ent-r .fb.full { color: var(--ink-2); }
.ent-r .fb.none { color: var(--faint); }
.ent-r.on .fb.fb { color: #fff; border-color: #fff; }
.repo-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: -6px 0 20px; }
.repo-stats > div { background: var(--tile); border-radius: 10px; padding: 11px 14px; }
.repo-stats .k { font-size: 12px; color: var(--muted); }
.repo-stats .v { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; margin-top: 2px; }
.repo-stats .v.pink { color: var(--accent-ink); }
.repo-stats .s { font-size: 11.5px; color: var(--muted); }


.checks { display: flex; flex-wrap: wrap; gap: 10px 22px; margin-bottom: 20px; }
.check { display: inline-flex; align-items: center; gap: 9px; color: var(--ink-2); font-size: 14.5px; }
.check i { width: 17px; height: 17px; border-radius: 4px; background: var(--ink); display: grid; place-items: center; flex: none; }
.check i::after { content: ""; width: 8px; height: 4.5px; border: solid #fff; border-width: 0 0 2px 2px; transform: translateY(-1px) rotate(-45deg); }
.check.off { color: var(--faint); }
.check.off i { background: var(--seg); }
.statement { margin: 0; color: var(--ink); }
.dotted { text-decoration: underline dotted var(--ink-2); text-underline-offset: 5px; text-decoration-thickness: 1.5px; }
.chip { font: 12.5px var(--mono); background: var(--tile); border-radius: 6px; padding: 4px 9px; color: var(--ink-2); white-space: nowrap; }
.hlt { background: var(--accent-hi); border-radius: 3px; }
/* The landing page's session report, per folder or repo: panel, held-back callout, glowing bars */
.rp { background: var(--card); border: 1px solid rgba(26, 20, 24, 0.07); border-radius: 18px; box-shadow: var(--shadow-lg); min-width: 0; overflow: hidden; }
.rp-bar { display: flex; align-items: center; gap: 10px; height: 60px; padding: 0 22px 0 26px; border-bottom: 1px solid var(--line); }
.rp-bar > svg { width: 20px; height: 20px; flex: none; }
.rp-bar select { border: 0; box-shadow: none; background: transparent; font: 650 17px var(--sans); letter-spacing: -0.01em; padding: 4px 2px; max-width: 280px; cursor: pointer; }
.rp-bar .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); animation: ping 2.4s ease-out infinite; }
.rp-bar .mode { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; background: var(--tile); color: var(--ink-2); border-radius: 9px; padding: 7px 12px; font-size: 14px; white-space: nowrap; flex: none; }
.rp-bar .mode svg { width: 15px; height: 15px; }
.rp-body { padding: 26px 30px 24px; }
.rp h3 { font-size: 24px; letter-spacing: -0.025em; font-weight: 700; margin: 0 0 16px; }
.rp .checks { margin-bottom: 22px; }
.rp .statement { font-size: 21px; line-height: 1.45; letter-spacing: -0.01em; margin: 0 0 22px; max-width: 760px; }
.rp hr { border: 0; border-top: 1px solid var(--line); margin: 0 0 18px; }
.rp-ch { display: flex; align-items: center; gap: 14px; color: var(--ink-2); font-size: 14.5px; margin-bottom: 10px; flex-wrap: wrap; }
.rp-ch .legend { margin-left: auto; font-size: 14px; }
.rp-ch .legend i { width: 12px; height: 12px; border-radius: 3px; }
.rp-ch small { color: var(--muted); font-size: 12.5px; }
.rp-rows { display: grid; grid-template-columns: minmax(120px, 0.95fr) minmax(0, 3fr) auto auto; align-items: center; column-gap: 16px; margin-bottom: 18px; }
.rp-rows .nm { font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 10px 0; cursor: pointer; position: relative; }
.rp-rows .nm span { padding: 2px 6px; border-radius: 4px; transition: background 0.2s, color 0.2s; }
.rp-rows .nm small { display: block; color: var(--muted); font-size: 11.5px; margin-top: 1px; padding-left: 6px; }
.rp-rows .bb { display: grid; gap: 4px; cursor: pointer; }
.rp-rows .bb i { display: block; height: 11px; border-radius: 2px; transform-origin: left; animation: grow 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
.rp-rows .bb .w { background: var(--ink); min-width: 4px; }
.rp-rows .bb .wo { background: var(--without); animation-delay: 0.06s; }
.rp-rows .bb .w.proj { background: repeating-linear-gradient(135deg, var(--ink) 0 3px, #4a4048 3px 6px); }
.rp-rows .val { font-size: 17px; font-weight: 650; text-align: right; font-variant-numeric: tabular-nums; }
.rp-rows .val span { padding: 3px 7px; border-radius: 5px; transition: background 0.2s; }
.rp-rows .pc { font-size: 16px; text-align: right; color: var(--ink-2); font-variant-numeric: tabular-nums; min-width: 66px; }
.rp-rows .sel .nm span, .rp-rows .val.sel span { background: var(--accent-hi); color: var(--ink); }
.rp-rows .nm.sel span { background: var(--accent-hi); }
.rp-rows .flash span { animation: flash 2s ease-out; }
@keyframes flash { from { background: var(--accent); color: #fff; } }
.rp-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 18px; border-top: 1px solid var(--line); }
.rp-foot .k { color: var(--ink-2); font-size: 14.5px; margin-right: 6px; }
.rp-foot .chip { font-size: 13.5px; padding: 6px 11px; }
.rp-foot .sp { flex: 1; }
.rp-foot .acts { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
.rp-foot .btn { font-size: 14.5px; padding: 9px 15px; border-radius: 10px; }
.rp-foot .btn.outline { border: 2px solid var(--ink); }
.rp-explain { margin-top: 14px; background: var(--tile); border-radius: 12px; padding: 12px 14px; font-size: 13.5px; color: var(--ink-2); line-height: 1.5; }
.rp-explain b { color: var(--ink); }
.rp-empty { color: var(--muted); padding: 10px 0 18px; }

.callout { background: var(--card); border: 1px solid rgba(26, 20, 24, 0.07); border-radius: 16px; box-shadow: var(--shadow-lg); padding: 24px 26px 18px; position: relative; z-index: 2; }
.callout h4 { font-size: 22px; letter-spacing: -0.02em; margin: 0; font-weight: 700; }
.callout h4 .hlt { background: var(--accent-hi); border-radius: 4px; padding: 0 5px; margin-left: -5px; }
.callout .sub { color: var(--ink-2); font-size: 16px; margin: 6px 0 16px; }
.callout .grep { font: 15px var(--mono); background: var(--tile); border-radius: 10px; padding: 14px 16px; overflow-x: auto; white-space: nowrap; margin-bottom: 14px; }
.callout .grep.wrap { white-space: normal; font: 14.5px/1.5 var(--sans); }
.callout table { font-size: 15.5px; }
.callout th { font-size: 14px; color: var(--muted); font-weight: 500; padding-bottom: 10px; }
.callout td { padding: 11px 10px 11px 0; }
.callout th:last-child, .callout td:last-child { text-align: right; padding-right: 0; }
.callout .cf { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 15px; color: var(--ink-2); flex-wrap: wrap; }
.callout .cf .link { font-size: 15px; text-decoration-color: var(--ink); text-decoration-thickness: 1.5px; }
.callout .loading { height: 140px; }

.gbar { background: color-mix(in srgb, var(--card) 92%, transparent); border: 1px solid rgba(26, 20, 24, 0.07); border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(60, 20, 45, 0.04); }
.gbar-h { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.gbar-h b { font-size: 15px; font-weight: 650; }
.gbar-h span { font-size: 13px; color: var(--muted); }
.gbar p { margin: 8px 0 14px; font-size: 15px; }
.gbar p .hlt { background: var(--accent-hi); padding: 0 3px; }
.gb-rows { display: grid; grid-template-columns: minmax(90px, 0.6fr) minmax(0, 2fr) auto; gap: 10px 14px; align-items: center; font-size: 13.5px; }
.gb-rows .t { font-variant-numeric: tabular-nums; color: var(--ink-2); text-align: right; white-space: nowrap; }
.gb-rows .track { height: 9px; }
.gb-rows .track i { display: block; height: 100%; background: var(--ink); border-radius: 1px; transform-origin: left; animation: grow 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) both; animation-delay: var(--d, 0s); }
.gb-rows .track i.pink { background: var(--accent); box-shadow: 0 0 0 1.5px var(--ink), 0 0 16px 2px rgba(230, 83, 186, 0.55); animation: grow 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) both, glow 2.8s ease-in-out 1s infinite; animation-delay: var(--d, 0s), 1s; }
@keyframes glow { 0%, 100% { box-shadow: 0 0 0 1.5px var(--ink), 0 0 10px 1px rgba(230, 83, 186, 0.4); } 50% { box-shadow: 0 0 0 1.5px var(--ink), 0 0 22px 5px rgba(230, 83, 186, 0.7); } }

/* Repo section on the dashboard: folder cards and the report panel side by side */
.rmap { display: grid; grid-template-columns: minmax(0, 400px) minmax(0, 1fr); gap: 26px; align-items: start; }
.rmap > .ents { min-width: 0; }
.rmap .ent { min-width: 0; overflow: hidden; }
.rmap .ent-h b { min-width: 0; }
.rmap .rp { position: sticky; top: 80px; }
.ent { cursor: pointer; }
.ent.sel { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft), 0 12px 26px -16px rgba(176, 48, 127, 0.45); }
.ent .open { font: 600 11px var(--mono); color: var(--accent-ink); opacity: 0; transition: opacity 0.2s; margin-left: 8px; }
.ent:hover .open, .ent.sel .open { opacity: 1; }

/* The pop-up report page: the landing page's composition for one folder */
.sheet { position: fixed; inset: 0; z-index: 50; overflow-y: auto; background-color: #f2f1ed;
  background-image: linear-gradient(rgba(255, 255, 255, 0.75) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.75) 1px, transparent 1px), linear-gradient(180deg, #f2f3ef 0%, #f1e6ee 45%, #f3d9ea 100%);
  background-size: 56px 56px, 56px 56px, 100% 100%; animation: sheetin 0.35s cubic-bezier(0.2, 0.7, 0.2, 1); }
@keyframes sheetin { from { opacity: 0; transform: translateY(14px); } }
.sheet-in { max-width: 1360px; margin: 0 auto; padding: 22px 32px 64px; position: relative; }
.sheet-top { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
.sheet-top .x { margin-left: auto; }
.sheet-grid { display: grid; grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr); gap: 56px; align-items: start; position: relative; }
.sheet h1 { font-size: 54px; line-height: 1.04; letter-spacing: -0.045em; font-weight: 800; margin: 18px 0 18px; }
.sheet .lede { font-size: 19px; line-height: 1.45; color: var(--ink-2); margin: 0 0 40px; max-width: 470px; }
.sheet .stack { display: grid; gap: 14px; margin-top: 18px; }
.sheet .wire { position: absolute; inset: 0; pointer-events: none; overflow: visible; width: 100%; height: 100%; }
.sheet .wire path { fill: none; stroke: var(--accent); stroke-width: 2; }
.sheet .wire circle { fill: var(--accent); }
.stairs { position: absolute; display: grid; gap: 5px; pointer-events: none; }
.stairs i { display: block; height: 4px; background: var(--ink); }
.stairs i.p { background: var(--accent); }
.stairs.l { left: 0; top: 340px; justify-items: start; }
.stairs.r { right: 0; top: 120px; justify-items: end; }

@media (max-width: 1100px) {
  .sheet-grid { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .sheet .wire { display: none; }
  .rmap { grid-template-columns: minmax(0, 1fr); }
  .rmap .rp { position: static; }
}
@media (max-width: 640px) {
  .sheet-in { padding: 16px 16px 48px; }
  .sheet h1 { font-size: 36px; }
  .rp-body { padding: 20px 18px; }
  .rp h3 { font-size: 20px; }
  .rp .statement { font-size: 17px; }
  .rp-rows { grid-template-columns: minmax(90px, 1fr) minmax(0, 1.4fr) auto; }
  .rp-rows .pc { display: none; }
  .stairs { display: none; }
}

/* Agent context files */
.af-sum { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
.af-sum > div { background: var(--tile); border-radius: 10px; padding: 11px 14px; }
.af-sum .k { font-size: 12px; color: var(--muted); }
.af-sum .v { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; margin-top: 2px; }
.af-sum .v.pink { color: var(--accent-ink); }
.af { display: grid; grid-template-columns: minmax(0, 1.7fr) 128px minmax(110px, 1fr) 92px; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.af .p { min-width: 0; }
.af .p b { display: block; font: 600 12.5px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.af .p small { color: var(--muted); font-size: 11.5px; }
.af .kind { font-size: 12px; color: var(--muted); }
.af .kind b { color: var(--ink); font-weight: 600; display: block; }
.af .bar { height: 8px; border-radius: 3px; background: var(--seg); overflow: hidden; }
.af .bar i { display: block; height: 100%; background: var(--ink); transform-origin: left; animation: grow 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
.af .bar i.always { background: var(--accent); }
.af .bar i.od { background: var(--bar-in); }
.af .n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 650; font-size: 13px; }
.af .n small { display: block; color: var(--muted); font-weight: 400; font-size: 11px; }
.flag { display: inline-block; font: 600 10px var(--mono); text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 5px; background: var(--warn-soft); color: var(--warn); margin: 4px 4px 0 0; cursor: help; }
@keyframes grow { from { transform: scaleX(0); } }
@media (max-width: 800px) {
  .tabs { justify-self: start; max-width: 100%; overflow-x: auto; }
  .repo-stats, .af-sum { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .af { grid-template-columns: minmax(0, 1fr) 84px; }
  .af .kind, .af .bar { display: none; }
  .ents.erd-gutter { padding-left: 0; }
  .ents .erd { display: none; }
}

@media (max-width: 1100px) {
  .g-row2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .g-row2 > :last-child { grid-column: 1 / -1; }
  .models { --n: 2 !important; row-gap: 22px; }
  .band { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 22px; }
  .band > div:nth-child(odd) { border-left: 0; }
  .model:nth-child(odd) { border-left: 0; }
}
@media (max-width: 800px) {
  .nav-in { grid-template-columns: auto 1fr; height: auto; padding: 10px 16px 0; row-gap: 0; }
  .tabs { grid-column: 1 / -1; grid-row: 2; height: 44px; overflow-x: auto; }
  .proj { display: none; }
  .wrap { padding: 18px 16px 48px; }
  .g-row2, .g-row3, .g-2 { grid-template-columns: minmax(0, 1fr); }
  .head-r { margin-left: 0; width: 100%; }
  .mix { height: 240px; }
}
@media (max-width: 560px) {
  .models { --n: 1 !important; }
  .band { grid-template-columns: minmax(0, 1fr); }
  .band > div { border-left: 0; }
  .model { border-left: 0; }
  .frow { grid-template-columns: 52px minmax(0, 1fr) auto; }
  .hide-sm { display: none; }
  .mix { --n: 3 !important; }
  .mix .mcol:nth-child(n+4) { display: none; }
}
@media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
</style>
</head>
<body data-key="__SNOUT_KEY__">
<header class="nav">
  <div class="nav-in">
    <div class="brand"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABsCAMAAACVZkoAAAABiVBMVEVMaXH37+rSp42xh3OcZkvi0cfcwrb69/cjGRvt4N80Jil1NEvXsKfh1szKmXvOtKS8nIekoqJTUFChkYw3NDWCfXxnZWXhha70X6XyXaLrU5fnVZfxWZ7qV5n2Z6zlVJXoUZQJAwL2Y6n2bbPyWaHuWJySUzL2aq/tVZl8QSHiT5F2Ph+NTi2ZVzehYD6mZEKISSrhVJMWCgmERST4ocbmWZdvOx6dWzvpXZuraUb4q832c7bzZqiwbkv0k7h5OiZ+RCr3msDsYJ/6s9Ttj7CxZju2dFHRQH32ervKPXfYQ4PBOXLaTYv5qbO7bkPliKipL2DwZqPEdktuMxjhR4q+e1ioXjRpLRR1NR9yGjW2NGpsJyKQJEzFhGGcKlYtBwufVi+TTynNf1L1mKD4gcFhFynpS49FERmGTzVcIRLegJ+CH0HNTIGUSTbyd6f1hbHXdpfhlmiGOyzWi1+PWT36maaqP2vcX5F7LiqqcVXodKK8TXvMjm3MaY33jaS1gGOVPF6ZPEPWhY4t9OjKAAAAGHRSTlMAEtLd/lh6BP4u/v6sRviOwnDNk9yftsrAyv1DAAAACXBIWXMAAAAAAAAD6AF+hNEZAAAUJklEQVRo3tWa91sbybKGhxwd1/ZRRBIogHJAlgAF0MHCgI6NLGGLKOM1YBYhvCyLDHL8z0+F7p4RZu997rPsD7dskxS+t7+qrq4ZrGn/v2Lgf3l4YOCfFB/o/PxX4v8QBL1r11DXXxhBPxkYGuInDPwTqx/oG+2+e/dud3f/0HUJWvNQfzc+frd7tO/2CeD9+nq+rWPs7Hy+291ndBo/d/Xf/1YsFvFheEL3nVvX7xq9LF5mZyCyRWQgBEw7L/5ez2UWo4iBj/fftj4IRMIUkQgwIAJlAhffd/+ydybLdESBPozeqv5AT29vKhTyhiBS4QjbAJkYvdd/735PL/4MuDAi5BGacO826+B+b2/IK4IQIoyws46+ABVARVSgEfBo/20RDGj3elPn3iBGNBpkhHCYi2Fnvci5zxIB5yhCJtwduh2CAW2oN+X98CEaTWAAQjDoTaUwE1ky+/Pnz8ABJYD6KYIjg9a7by0B5+cfovMUCY5gKJWSiS/S5izOEAAUCrIx3LdbScKA1td7/uEDiE+pSIhEsA8cnICQ/uNsdv1u160Y0AMGgH4+EJgKoHwAADARwOAVCw5j8lPhVErnIm9uwYIB7Q4bMBVQMTUVpUAGL29NFAf7Q16vZML0FHu6biEDWAEAAMJPFUBCFCRuDN6bYVbnbyRB9u9XAW4BrgDQf/pUB4hiSSQ4F8hA6gonJCq02HMLPeDDudQPKAJZkglGEADKDzSBLbi887ct6CH9KTJAeRBQ+4Ebg5fXH1UEISaYmRn9ewBQgrQFpqgAQL/CBE/JBSagQhBtMqqqAgCoHfwfy3BAnq+GDFACePHKAvhEGxI/omhUAUgTaGdAv76eg2sCfzFwGp7SQzvgqSEEgcgBNoVgMCH2pdyb8twEgI5DceB/HG3hp0N9EEMKAeaA3uv6hkJAA3hLiFOCvKAaOOfdGI5c3u8QGECFO11/gXDn/jeMu933hvgZ0IbBAIN+heT17SgaczSh12OQ5GVHCme/yTMR1tTV3w0nF8wR/TcSjF729vbOzFxeFtc/MwKVQL5z9RXdgKmpeYYA/Xl5UnrlTmSEmd4+MTBrWn/Ptx0RowM/+z8KQ8/5OfsGh3k/T2KBQKd6pfLzXuTlY3cUAEHRkqgM7os5vev+JZzaeHDiGX59e+KZ13t+LsDDMzD0dYMJMOzNP31DoiReEV9LgnlRiKo363sSY8+byu6QFnTUnuIOq+MEs/6t73oS4MyDnotzB9RRKoLjTl9XbwSeHvZGA5U3HKx/zYIAOzBvIMC6DIL6H7//8W6nC9cHrgrxLI2N3ddbvpDHoQONRISd7iC4GMaRoxjxTlXeHEEQQyeAKEFj7JH473/88e7VqyxcJPT36uI0Nha/DXXuz35o+bB6nnvYBRDOwjqCXmbAqScSCiYClYp0g6L2tFarwacAbYi9t6+zr96BtlB/8SIbvgf6l6yuj62XfZ0Av7D9kFTJEAxFsuvFxFQ0uBd6+/b169fPsi9evXsHb7v+KjsDw5c3uMeBVUM5I13WhqeR/LNnkVBPfyorxiY5tMJm6/8ZQBoA0w+NXaHIzPpOogZf7e29fcsQz168eAUYCELxe0ewMDyIH0j+NYCmwnLp4sqGEG4AmFf6eTxrgCAMBNEa1NaeRHgm4gXFK4p3jNQZsHyQf/0W9qRBPCUIwpFeBcDHAx86+bP5Mzx78vkpqkYvEgRrVFaE8PpmBKZgjlfv+GvUf/t2L+HNol4EZ7YUD5AIEsEaMJ5Mfecf8vn8fF44AEE1hQSfvZUpowk6hGDQKQxB+nt7iT2oF5xZUTwkIGB6jFwOqQ48Otrf19XVO5+vIQLIYwrgS5o+veFI8XPozRR58FYRdCJch8CfkH5wyluk65UwjawhnlxDJyehVA/e7cDQMuVyuvXxX+2T/NZWLa8iQATgAXSEnfCbgO6BQLiWixc6i5JP1EJFvl5hYRIH+eDZSXi0/18vm3PPnz/XMmaz2e4sNdrb+0dbtZqujwQB8ABKcSdbqag6uJ6HnxieYfWF9qKVSjgrlp8S2qB+cnKWP/vRaMUKGd/c3NxzzeaZnHT6SytLm9uHh0dblZrRBiTAtri+nj/CPOx1MigXDBGh1Sdqb47ezGRRXS5dxNnZ1taPhsNuM5vGx8d8Pm3SYjk4qFZXllYvjg/rR2+2towIeRp5QilMwyE14qmfKDoC9h2Kw1O9l1B+YbxcgOQr9bP80dHucsk5abPZ3G63yaQdHJA+AGzuAgGoIEIt/ykPVgEB9NgEtOPI+s7MPB8H8OZvKjyJRKkb4umTSEwFahVq05Xa1Hw0DKcYlp64ThDqZ5+2jg53V5eqB5ZJCptbq2KsAMDy6tr2Rr3OCADx6RMD1GACjUIxzuzsFMPeILTrGp0GR8ags6EWmOeRLBTOZiOYeBzWvSeoj+KftkC+vr25vFI9cFrAefDeoq2gOgNsIkEcECCOEOMTWsYnTYL74jq/cUhcifHyg3QhIqsNOi/I8xP4sRMUR3WQr2+sra5Uqwcc8IW2vLy8BLGyhBZgEmQAxf4+MhBCfj6KZ3MWT8WsPFbC3GJfiwZPlyJw02ImzFdqmKJQ6Menjf39Q3q/ejy+v4sGVA9k5lcAYHV1lRjYAiKI1/c3jo+PNzY29jcIAULcFuC7H+vifM+K22Mz8i4d3KoJp1gdNu7JyY/j4+3d3bW1kcM4rWp7bXVppcryS7D4Ze3jxy+NNhEgwO4xwB4ebuxybG8jxAaUQ63CDFHym+4CFcXNERFZ0g5x4qOJeXjyyY/t7d3N1Xa7AfEdXdgAA5bIANh3jRaE9ttHiC+Qh2VhwcjjjbWLi82Li4u1NUI4lggwEtbydCUi71TxycqHnag58D2Bp8lUAuR31zZhbaVSKZZMplvfN0B/dZkMqJZaH3/D0PADEqyCHWTBRs/mKsXm5uZaBwNVPw8/+vgnrsv52ggXHsB85c/OtoX8SsnvSKYLZnOh3Fpbwx9UUZ/lAeDlby+JoA0OAMEuJAlQGlQaq50IsDl5pyNFrRbIT9GhSXNpgLpXjQJKHjMv5f0OewHa3hicOoVlUQGtq99+e0mhwT/hAedgudTgQEcMLhADbAsMOSSrWZkGRFp5/rp8zGrHtpuBrguRKVEGWlcvZSAAW/AFFZdL/hLFCiAs6S4IG4gBY+vmAJM2Nqjs9dV7QN6EXX+CwgFtMCn0FyGEA0jQgPqIQZQEwgrujGUuhk1hw7bYnDcEbhfYu5R6li/5nVaQp1NnDPXh9JuYK1T9pL9I+ovCAbKgXUrGZEgblpY7qkEk45g5DHGM0rTjYfEoj/py+Wr9cxiZNMmz/qK2qAO0khQOIvD7MRtgQ2NpSZaDzAabYQj8ET60iRtoGQtdug/Lz1D+lf7c87kruf7cYk5bXJRF0Eqm02kigEACv78jGctycwoQQ+CPWBqaOiy+6ndYrXL5CDAhDXiO0WyCPDugA3xppQuFAhCkrRjI4OdgJxBiiUGYRAQ1kGV+bGUFj1a/3+m0THpsHg9mH9I/dh3geVP4v5iTAB8/kj4S2K2SgIMgqohQEufmCp1drKgCleGv04kHrcUD44aZ008AegkIglNBsEgAYIDQRwvsyWQHgcPhFF74QaNUxb8cfvkHF43STidOGR4P6ptMSl9aoAM8bwoD2AFdv4D6dkIAYauD3XDK8HcEfK8ewWUrcag9XL4O4NNzIAlOFQAZkObVYxXaIYDCKtWtdhgbnfj2sEDnAf3BxVosSprHK48HBz1Wl/oyAwTg06vgPRHkJMDHVkEHEAEIwALydju8OYh4PFJSrtcilo2LpoXbDIs36EsAQYAI79+/Z4IFTAEmoCz0CcDeGXJ9FnJCLdkzqXtuoyHXbDYs3wBA5wDqKw8A4P3pKQCcaq2rq3S6XCYAZABBWHWa/9CesKMI6POKLUqffijVbWax9g59gwWobSgDsuD0tOnUVlZisH4AYAMEAAYpCACw2C4sFxkn421KX7e+EwAIMoYksL4kaKYPDrSlZX+hUFYZgCVz4pkAq4DWiplQ8h4OJe0m+6HtsL6xCHQbjMeBIJijqbhqLlMGClQAsAGsAoBUBcgkfLIYtpoAcJtR2OamAjARgMqB2WTWXRBp8PkkApdBplrVljr0uQep9fOXmH+7yL6QFnWPYioHoIaaJpkKkyIYM9SiT20FJLBWNXuG5KU+7X+5cLvSvwbgYettbgGALCZDwDcZ9kAA+AwEE4atMFfVypnMtfULByzcBWj5mH67xdoBYBabDuof3TDL8iPr9QBb2IJMxlAKyoM0ALABYvsrfZV/Wr1TAkwaASgg+zYPfwd1ICqAPqm/RJDJGLeDJHiuZUQBwOCO21+EVW5GkLdzA8QvZQXaDACUBbMRwCw/qb5AuxEB1GgwIS3QMmXpPwOoNmhRMHQY2akfIQElnSpQ6tAeNNMJ3BGyLWAdZOiDBPApAk20IMpA2p6ULlj1hsSHoQUBJm8GkEbQrjSZOgBMshINADILDEAGyM0PVah7wAVhtWL5YznQoWRRBEaraUPYRD9S7styHBunUqT9MKGCLdDKIgFc/twGZAWo8xgrQQfgNmCTJSh2gpv6Ee4MkKa+pFoC6svDSR7MguC9JiqAZyC5C60dQcch1wXuh0k6gjxu7gQI4ObD0K2fCja3KgBDYyYEPBa5GUwwQFoAOPQJhAEcTv6WGzDpUzHwTnDbzELWLA5jm+FgsrERIivGtqC3ZK4CjfXtYga0irQjDoTFaucCwFMJ2pHYD3In8nGgZgHhAXUGsT3oMZgPVXfOjONWFPpIoKkW3AnABGyA0+GkirBIB8RZbMNiEAt3YzmgHSjvFgUqJwWb4YCEdpBRh/MEAUAHkJcjEsBB8jH81oEXBn4nA9j5QMSKJAM8EsDj5ooUDFwAHnqe2W0cUsdFQ5yQHVmTQyBWgERgFvza6ccrALzHYLVIAAv2RwSgpuDmXLjdCkFsAbMVr6yqDjqoSD/D10njHWOyJq4HO5XxowW+95cacPdwe225UXJC/i1UkBY+EuSdRrYAhxLlAQKY7Y7G2i7ck/Pb9WmJHKDNeA3AkVQAfoegwOuB0tLaPtxbq+9fNEoOHof1YZjbIgJ4qARoSygAWwtujMErdxuxNB8PYjzI4IymF4GG4skY/BMXZH7df6u/sXYYd2HUgYA78qScS8kH1MdCwLCx/RQmW3oEXgkE9eN2rCBOKJO4Vu0ESMbEBZi8JHTy/ndaHaULWMQvQw/ig67DdimGlyUWfTa3cAmqlfPlIH9lM32Pxx89uPNwcLC+3Uirs0HMR9QJfDcD+NFqTIATDNiPux7Ab1Uex4ddI3jDg5Igr02E/2rZ3AR5H5i/1OOD+Bvwh8ODhxclbgummwZEBIgZXDc44Iit1V0P6T9yxIfj9bYBgK9ObHwmqCaoKsBsHh9xuZ7gr+wfDA7HjxuiDkmcysDnkwhQA0KfAPAbBYAG/EL/sSE+OOj6HovJtfPFGY4HFnHVRj1R1gBY3RpE7/Clg2BBOykcGJNzutIHAKWPCHBTglJAVqzWCQB+9ewCgP2SX78wFJ/t3KStTrwjoPIA52/bJV86ODxcX0sWVAaMYzIBwO0g2AdWsQvxrgh5gFBQR5gCTXsIAPHDht+qCJwH/uTV6fuFhWmMhdOrgtXioSZMbWfsO2wAeumT+DDkAPeBqRNA7gUEIBMIgO8MkYrDUdqAdwEjux7D58F4vB2z6jkonE7P/tsQs7lmelIcRiazb8QFO+expsEGAoD9hkdMhpLAp66aNbolpvagXziAf0v7COB6NAx9AAEuYk55qyJN8rMYOsN0E24Q8Ejkw5fGXY8eIfpw/LBtFymgGuQpvRPAeGPKQXc+HI7GoYu7EAO4LmLiZomjuTA7PT0r498KIpee5A3nGyZ2fCHUb7x+gUXATUDctaLrBAWgdyEEiJEDDkf70KUC1/MdHgCAg+QpJV4SoP+SYKEwSYNIGVyLS3QAWHMUVBdSF2pcBFQDshWIm2JWduBmAL/UBwKDCzINZbg3lzEhgP5KI4DxUjFjBIDyo/thYL+DjLZ2ALgEAOkvTP+MYCCAi2QDABLUL6xoTIZjTOQAP8AvLgUA3/dCADkZWhsE8OjBIL6LC2sAHo6BPm6+hQXegrOzKhuSAAAyDPD4sQRIGwAy44YUIICDHFAAYiSzYxG6cBs+dDFBO+Z3+q8W9JjWw2BDrpAxwS7A1wxog5SCw3aBJ5IyXApn8ESU6xcOOKQDlHsekO1W6APowBNh5WADCzQHa8/dgKATzJbNpokRKsInT7gGDksevlIpI4FpXKRBOoDzEAEghiPG85ETCEbihky69ltw05gMyOV+dsFgwand7GvLbUgAG9SK8U4QBwP4fGMGB4gAfrl01YS4KiQhFZMX9bhLbqe4ayRWqsZOST8nEHI3EuTS5vGrwTjNI6Qf/14omG2FcvMU74s1KQ8ZmQPuAwyQTDe/fv0T4uvXZjlp9TQO1TJcVAKlNErnckYEI4Asw0L5/YgExxpsF1A99x+K3CkjiKGAOyH1n9gVqP/6658UgOBJbtfjegaSMORe5RZzKjoBpmVPnJ1tejITX8gBNmAjXVDyjCB3owBgA0Af1H+lQI6vzTQMBHHRheJtu6NUuqIbzIsGCzpzwMdDrjA2jhYI/Xoblv8fYyycltX9EulAzI/6hkATClAFFC7X9zRO+S/FLe6fCPCjaosLadO474p3IDaBcrlTHzxoqkJkAHjvVvPXawB/fi2XL3gqhk6Cv0SKLYpf9BgZWB+/kADTBdhpcx/ppfHDi0zZ6D/HqWyK0oFYK/31ZwDgbF2MbIx8b6XxlxYrLfmLlg4XqDUvGDyYLthgz4812yMjIxfJsUzzugHCAiTw/Re6O33RQLqbHwAAAABJRU5ErkJggg==" alt="">Snout<small>Local</small></div>
    <nav class="tabs" role="tablist" aria-label="Sections">
      <button class="tab" role="tab" data-tab="overview" aria-selected="true">Dashboard</button>
      <button class="tab" role="tab" data-tab="context" aria-selected="false">Context</button>
      <button class="tab" role="tab" data-tab="spend" aria-selected="false">Spend</button>
      <button class="tab" role="tab" data-tab="settings" aria-selected="false">Settings</button>
    </nav>
    <div class="nav-r">
      <span class="live" id="live"><i></i><span id="live-t">Connecting</span></span>
      <span class="proj" id="proj" title="Project"></span>
    </div>
  </div>
</header>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<main class="wrap">
  <div class="head">
    <div>
      <h1 id="title">Dashboard</h1>
      <div class="sub" id="headline"><span>Loading</span></div>
    </div>
    <div class="head-r">
      <select id="session" aria-label="Session"><option value="">All sessions</option></select>
      <div class="seg-switch" id="modeSwitch" role="group" aria-label="Mode" hidden>
        <button type="button" data-mode="observe">Observe</button>
        <button type="button" data-mode="enforce">Enforce</button>
      </div>
      <button type="button" class="btn dark" id="connect" hidden>Connect team</button>
    </div>
  </div>
  <div id="banner"></div>

  <!-- Dashboard -->
  <section data-view="overview">
    <div class="card band" id="band"><div class="sk" style="height:96px;grid-column:1/-1;margin:0 22px"></div></div>
    <div id="repo"></div>
    <div class="card models" id="models"><div class="models-empty"><div class="sk" style="height:74px"></div></div></div>

    <div class="grid g-row2">
      <div class="card">
        <div class="card-h"><div><h2>Snout today</h2><p>What stayed out of your agents' context</p></div></div>
        <div class="tiles">
          <div class="tile hl"><div class="k">Kept out of context</div><div class="v num" id="t-held">0</div><div class="s" id="t-held-s">tokens</div></div>
          <div class="tile"><div class="k">Saved</div><div class="v num" id="t-saved">$0.00</div><div class="s" id="t-saved-s">at your models' input price</div></div>
          <div class="tile"><div class="k">Reads trimmed</div><div class="v num" id="t-cut">0</div><div class="s" id="t-cut-s">of today's reads</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Live context</h2><p>Each file and tool result, as your agents read it</p></div><button class="link r" type="button" data-go="context">View all</button></div>
        <div class="feed" id="feed"><div class="sk" style="height:220px"></div></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Context over time</h2><p>Last 7 days, tokens per day</p></div>
          <div class="legend r"><span style="--c: var(--ink)"><i></i>Into context</span><span style="--c: var(--accent)"><i></i>Kept out</span></div></div>
        <div class="chart-box" id="trend-box"><svg class="trend" id="trend" role="img" aria-label="Tokens into context and kept out, per day"></svg><div class="tip" id="trend-tip"></div></div>
      </div>
    </div>

    <div class="grid g-2">
      <div class="card">
        <div class="card-h"><div><h2>Savings by feature</h2><p>Tokens your agents asked for, and what each Snout feature kept out</p></div></div>
        <div id="mix"><div class="sk" style="height:264px"></div></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Cost breakdown</h2><p id="cost-p">API-equivalent, from your agents' own usage logs</p></div><button class="link r" type="button" data-go="spend">View spend</button></div>
        <div id="cost"><div class="sk" style="height:200px"></div></div>
      </div>
    </div>
  </section>

  <!-- Context -->
  <section data-view="context" hidden>
    <div class="grid"><div id="agentfiles-box"></div></div>
    <div class="grid"><div id="mcp-box"></div></div>
    <div class="grid g-2">
      <div class="card">
        <div class="card-h"><div><h2>Live context</h2><p id="feed-all-p">Newest first</p></div></div>
        <div class="scroll"><table id="feed-all"></table></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Files that cost the most context</h2><p>Kept out by Snout first, then the largest full reads</p></div></div>
        <div class="scroll"><table id="files"></table></div>
      </div>
    </div>
    <div class="grid g-row3">
      <div class="card"><div class="card-h"><div><h2>By coding agent</h2><p>Reads and tokens per agent</p></div></div><div class="scroll"><table id="clients"></table></div></div>
      <div class="card"><div class="card-h"><div><h2>Sessions</h2><p>Most recent first</p></div></div><div class="scroll"><table id="sessions"></table></div></div>
    </div>
  </section>

  <!-- Spend -->
  <section data-view="spend" hidden>
    <div class="grid g-2">
      <div class="card">
        <div class="card-h"><div><h2>Daily spend</h2><p id="bars-p">Last 30 days</p></div></div>
        <div class="total"><span class="v num" id="sp-total">$0</span><span class="s" id="sp-meta"></span></div>
        <div class="chart-box"><svg class="bars" id="bars" role="img" aria-label="Spend per day"></svg><div class="tip" id="bars-tip"></div></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Where the tokens went</h2><p>Every billed token, by kind</p></div></div>
        <div id="kinds"></div>
      </div>
    </div>
    <div class="card"><div class="card-h"><div><h2>By model</h2><p id="sp-models-p"></p></div></div><div class="scroll"><table id="sp-models"></table></div></div>
  </section>

  <!-- Settings -->
  <section data-view="settings" hidden>
    <div class="card" style="max-width:860px">
      <div class="set"><div><h3>Mode</h3><p><b>Observe</b> records what your agents read and what Snout would keep out. <b>Enforce</b> trims lockfiles, generated code, noisy command output and large MCP results before they reach the agent. Your own code is always read in full.</p></div>
        <div class="seg-switch" id="modeSwitch2" role="group" aria-label="Mode"><button type="button" data-mode="observe">Observe</button><button type="button" data-mode="enforce">Enforce</button></div></div>
      <div class="set"><div><h3>Prompt tips</h3><p>A short tip, shown only to you, when a task prompt doesn't say which file, what should happen or how to check it.</p></div>
        <div class="seg-switch" id="coachSwitch" role="group" aria-label="Prompt tips"><button type="button" data-coach="off">Off</button><button type="button" data-coach="tip">On</button></div></div>
      <div class="set"><div><h3>Snout Cloud</h3><p id="cloud-p">One dashboard for your team: spend and savings by person, project and model. Only daily totals are sent, never code or file paths.</p></div>
        <button type="button" class="btn dark" id="connect2">Connect team</button></div>
      <div class="set"><div><h3>A file Snout trims that you need</h3><p>Open the Context tab and choose <b>Always read in full</b> next to it, or run <code>snout allow &lt;file&gt;</code>.</p></div><button type="button" class="btn" data-go="context">Open Context</button></div>
      <div class="set"><div><h3>About</h3><p id="about"></p></div></div>
    </div>
  </section>

  <footer>Runs on your machine. This page makes no requests beyond this local server.</footer>
</main>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var KEY = document.body.getAttribute("data-key");
  var state = { data: null, session: "", tab: "overview", seen: null, shown: {}, first: true };
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Brand marks from Simple Icons (CC0), inlined so the page loads nothing from the network.
  // They identify which provider ran a model, nothing more.
  var LOGO_PATHS = {
    "claude":"m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    "openai":"M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    "gemini":"M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
    "cursor":"M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
    "copilot":"M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"};
  var LOGO_FILL = { claude: "#D97757", openai: "currentColor", cursor: "currentColor", copilot: "currentColor", gemini: "url(#snout-gemini)" };
  var CLIENT = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor", copilot: "Copilot" };
  var CLIENT_LOGO = { claude: "claude", codex: "openai", gemini: "gemini", cursor: "cursor", copilot: "copilot" };

  function h(tag, attrs) {
    var el = typeof tag === "string" ? document.createElement(tag) : tag;
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null) continue;
      if (k === "text") el.textContent = attrs[k];
      else if (k === "cls") el.className = attrs[k];
      else if (k === "on") for (var ev in attrs.on) el.addEventListener(ev, attrs.on[ev]);
      else el.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) { h.apply(null, [el, null].concat(c)); continue; }
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  var NS = "http://www.w3.org/2000/svg";
  function s(tag, a) { var e = document.createElementNS(NS, tag); for (var k in a) e.setAttribute(k, a[k]); return e; }

  function fmt(n) {
    n = Math.round(n || 0);
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\\.0$/, "") + "K";
    return (n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace(/\\.?0+$/, "") + "M";
  }
  function usd(n) { n = n || 0; return n > 0 && n < 0.01 ? "<$0.01" : "$" + (n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString()); }
  function ago(ts) {
    var x = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
    if (x < 45) return "just now";
    if (x < 3600) return Math.round(x / 60) + " min ago";
    if (x < 86400) return Math.round(x / 3600) + " h ago";
    return Math.round(x / 86400) + " d ago";
  }
  var pct = function (a, b) { return b ? Math.round((a / b) * 100) : 0; };
  var shortPath = function (p) { var i = p.lastIndexOf("/"); return p.length > 44 && i > 0 ? "\u2026" + p.slice(i) : p; };

  function tween(key, to, el, show) {
    var from = state.shown[key] || 0, t0 = performance.now();
    state.shown[key] = to;
    if (from === to || reduced) { el.textContent = show(to); return; }
    (function step(t) {
      var k = Math.min(1, (t - t0) / 650), e = 1 - Math.pow(1 - k, 3);
      el.textContent = show(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  var toastTimer = 0;
  function toast(text) {
    var t = $("toast"); t.textContent = text; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }
  /** Presses a button on the local server: the same code path as the matching CLI command. */
  function act(body) {
    return fetch("/api/action", { method: "POST", headers: { "content-type": "application/json", "x-snout-key": KEY }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      .then(function (j) { toast(j.message); return j; }, function (e) { toast("Couldn't do that: " + e.message); throw e; });
  }

  // --- models and providers -----------------------------------------------------------

  function providerOf(model) {
    var m = String(model || "").toLowerCase();
    if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return "claude";
    if (/gpt|codex|^o\\d/.test(m)) return "openai";
    if (/gemini/.test(m)) return "gemini";
    return null;
  }
  /** A shade per model inside its provider's family, so two Claude models still read apart. */
  var SHADES = [
    [/fable|mythos/, "#8B6CE0"], [/opus/, "#D97757"], [/sonnet/, "#E0A04C"], [/haiku/, "#C9B27A"],
    [/codex/, "#0E8C6D"], [/gpt|^o\\d/, "#10A37F"], [/gemini.*flash/, "#6FA8FF"], [/gemini/, "#4285F4"],
  ];
  function modelColor(model) {
    var m = String(model || "").toLowerCase();
    for (var i = 0; i < SHADES.length; i++) if (SHADES[i][0].test(m)) return SHADES[i][1];
    return "#8a8a93";
  }
  /** "claude-opus-5-5" \u2192 "Claude Opus 5.5", "gpt-5.5-codex" \u2192 "GPT-5.5 Codex". */
  function modelLabel(model) {
    var m = String(model || "");
    if (!m || m === "unknown") return "Model not recorded";
    var c = /^claude-([a-z]+)-(\\d+)(?:-(\\d{1,2}))?(?!\\d)/.exec(m);
    if (c) return "Claude " + c[1][0].toUpperCase() + c[1].slice(1) + " " + c[2] + (c[3] ? "." + c[3] : "");
    return m.replace(/^gpt/i, "GPT").replace(/^gemini/i, "Gemini").replace(/-(\\w)/g, function (_, x) { return " " + x.toUpperCase(); }).replace(/^GPT (\\d)/, "GPT-$1");
  }
  function logo(kind, small, fallback, live) {
    var box = h("span", { cls: "logo" + (small ? " sm" : "") + (live && kind ? " live" : ""), "data-k": kind || null, "aria-hidden": "true" });
    var d = kind && LOGO_PATHS[kind];
    if (!d) { box.appendChild(h("b", { text: (fallback || "?").slice(0, 1).toUpperCase() })); return box; }
    var svg = s("svg", { viewBox: "0 0 24 24" });
    if (kind === "gemini") {
      var defs = s("defs", {}), g = s("linearGradient", { id: "snout-gemini", x1: "0", y1: "0", x2: "1", y2: "1" });
      [["0", "#4285F4"], ["0.55", "#9B72CB"], ["1", "#D96570"]].forEach(function (st) { g.appendChild(s("stop", { offset: st[0], "stop-color": st[1] })); });
      defs.appendChild(g); svg.appendChild(defs);
    }
    svg.appendChild(s("path", { d: d, fill: LOGO_FILL[kind] }));
    box.appendChild(svg);
    return box;
  }
  var modelLogo = function (model, small, live) { return logo(providerOf(model), small, model, live); };
  var clientLogo = function (client, small, live) { return logo(CLIENT_LOGO[client], small, client, live); };

  /** What a rule means to someone who never saw the classifier. */
  var LABELS = {
    source: "Your code", lockfile: "Lockfiles", generated: "Generated", vendored: "Vendored", minified: "Minified",
    binary: "Binary files", snapshot: "Snapshots", "command-output": "Command output", "mcp-output": "MCP results", "repeat-read": "Repeat reads", "repeat-output": "Repeat results", "long-doc": "Long docs", "long-log": "Long logs",
    "tool-output": "Tool output", "always-allow": "Always read", secret: "Secrets", "size-hint": "Large files",
    "generated-hint": "Generated", "minified-hint": "Minified", "fixture-hint": "Test fixtures", reversal: "Re-read in full",
  };
  var labelOf = function (k) { return LABELS[k] || k.replace(/-/g, " ").replace(/^./, function (c) { return c.toUpperCase(); }); };

  var OUTCOME = { "read": ["Full read", "full"], trimmed: ["Trimmed", "cut"], "held back": ["Kept out", "cut"], asked: ["Asked you", "ask"], "would hold back": ["Would trim", "would"] };
  function outcomeBadge(o) { var x = OUTCOME[o] || [o, ""]; return h("span", { cls: "badge " + x[1], text: x[0] }); }

  // --- the view model: one shape for this machine's data (and, later, the cloud's) ---------

  function view(d) {
    var sp = d.spend;
    var rate = sp && sp.inputRate ? sp.inputRate : 3;
    var today = d.today || { reads: 0, inContext: 0, heldBack: 0, day: "" };
    var spentToday = 0;
    if (sp) sp.series.forEach(function (r) { if (r.day === today.day) spentToday = r.costUsd; });
    var cutToday = 0;
    (d.recent || []).forEach(function (r) { if (r.ts.slice(0, 10) === today.day && r.outcome !== "read") cutToday += 1; });

    var models;
    if (sp && sp.byModel && sp.byModel.length) {
      var costAll = 0, tokAll = 0;
      sp.byModel.forEach(function (m) { costAll += m.costUsd; tokAll += m.tokens; });
      models = sp.byModel.map(function (m) {
        return { key: m.key, label: modelLabel(m.key), client: m.client, color: modelColor(m.key),
          value: m.today && m.today.tokens ? m.today.tokens : m.tokens, today: !!(m.today && m.today.tokens),
          requests: m.today ? m.today.requests : 0, costToday: m.today ? m.today.costUsd : 0, cost7: m.weekCostUsd || 0, cost30: m.costUsd,
          share: costAll ? m.costUsd / costAll : tokAll ? m.tokens / tokAll : 0 };
      });
    } else {
      var all = 0;
      (d.byModel || []).forEach(function (m) { all += m.inContext + m.heldBack; });
      models = (d.byModel || []).filter(function (m) { return m.key !== "unknown"; }).map(function (m) {
        return { key: m.key, label: modelLabel(m.key), client: null, color: modelColor(m.key), value: m.inContext, today: false,
          requests: m.reads, costToday: 0, cost7: 0, cost30: 0, share: all ? (m.inContext + m.heldBack) / all : 0, fromLedger: true };
      });
    }
    var activeClients = {};
    (d.recent || []).forEach(function (r) { if (r.ts.slice(0, 10) === today.day) activeClients[r.client] = 1; });
    return { d: d, sp: sp, rate: rate, today: today, spentToday: spentToday, saved: (today.heldBack * rate) / 1e6, cutToday: cutToday, models: models, agentsToday: Object.keys(activeClients).length };
  }

  // --- Dashboard ------------------------------------------------------------------------

  function renderHead(v) {
    var d = v.d, m = d.meta || {};
    $("proj").textContent = m.project || "";
    $("proj").title = "Project: " + (m.project || "");
    var parts = [
      h("span", null, h("b", { text: String(v.agentsToday) }), v.agentsToday === 1 ? " agent active today" : " agents active today"),
      h("span", null, h("b", { text: fmt(v.today.inContext + v.today.heldBack) }), " tokens read"),
      h("span", null, h("b", { text: "~" + fmt(v.today.heldBack) }), " kept out"),
    ];
    if (v.sp) parts.push(h("span", null, h("b", { text: usd(v.spentToday) }), " spent"));
    $("headline").replaceChildren.apply($("headline"), parts);
    document.title = v.today.heldBack ? "~" + fmt(v.today.heldBack) + " kept out \xB7 Snout" : "Snout Dashboard";

    if (m.controls) {
      $("modeSwitch").hidden = false;
      ["modeSwitch", "modeSwitch2"].forEach(function (id) {
        [].forEach.call($(id).querySelectorAll("button"), function (b) {
          var on = b.getAttribute("data-mode") === (m.mode === "advise" ? "enforce" : m.mode);
          b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
        });
      });
      [].forEach.call($("coachSwitch").querySelectorAll("button"), function (b) {
        var on = b.getAttribute("data-coach") === (m.coach === "off" ? "off" : "tip");
        b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
      });
      var connected = m.cloud && m.cloud.loggedIn;
      ["connect", "connect2"].forEach(function (id) {
        var c = $(id); c.hidden = false;
        c.textContent = connected ? "Team: " + (m.cloud.team || "connected") : "Connect team";
        c.disabled = !!connected; c.className = connected ? "btn done" : "btn dark";
      });
      $("cloud-p").textContent = connected
        ? "Syncing daily totals to " + (m.cloud.team || "your team") + " after each session. Never code or file paths."
        : "One dashboard for your team: spend and savings by person, project and model. Only daily totals are sent, never code or file paths.";
    } else {
      $("coachSwitch").hidden = true; $("modeSwitch2").hidden = true; $("connect2").hidden = true;
    }

    var sel = $("session"), cur = state.session;
    sel.replaceChildren(h("option", { value: "", text: "All sessions" }));
    (d.sessions || []).forEach(function (x) {
      sel.appendChild(h("option", { value: x.key, text: x.clients.map(function (c) { return CLIENT[c] || c; }).join(", ") + " \xB7 " + ago(x.last) + " \xB7 ~" + fmt(x.heldBack) + " kept out" }));
    });
    if (cur && !(d.sessions || []).some(function (x) { return x.key === cur; })) sel.appendChild(h("option", { value: cur, text: "This session" }));
    sel.value = cur;

    var banner = $("banner"); banner.replaceChildren();
    if (m.mode === "observe" && d.couldHoldBack > 0) {
      banner.appendChild(h("div", { cls: "banner" },
        h("span", null, "Snout is only watching. Turned on, it would have kept ", h("b", { text: "~" + fmt(d.couldHoldBack) + " tokens" }), " out of context so far."),
        m.controls ? h("button", { cls: "btn accent", type: "button", text: "Turn on", on: { click: function () { act({ type: "mode", value: "enforce" }); } } }) : h("code", { text: "snout mode enforce" })));
    }
  }

  function renderModels(v) {
    var box = $("models");
    var list = v.models.slice(0, 4);
    box.style.setProperty("--n", Math.max(1, list.length));
    box.replaceChildren();
    if (!list.length) {
      box.style.setProperty("--n", 1);
      box.appendChild(h("div", { cls: "models-empty" }, "Your models show up here after the first Claude Code or Codex session in this project, with tokens and spend from their own usage logs."));
      return;
    }
    var SEGS = 24;
    list.forEach(function (m, idx) {
      var filled = Math.max(m.share > 0 ? 1 : 0, Math.round(m.share * SEGS));
      var meter = h("div", { cls: "meter", style: "--c:" + m.color, title: Math.round(m.share * 100) + "% of " + (m.fromLedger ? "tokens read" : "spend") + (v.sp ? ", last " + v.sp.days + " days" : "") });
      for (var i = 0; i < SEGS; i++) meter.appendChild(h("i"));
      var note = m.fromLedger
        ? h("div", { cls: "m-note" }, h("b", { style: "--c:" + m.color, text: String(m.requests) }), " reads")
        : m.today
          ? h("div", { cls: "m-note" }, h("b", { style: "--c:" + m.color, text: m.requests.toLocaleString() }), " requests today \xB7 " + usd(m.costToday))
          : h("div", { cls: "m-note" }, "last " + (v.sp ? v.sp.days : 30) + " days \xB7 " + usd(m.cost30));
      box.appendChild(h("div", { cls: "model" },
        h("div", { cls: "m-id" }, modelLogo(m.key, false, m.today), h("div", { style: "min-width:0" }, h("div", { cls: "m-name", text: m.label }), h("div", { cls: "m-sub", text: m.client ? CLIENT[m.client] || m.client : "Model" }))),
        h("div", { cls: "m-row" }, h("div", null, h("div", { cls: "m-val num", text: fmt(m.value) }), note), meter)));
      // Segments fill left to right on first paint: the eye lands on relative size before the number.
      var segs = meter.children;
      for (var j = 0; j < filled; j++) {
        (function (el, delay) {
          if (reduced || !state.first) el.classList.add("f");
          else setTimeout(function () { el.classList.add("f"); }, 120 + idx * 90 + delay);
        })(segs[j], j * 14);
      }
    });
  }

  /** The headline: what Snout saved over the days the ledger covers, against what was spent then. */
  function renderBand(v) {
    var box = $("band"); box.replaceChildren();
    var daily = v.d.daily || [], spendBy = {};
    if (v.sp) v.sp.series.forEach(function (r) { spendBy[r.day] = r.costUsd; });
    var held = 0, asked = 0, reads = 0, spent = 0, top = 0;
    daily.forEach(function (r) { held += r.heldBack; asked += r.inContext + r.heldBack; reads += r.reads; spent += spendBy[r.day] || 0; top = Math.max(top, r.heldBack); });
    var saved = (held * v.rate) / 1e6, n = daily.length || 0;
    var observe = v.d.meta && v.d.meta.mode === "observe";
    var spark = h("div", { cls: "spark", "aria-hidden": "true" });
    daily.forEach(function (r, i) { spark.appendChild(h("i", { cls: i === daily.length - 1 ? "now" : "", style: "height:" + (top ? Math.max(4, (r.heldBack / top) * 100) : 4) + "%", title: r.day + ": " + usd((r.heldBack * v.rate) / 1e6) + " saved" })); });
    var savedEl = h("div", { cls: "v num" }), heldEl = h("div", { cls: "v num" });
    box.appendChild(h("div", { cls: "hero" }, h("div", { cls: "k", text: "Saved by Snout, last " + n + " days" }), savedEl,
      h("div", { cls: "s", text: "Kept-out tokens at $" + v.rate.toFixed(2) + "/M input" + (v.sp && v.sp.inputRate ? ", your model mix" : "") }), spark));
    box.appendChild(h("div", null, h("div", { cls: "k", text: "Share of spend" }), h("div", { cls: "v num", text: spent ? pct(saved, spent + saved) + "%" : "\u2014" }),
      h("div", { cls: "s", text: spent ? "less than without Snout, on " + usd(spent) + " spent" : "appears after the first Claude Code or Codex session" })));
    box.appendChild(h("div", null, h("div", { cls: "k", text: "Kept out of context" }), heldEl,
      h("div", { cls: "s", text: asked ? pct(held, asked) + "% of " + fmt(asked) + " tokens agents asked for" : "nothing read yet" })));
    box.appendChild(observe && v.d.couldHoldBack > 0
      ? h("div", null, h("div", { cls: "k", text: "Waiting in observe mode" }), h("div", { cls: "v num", text: "~" + fmt(v.d.couldHoldBack) }), h("div", { cls: "s", text: "tokens enforce mode would also keep out" }))
      : h("div", null, h("div", { cls: "k", text: "Reads trimmed" }), h("div", { cls: "v num", text: (v.d.gated || 0).toLocaleString() }), h("div", { cls: "s", text: "of " + (v.d.reads || reads).toLocaleString() + " reads" })));
    tween("b-saved", saved, savedEl, usd);
    tween("b-held", held, heldEl, function (x) { return "~" + fmt(x); });
  }

  function renderToday(v) {
    tween("t-held", v.today.heldBack, $("t-held"), function (x) { return "~" + fmt(x); });
    $("t-held-s").textContent = "tokens, " + (v.today.inContext + v.today.heldBack ? pct(v.today.heldBack, v.today.inContext + v.today.heldBack) + "% of what agents asked for" : "nothing read yet today");
    tween("t-saved", v.saved, $("t-saved"), usd);
    $("t-saved-s").textContent = "at $" + v.rate.toFixed(2) + " per million input tokens" + (v.sp && v.sp.inputRate ? ", your model mix" : "");
    $("t-cut").textContent = String(v.cutToday);
    $("t-cut-s").textContent = "of " + v.today.reads + " read" + (v.today.reads === 1 ? "" : "s") + " today";
  }

  function feedRow(r, fresh) {
    return h("div", { cls: "frow" + (fresh ? " fresh" : ""), title: (CLIENT[r.client] || r.client) + (r.agent !== "main" ? " \xB7 " + r.agent : "") + " \xB7 " + labelOf(r.rule) + (r.reason && r.outcome !== "read" ? "\\n" + r.reason : "") },
      h("span", { cls: "when", "data-ts": r.ts, text: ago(r.ts) }),
      h("span", { cls: "what" }, clientLogo(r.client, true), h("span", { cls: "path", text: shortPath(r.path) })),
      outcomeBadge(r.outcome));
  }
  function renderFeed(v) {
    var rows = v.d.recent || [];
    var box = $("feed"); box.replaceChildren();
    var firstPaint = state.seen === null;
    if (firstPaint) state.seen = new Set();
    var fresh = {};
    rows.forEach(function (r) { var id = r.ts + r.path + r.tool; if (!state.seen.has(id)) { if (!firstPaint) fresh[id] = 1; state.seen.add(id); } });
    if (!rows.length) { box.appendChild(h("div", { cls: "none", text: "Waiting for the first read. Start your coding agent in this project." })); return; }
    rows.slice(0, 7).forEach(function (r) { box.appendChild(feedRow(r, fresh[r.ts + r.path + r.tool])); });
  }

  function lastDays(n, byDay, empty) {
    var out = [], now = Date.now();
    for (var i = n - 1; i >= 0; i--) { var k = new Date(now - i * 86400000).toISOString().slice(0, 10); out.push(byDay[k] || empty(k)); }
    return out;
  }
  var dayName = function (k) { return new Date(k + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric" }); };
  function niceMax(x) { if (x <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(x))); var f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

  function renderTrend(v) {
    var svg = $("trend"), box = $("trend-box"), tip = $("trend-tip");
    var byDay = {}; (v.d.daily || []).forEach(function (r) { byDay[r.day] = r; });
    var pts = lastDays(7, byDay, function (k) { return { day: k, inContext: 0, heldBack: 0, reads: 0 }; });
    var W = Math.max(280, svg.clientWidth || 520), H = 250, L = 40, R = 8, T = 10, B = 26;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.replaceChildren();
    var top = 0; pts.forEach(function (p) { top = Math.max(top, p.inContext, p.heldBack); });
    top = niceMax(top);
    var x = function (i) { return L + (i / (pts.length - 1)) * (W - L - R); };
    var y = function (val) { return T + (1 - val / top) * (H - T - B); };
    var defs = s("defs", {}), grad = s("linearGradient", { id: "g-held", x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(s("stop", { offset: "0", "stop-color": "var(--accent)", "stop-opacity": "0.18" }));
    grad.appendChild(s("stop", { offset: "1", "stop-color": "var(--accent)", "stop-opacity": "0" }));
    defs.appendChild(grad); svg.appendChild(defs);
    [0, 0.5, 1].forEach(function (f) {
      var t = s("text", { x: L - 8, y: y(top * f) + 4, "text-anchor": "end" }); t.textContent = f ? fmt(top * f) : "0"; svg.appendChild(t);
    });
    pts.forEach(function (p, i) {
      svg.appendChild(s("line", { x1: x(i), x2: x(i), y1: T, y2: H - B, stroke: "var(--line)", "stroke-dasharray": "3 4" }));
      var t = s("text", { x: x(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle" }); t.textContent = dayName(p.day); svg.appendChild(t);
    });
    svg.appendChild(s("line", { x1: L, x2: W - R, y1: y(0), y2: y(0), stroke: "var(--line)" }));
    function line(key) { return pts.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + "," + y(p[key]).toFixed(1); }).join(""); }
    svg.appendChild(s("path", { d: line("heldBack") + "L" + x(pts.length - 1) + "," + y(0) + "L" + x(0) + "," + y(0) + "Z", fill: "url(#g-held)" }));
    var held = s("path", { d: line("heldBack"), fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round" });
    var ctx = s("path", { d: line("inContext"), fill: "none", stroke: "var(--ink)", "stroke-width": 1.75, "stroke-linejoin": "round" });
    svg.appendChild(ctx); svg.appendChild(held);
    if (state.first && !reduced) [ctx, held].forEach(function (p) {
      var len = p.getTotalLength(); p.style.strokeDasharray = len; p.style.strokeDashoffset = len;
      p.getBoundingClientRect(); p.style.transition = "stroke-dashoffset 0.9s cubic-bezier(0.2,0.7,0.2,1)"; p.style.strokeDashoffset = 0;
    });
    var guide = s("line", { y1: T, y2: H - B, stroke: "var(--faint)", opacity: 0 }), dotA = s("circle", { r: 3.5, fill: "var(--ink)", opacity: 0 }), dotB = s("circle", { r: 3.5, fill: "var(--accent)", opacity: 0 });
    svg.appendChild(guide); svg.appendChild(dotA); svg.appendChild(dotB);
    svg.onmousemove = function (e) {
      var rect = svg.getBoundingClientRect(), mx = ((e.clientX - rect.left) / rect.width) * W;
      var i = Math.max(0, Math.min(pts.length - 1, Math.round(((mx - L) / (W - L - R)) * (pts.length - 1)))), p = pts[i];
      [guide, dotA, dotB].forEach(function (el) { el.setAttribute("opacity", 1); });
      guide.setAttribute("x1", x(i)); guide.setAttribute("x2", x(i));
      dotA.setAttribute("cx", x(i)); dotA.setAttribute("cy", y(p.inContext)); dotB.setAttribute("cx", x(i)); dotB.setAttribute("cy", y(p.heldBack));
      tip.replaceChildren(h("b", { text: dayName(p.day) }), h("br"), fmt(p.inContext) + " into context", h("br"), "~" + fmt(p.heldBack) + " kept out \xB7 " + p.reads + " reads");
      tip.style.left = (x(i) / W) * rect.width + "px"; tip.style.top = (y(Math.max(p.inContext, p.heldBack)) / H) * rect.height - 8 + "px"; tip.style.opacity = 1;
    };
    svg.onmouseleave = function () { tip.style.opacity = 0; [guide, dotA, dotB].forEach(function (el) { el.setAttribute("opacity", 0); }); };
    box.title = "";
  }

  function renderCost(v) {
    var box = $("cost"); box.replaceChildren();
    var sp = v.sp;
    if (!sp) {
      $("cost-p").textContent = "API-equivalent, from your agents' own usage logs";
      box.appendChild(h("div", { cls: "none", text: "No Claude Code or Codex usage found for this project yet. Spend appears here after the first session." }));
      return;
    }
    var byDay = {}; sp.series.forEach(function (r) { byDay[r.day] = r; });
    var days = lastDays(14, byDay, function (k) { return { day: k, costUsd: 0 }; });
    var thisWeek = 0, lastWeek = 0;
    days.forEach(function (r, i) { if (i >= 7) thisWeek += r.costUsd; else lastWeek += r.costUsd; });
    var change = lastWeek ? ((thisWeek - lastWeek) / lastWeek) * 100 : null;
    $("cost-p").textContent = "API-equivalent at list prices of " + sp.pricesAsOf + ", from your agents' own usage logs";
    box.appendChild(h("div", { cls: "total" },
      h("span", { cls: "v num", text: usd(sp.costUsd) }),
      change === null ? null : h("span", { cls: "d " + (change > 0 ? "up" : "down"), text: (change > 0 ? "+" : "\u2212") + Math.abs(change).toFixed(1) + "%" }),
      h("span", { cls: "s", text: change === null ? "last " + sp.days + " days" : "last 7 days vs the 7 before \xB7 " + sp.days + "-day total" })));
    var t = h("table");
    t.appendChild(h("tr", null, h("th", { text: "Model" }), h("th", { cls: "n", text: "Today" }), h("th", { cls: "n hide-sm", text: "7 days" }), h("th", { cls: "n", text: sp.days + " days" }), h("th", { cls: "n", text: "Share" })));
    v.models.slice(0, 6).forEach(function (m) {
      t.appendChild(h("tr", null,
        h("td", null, h("span", { cls: "who", style: "--c:" + m.color }, modelLogo(m.key, true), h("i", { cls: "dot" }), h("span", { text: m.label }))),
        h("td", { cls: "n", text: usd(m.costToday) }), h("td", { cls: "n hide-sm", text: usd(m.cost7) }), h("td", { cls: "n", text: usd(m.cost30) }),
        h("td", { cls: "n strong", text: (m.share * 100).toFixed(1) + "%" })));
    });
    box.appendChild(t);
  }

  // Each label belongs to the Snout feature that trims it (same grouping as Snout Cloud).
  var FEATURES = [
    { key: "source", name: "Your code", how: "always read in full", labels: /^(source|always-allow|secret|reversal|unclassified)$/ },
    { key: "squeeze", name: "Command output", how: "Squeeze: problems and summary kept", labels: /^(command-output|tool-output)$/ },
    { key: "sections", name: "Long docs & logs", how: "Section reads: head and a map", labels: /^long-/ },
    { key: "repeat", name: "Repeats", how: "Repeat skip: pointer to the copy", labels: /^repeat-/ },
    { key: "mcp", name: "MCP results", how: "MCP trimming, per server", labels: /^mcp/ },
    { key: "bulk", name: "Bulk files", how: "Read gate: head and outline", labels: /./ },
  ];
  function featureOf(label) { for (var i = 0; i < FEATURES.length; i++) if (FEATURES[i].labels.test(label)) return FEATURES[i]; return FEATURES[FEATURES.length - 1]; }

  function renderMix(v) {
    var box = $("mix"); box.replaceChildren();
    var groups = {};
    (v.d.byLabel || []).forEach(function (l) {
      var f = featureOf(l.key), g = groups[f.key] || (groups[f.key] = { key: f.key, name: f.name, how: f.how, inContext: 0, heldBack: 0, reads: 0 });
      g.inContext += l.inContext; g.heldBack += l.heldBack; g.reads += l.reads;
    });
    var cols = FEATURES.map(function (f) { return groups[f.key]; }).filter(function (g) { return g && g.inContext + g.heldBack > 0; });
    var all = 0; cols.forEach(function (c) { all += c.inContext + c.heldBack; });
    if (!all) { box.appendChild(h("div", { cls: "none", text: "Fills in as your agents read files." })); return; }
    var maxShare = 0; cols.forEach(function (c) { maxShare = Math.max(maxShare, (c.inContext + c.heldBack) / all); });
    var grid = h("div", { cls: "mix", style: "--n:" + cols.length });
    var BAR = 150;
    cols.forEach(function (c) {
      var tot = c.inContext + c.heldBack, share = tot / all;
      var hgt = Math.max(3, (share / maxShare) * BAR);
      var outH = tot ? (c.heldBack / tot) * hgt : 0;
      var cut = c.heldBack > 0;
      grid.appendChild(h("div", { cls: "mcol", title: c.name + " (" + c.how + "): " + c.reads + " reads, " + fmt(c.inContext) + " into context, ~" + fmt(c.heldBack) + " kept out" },
        h("div", { cls: "top" },
          h("div", { cls: "k", text: c.name }),
          h("div", { cls: "v num", text: fmt(tot) }),
          h("div", { cls: "s" + (cut ? " cut" : ""), text: cut ? "\u2212" + pct(c.heldBack, tot) + "% kept out" : c.key === "source" ? "always read in full" : "read in full" })),
        h("div", { cls: "bar" },
          h("div", { cls: "pct", text: Math.round(share * 100) + "%" }),
          h("div", { cls: "stack", style: "height:" + hgt + "px" }, h("i", { cls: "in", style: "height:" + (hgt - outH) + "px" }), h("i", { cls: "out", style: "height:" + outH + "px" })))));
    });
    box.appendChild(grid);
    box.appendChild(h("div", { cls: "mix-foot" },
      h("div", { cls: "legend" }, h("span", { style: "--c: var(--bar-in)" }, h("i"), "Into context"), h("span", { style: "--c: var(--accent)" }, h("i"), "Kept out by Snout")),
      h("span", { cls: "legend", text: "p50 " + v.d.latency.p50 + " ms per decision" })));
  }

  // --- Context tab ------------------------------------------------------------------------

  function tableOf(el, head, rows, empty) {
    el.replaceChildren();
    if (!rows.length) { el.appendChild(h("tr", null, h("td", { cls: "none", text: empty, style: "border:0" }))); return; }
    var tr = h("tr"); head.forEach(function (c) { tr.appendChild(h("th", { cls: c[1] || "", text: c[0] })); }); el.appendChild(tr);
    rows.forEach(function (r) { el.appendChild(r); });
  }
  function renderContext(v) {
    var d = v.d, controls = d.meta && d.meta.controls;
    $("feed-all-p").textContent = "Newest first \xB7 p50 " + d.latency.p50 + " ms, p95 " + d.latency.p95 + " ms per decision";
    tableOf($("feed-all"), [["When"], ["File or tool"], ["Result"], ["Tokens", "n"]], (d.recent || []).map(function (r) {
      return h("tr", null,
        h("td", { cls: "when", style: "white-space:nowrap;color:var(--muted)", "data-ts": r.ts, text: ago(r.ts) }),
        h("td", { cls: "path" }, h("span", { cls: "who" }, clientLogo(r.client, true), h("span", { text: r.path })), h("div", { cls: "reason", text: labelOf(r.rule) + (r.outcome !== "read" && r.reason ? " \xB7 " + r.reason : "") })),
        h("td", null, outcomeBadge(r.outcome)),
        h("td", { cls: "n", text: r.heldBack ? "\u2212" + fmt(r.heldBack) : fmt(r.inContext) }));
    }), "No reads yet.");
    tableOf($("files"), [["File"], ["Kept out", "n"], ["In context", "n"], [""]], (d.files || []).map(function (f) {
      var btn = f.heldBack > 0 && controls ? h("button", { cls: "btn", type: "button", text: "Always read in full", on: { click: function () { act({ type: "allow", path: f.key }); } } }) : null;
      return h("tr", null,
        h("td", { cls: "path" }, f.key, h("div", { cls: "reason", text: labelOf(f.label) + " \xB7 " + f.reads + (f.reads === 1 ? " read" : " reads") + " \xB7 last " + ago(f.last) })),
        h("td", { cls: "n", style: f.heldBack ? "color:var(--accent-ink);font-weight:600" : "", text: f.heldBack ? "~" + fmt(f.heldBack) : "\u2014" }),
        h("td", { cls: "n", text: fmt(f.inContext) }),
        h("td", { cls: "n" }, btn));
    }), "No files yet.");
    tableOf($("clients"), [["Agent"], ["Reads", "n"], ["In context", "n"], ["Kept out", "n"]], (d.byClient || []).map(function (c) {
      return h("tr", null, h("td", null, h("span", { cls: "who" }, clientLogo(c.key, true), h("span", { text: CLIENT[c.key] || c.key }))),
        h("td", { cls: "n", text: c.reads.toLocaleString() }), h("td", { cls: "n", text: fmt(c.inContext) }), h("td", { cls: "n", text: "~" + fmt(c.heldBack) }));
    }), "No agents yet.");
    tableOf($("sessions"), [["Last active"], ["Agents"], ["Reads", "n"], ["Kept out", "n"]], (d.sessions || []).map(function (x) {
      var agents = h("span", { cls: "who" }); x.clients.forEach(function (c) { agents.appendChild(clientLogo(c, true)); }); agents.appendChild(h("span", { text: x.clients.map(function (c) { return CLIENT[c] || c; }).join(", ") }));
      return h("tr", null, h("td", { style: "white-space:nowrap", "data-ts": x.last, text: ago(x.last) }), h("td", null, agents),
        h("td", { cls: "n", text: x.reads.toLocaleString() }), h("td", { cls: "n", text: "~" + fmt(x.heldBack) }));
    }), "No sessions yet.");
  }

  // --- Repo map: folders as entities, and the landing page's report for the one you point at ---------

  var shortName = function (p) { var i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; };
  var groupName = function (k) { return k === "/" ? "(root)" : k + "/"; };
  var inGroup = function (g, p) { return g.key === "/" ? p : p.slice(g.key.length + 1); };
  var hlt = function (t) { return h("span", { cls: "hlt", text: t }); };
  // Labels Snout reads whole or asks about first: never bulk (the same set as the server's).
  var WHOLE = { source: 1, "always-allow": 1, secret: 1, reversal: 1 };
  var bulk = function (label) { return !WHOLE[label]; };
  function icon(d) {
    var svg = s("svg", { class: "ic", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    svg.appendChild(s("path", { d: d }));
    return svg;
  }
  var IC_REPO = "M3 3v18h18M7 16h2M7 12h6M7 8h10", IC_LOCK = "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z", IC_EYE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z";
  function check(on, text) { return h("span", { cls: "check" + (on ? "" : " off") }, h("i"), text); }
  function fileBadge(f) {
    if (f.heldBack > 0) return h("em", { cls: "fb cut", text: "\u2212" + pct(f.heldBack, f.heldBack + f.inContext) + "%" });
    if (f.reads > 0) return h("em", { cls: "fb full", text: "in full" });
    if (bulk(f.label)) return h("em", { cls: "fb would", text: "would trim" });
    return h("em", { cls: "fb none", text: "not read" });
  }
  function repoStat(k, v, s2, pink) { return h("div", null, h("div", { cls: "k", text: k }), h("div", { cls: "v num" + (pink ? " pink" : ""), text: v }), h("div", { cls: "s", text: s2 })); }

  /** Tokens one read costs with Snout and without: measured from the ledger, or projected for a file nobody read yet. */
  function perRead(f) {
    if (f.reads) return { w: f.inContext / f.reads, wo: (f.inContext + f.heldBack) / f.reads, proj: false };
    return { w: f.sendTokens, wo: f.tokens, proj: bulk(f.label) };
  }
  /** The chart's rows: what Snout kept out, then what it would trim, then source read whole, as on the landing page. */
  function reportRows(g) {
    var by = function (k) { return function (a, b) { return k(b) - k(a); }; };
    var cut = g.top.filter(function (f) { return f.reads && f.heldBack > 0; }).sort(by(function (f) { return f.heldBack; }));
    var would = g.top.filter(function (f) { return !f.reads && bulk(f.label); }).sort(by(function (f) { return f.tokens - f.sendTokens; }));
    var whole = g.top.filter(function (f) { return !bulk(f.label) || (f.reads && !f.heldBack); }).sort(by(function (f) { return f.tokens; }));
    var rows = cut.concat(would).slice(0, 5);
    return rows.concat(whole.slice(0, Math.max(1, 6 - rows.length))).slice(0, 6);
  }
  function fileReport(path, done) {
    state.reports = state.reports || {};
    if (state.reports[path]) return done(state.reports[path]);
    fetch("/api/file?path=" + encodeURIComponent(path)).then(function (r) { return r.ok ? r.json() : null; }).then(function (rep) { if (rep) state.reports[path] = rep; done(rep); }, function () { done(null); });
  }

  /** The landing page's session panel for one folder. \`o.sheet\` is the pop-up page's larger version. */
  function reportPanel(r, g, o) {
    var d = state.data, mode = (d.meta && d.meta.mode) || "observe";
    var rows = reportRows(g), sel = o.file && rows.some(function (f) { return f.path === o.file; }) ? o.file : rows[0] && rows[0].path;
    var pick = h("select", { "aria-label": "Folder" });
    r.groups.forEach(function (x) { pick.appendChild(h("option", { value: x.key, text: groupName(x.key) })); });
    pick.value = g.key;
    pick.addEventListener("change", function () { o.onGroup(this.value); });
    var live = g.top.some(function (f) { return f.last && Date.now() - Date.parse(f.last) < 10 * 60 * 1000; });
    var bar = h("div", { cls: "rp-bar" }, icon(IC_REPO), pick, live ? h("i", { cls: "live-dot", title: "An agent read from this folder in the last few minutes" }) : null,
      h("span", { cls: "mode", title: "Snout's mode in this project" }, icon(mode === "observe" ? IC_EYE : IC_LOCK), mode.charAt(0).toUpperCase() + mode.slice(1)));
    var srcCut = g.top.some(function (f) { return f.label === "source" && f.heldBack > 0; });
    var name = groupName(g.key), statement = h("p", { cls: "statement" });
    if (g.heldBack) statement.append(h("span", { cls: "dotted", text: "~" + fmt(g.heldBack) + " tokens" }), " stayed out of context from " + name + ". ", srcCut ? "Some source was trimmed too." : "Every source file agents needed was read in full.");
    else if (g.reads) statement.append("Agents read ", h("span", { cls: "dotted", text: fmt(g.inContext) + " tokens" }), " from " + name + ", all of it in full." + (g.bulk ? " ~" + fmt(g.bulk) + " of the folder is bulk Snout would trim." : ""));
    else if (g.bulk) statement.append("No agent has read " + name + " yet. ", h("span", { cls: "dotted", text: "~" + fmt(g.bulk) + " tokens" }), " of its ~" + fmt(g.tokens) + " is bulk Snout would trim to a short head.");
    else statement.append("No agent has read " + name + " yet. It is all source: ~" + fmt(g.tokens) + " tokens, read in full when they do.");

    var max = 0; rows.forEach(function (f) { max = Math.max(max, perRead(f).wo); });
    var grid = h("div", { cls: "rp-rows" }), anyProj = false;
    rows.forEach(function (f) {
      var v = perRead(f), cut = v.wo ? ((v.w - v.wo) / v.wo) * 100 : 0, on = f.path === sel;
      if (v.proj) anyProj = true;
      var go = function () { o.onFile(f.path); };
      grid.append(
        h("div", { cls: "nm" + (on ? " sel" : "") + (f.path === state.flashPath ? " flash" : ""), "data-path": f.path, title: f.path, on: { click: go } }, h("span", { text: inGroup(g, f.path) }),
          h("small", { text: (f.reads ? f.reads + (f.reads === 1 ? " read" : " reads") : "not read yet") + (f.label !== "source" ? " \xB7 " + f.label : "") })),
        h("div", { cls: "bb", on: { click: go } }, h("i", { cls: "w" + (v.proj ? " proj" : ""), style: "width:" + (max ? Math.max(0.6, (v.w / max) * 100) : 0) + "%" }), h("i", { cls: "wo", style: "width:" + (max ? (v.wo / max) * 100 : 0) + "%" })),
        h("div", { cls: "val" + (on ? " sel" : "") }, h("span", { text: (v.proj ? "~" : "") + Math.round(v.w).toLocaleString() })),
        h("div", { cls: "pc", text: (cut > -0.05 ? "+" : "\u2212") + Math.abs(cut).toFixed(1) + "%" }));
    });
    var labels = []; rows.forEach(function (f) { if (bulk(f.label) && labels.indexOf(f.label) < 0) labels.push(f.label); });
    var explain = h("div", { cls: "rp-explain", hidden: "" });
    var showExplain = function () {
      if (!explain.hidden) { explain.hidden = true; return; }
      explain.hidden = false; explain.textContent = "Reading the file\u2026";
      fileReport(sel, function (rep) {
        if (!rep) { explain.textContent = "This file is no longer in the project."; return; }
        explain.replaceChildren(h("b", { text: rep.path }), " \xB7 " + (rep.label === "source" ? "no rule flags it, so it is read in full" : rep.label + " \xB7 confidence " + rep.confidence.toFixed(2) + " \xB7 band " + rep.band) + ". ", rep.reason || "");
      });
    };
    var controls = d.meta && d.meta.controls, selFile = rows.filter(function (f) { return f.path === sel; })[0];
    var foot = h("div", { cls: "rp-foot" }, h("span", { cls: "k", text: "Classified as" }),
      labels.length ? labels.slice(0, 3).map(function (l) { return h("span", { cls: "chip", text: l }); }) : h("span", { cls: "chip", text: "source" }), h("span", { cls: "sp" }),
      h("span", { cls: "acts" }, h("button", { cls: "btn", type: "button", text: "Explain", on: { click: showExplain } }),
      o.sheet ? h("button", { cls: "btn outline", type: "button", text: "View report", on: { click: function () { closeSheet(); showTab("context"); window.scrollTo(0, 0); } } }) : null,
      o.sheet && controls && selFile && bulk(selFile.label) ? h("button", { cls: "btn", type: "button", text: "Allow file", title: "Always read " + sel + " in full", on: { click: function () { act({ type: "allow", path: sel }); } } }) : null,
      h("button", { cls: "btn dark", type: "button", text: "Open report", on: { click: o.sheet ? function () { closeSheet(); showTab("context"); window.scrollTo(0, 0); } : function () { openSheet(g.key, sel); } } })));
    var body = h("div", { cls: "rp-body" }, h("h3", { text: "What reaches your agent from " + name }),
      h("div", { cls: "checks" }, check(d.reads > 0, "Classifying each read"), check(g.heldBack > 0 || mode === "enforce", "Trimming bulk files"), check(!srcCut, "Reading source in full"), check(d.reads > 0, "Recording the savings")),
      statement, h("hr"),
      h("div", { cls: "rp-ch" }, "Tokens per read, with Snout vs. without", anyProj ? h("small", { text: "striped: projected, not read yet" }) : null,
        h("div", { cls: "legend" }, h("span", { style: "--c: var(--ink)" }, h("i"), "With Snout"), h("span", { style: "--c: var(--without)" }, h("i"), "Without"))),
      rows.length ? grid : h("div", { cls: "rp-empty", text: "No files to show." }), foot, explain);
    return h("div", { cls: "rp" }, bar, body);
  }

  function renderRepo(v) {
    var box = $("repo"), r = v.d.repo;
    if (!r || !r.groups.length) { box.replaceChildren(); return; }
    if (!r.groups.some(function (g) { return g.key === state.repoSel; })) state.repoSel = r.groups[0].key;
    // A read newer than the last render flashes its row in the report.
    var newest = (v.d.recent || [])[0];
    state.flashPath = newest && state.repoNewest && newest.ts > state.repoNewest ? newest.path : null;
    if (newest) state.repoNewest = newest.ts;
    var info = h("div", { cls: "flow-info" });
    var intro = function () { info.replaceChildren("Each card is a folder and its heaviest files. Point at one to see its report the way the landing page shows it; click to open the full page. ", r.links.length ? "Lines on the left join folders that share names." : ""); };
    intro();
    var card = h("div", { cls: "card flow-card" }, h("div", { cls: "flow-top" },
      h("div", null, h("div", { cls: "eyebrow", text: "Repo map \xB7 live" }), h("h2", { text: "Your whole codebase, as your agents see it." })), info));
    card.appendChild(h("div", { cls: "repo-stats" },
      repoStat("Files", r.files.toLocaleString(), "in " + (r.groups.length + r.more) + " folders"),
      repoStat("To read all of it", "~" + fmt(r.tokens), "tokens"),
      repoStat("Bulk Snout trims", "~" + fmt(r.bulk), pct(r.bulk, r.tokens) + "% of the repo: lockfiles, generated, logs\u2026", true),
      repoStat("Kept out so far", "~" + fmt(v.d.heldBack), v.d.reads.toLocaleString() + " reads classified", true)));
    var ents = h("div", { cls: "ents erd-gutter" }), entEls = {}, slot = h("div");
    var showPanel = function () {
      var g = r.groups.filter(function (x) { return x.key === state.repoSel; })[0];
      slot.replaceChildren(reportPanel(r, g, { file: state.repoFile, onFile: function (p) { openSheet(g.key, p); }, onGroup: function (k) { state.repoSel = k; state.repoFile = null; mark(); showPanel(); } }));
    };
    var mark = function () { Object.keys(entEls).forEach(function (k) { entEls[k].classList.toggle("sel", k === state.repoSel); }); };
    r.groups.forEach(function (g, i) {
      var e = h("div", { cls: "ent" + (state.first ? " pop" : ""), style: "--d:" + (i * 0.05).toFixed(2) + "s", tabindex: "0", role: "button", "aria-label": "Open the report for " + groupName(g.key),
        on: { mouseenter: function () { if (state.repoSel !== g.key) { state.repoSel = g.key; state.repoFile = null; mark(); showPanel(); } }, click: function () { openSheet(g.key, state.repoFile); },
          focus: function () { state.repoSel = g.key; mark(); showPanel(); }, keydown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openSheet(g.key, null); } } } });
      e.appendChild(h("div", { cls: "ent-h", title: g.files + " files \xB7 ~" + fmt(g.tokens) + " tokens to read them all" },
        h("i"), h("b", { text: groupName(g.key) }), h("span", { cls: "mono", text: g.files + (g.files === 1 ? " file" : " files") }), h("span", { cls: "open", text: "OPEN \u2197" }), h("span", { cls: "mono r", text: fmt(g.tokens) + " tok" })));
      g.top.slice(0, 4).forEach(function (f) {
        e.appendChild(h("div", { cls: "ent-r", title: f.path + " \xB7 " + labelOf(f.label) + " \xB7 ~" + fmt(f.tokens) + " tokens" + (f.reads ? " \xB7 " + f.reads + (f.reads === 1 ? " read" : " reads") : ""),
          on: { mouseenter: function () { state.repoSel = g.key; state.repoFile = f.path; mark(); showPanel(); }, click: function (ev) { ev.stopPropagation(); openSheet(g.key, f.path); } } },
          h("span", { cls: "src" }, shortName(f.path), f.label !== "source" ? h("span", { cls: "lab", text: f.label }) : null),
          h("span", { cls: "v" }, fmt(f.tokens), fileBadge(f))));
      });
      entEls[g.key] = e;
      ents.appendChild(e);
    });
    if (r.more) ents.appendChild(h("div", { cls: "note", style: "margin:0", text: "+" + r.more + " smaller folders" }));
    card.appendChild(h("div", { cls: "rmap" }, ents, slot));
    mark(); showPanel();
    box.replaceChildren(card);
    requestAnimationFrame(function () { drawLinks(ents, entEls, r, info, intro); });
    if (state.sheet) renderSheet();
  }

  /** Relationship lines between folders, in the gutter left of the cards: an ERD's joins. */
  function drawLinks(ents, entEls, r, info, intro) {
    if (window.innerWidth <= 800 || !r.links.length) return;
    var er = ents.getBoundingClientRect(), gut = 56, order = r.groups.map(function (g) { return g.key; });
    var links = r.links.filter(function (l) { return entEls[l.a] && entEls[l.b]; }).slice(0, 7)
      .sort(function (a, b) { return Math.abs(order.indexOf(a.a) - order.indexOf(a.b)) - Math.abs(order.indexOf(b.a) - order.indexOf(b.b)); });
    var esvg = s("svg", { class: "erd", width: gut, height: er.height, viewBox: "0 0 " + gut + " " + er.height });
    var maxN = 1; links.forEach(function (l) { maxN = Math.max(maxN, l.names); });
    links.forEach(function (l, i) {
      var A = entEls[l.a].getBoundingClientRect(), B = entEls[l.b].getBoundingClientRect();
      var ya = A.top - er.top + 17, yb = B.top - er.top + 17, x0 = gut - 1, depth = Math.min(gut - 8, 12 + i * 6), ym = (ya + yb) / 2;
      var d = "M" + x0 + "," + ya.toFixed(1) + " C" + (x0 - depth) + "," + ya.toFixed(1) + " " + (x0 - depth) + "," + yb.toFixed(1) + " " + x0 + "," + yb.toFixed(1);
      var g = s("g", { class: "lk" });
      g.appendChild(s("path", { d: d, "stroke-width": (1 + 3 * Math.sqrt(l.names / maxN)).toFixed(2) }));
      g.appendChild(s("path", { class: "hit", d: d }));
      var ax = x0 - depth * 0.75;
      g.appendChild(s("circle", { cx: ax.toFixed(1), cy: ym.toFixed(1), r: 9 }));
      var tx = s("text", { x: ax.toFixed(1), y: (ym + 3).toFixed(1), "text-anchor": "middle" }); tx.textContent = l.names > 99 ? "99+" : String(l.names); g.appendChild(tx);
      g.addEventListener("mouseenter", function () {
        ents.classList.add("has-on"); g.classList.add("on"); entEls[l.a].classList.add("on"); entEls[l.b].classList.add("on");
        info.replaceChildren(h("b", { text: groupName(l.a) }), " and ", h("b", { text: groupName(l.b) }), " share " + l.names + " names, one declaring what the other uses, such as ", h("code", { text: l.sample.join(", ") }), ".");
      });
      g.addEventListener("mouseleave", function () { ents.classList.remove("has-on"); g.classList.remove("on"); entEls[l.a].classList.remove("on"); entEls[l.b].classList.remove("on"); intro(); });
      esvg.appendChild(g);
    });
    ents.style.position = "relative";
    ents.appendChild(esvg);
  }

  // --- The pop-up report page --------------------------------------------------------------------

  function openSheet(key, file) {
    state.sheet = { key: key, file: file || null, full: false };
    state.sheetFocus = document.activeElement;
    renderSheet();
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    var el = $("sheet");
    if (el) el.remove();
    state.sheet = null;
    document.body.style.overflow = "";
    if (state.sheetFocus && state.sheetFocus.focus) state.sheetFocus.focus();
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.sheet) closeSheet(); });

  function stairs(side, widths, pink) {
    return h("div", { cls: "stairs " + side, "aria-hidden": "true" }, widths.map(function (w, i) { return h("i", { cls: i === pink ? "p" : "", style: "width:" + w + "px" }); }));
  }
  function gbar(title, meta, lede, rows, pinkIdx) {
    var max = 0; rows.forEach(function (x) { max = Math.max(max, x[1]); });
    return h("div", { cls: "gbar" }, h("div", { cls: "gbar-h" }, h("b", { text: title }), h("span", { text: meta })), h("p", null, lede),
      h("div", { cls: "gb-rows" }, rows.map(function (x, i) {
        return [h("span", { text: x[0] }), h("div", { cls: "track" }, h("i", { cls: i === pinkIdx ? "pink" : "", style: "width:" + (max ? Math.max(1, (x[1] / max) * 100) : 0) + "%;--d:" + (0.1 + i * 0.08).toFixed(2) + "s" })), h("span", { cls: "t", text: x[2] })];
      })));
  }

  function renderSheet() {
    var d = state.data, r = d && d.repo;
    if (!state.sheet || !r || !r.groups.length) return;
    var g = r.groups.filter(function (x) { return x.key === state.sheet.key; })[0] || r.groups[0];
    var rows = reportRows(g), file = state.sheet.file && rows.some(function (f) { return f.path === state.sheet.file; }) ? state.sheet.file : rows[0] && rows[0].path;
    var f = rows.filter(function (x) { return x.path === file; })[0];
    var el = $("sheet"), fresh = !el;
    if (fresh) { el = h("div", { cls: "sheet", id: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Report for " + groupName(g.key) }); document.body.appendChild(el); }
    var keep = el.scrollTop;
    var name = groupName(g.key), asked = g.inContext + g.heldBack, labels = [];
    // What Snout kept out (measured), or else what it would trim.
    g.kinds.forEach(function (k) { if (bulk(k.label) && (k.heldBack > 0 || !g.heldBack) && labels.length < 3) labels.push(labelOf(k.label).toLowerCase()); });
    var headline = g.heldBack && asked ? "In " + name + ", " + pct(g.heldBack, asked) + "% less to read. Same code."
      : g.bulk ? "In " + name + ", " + pct(g.bulk, g.tokens) + "% is bulk your agent never needs."
      : "In " + name + ", all source. Read in full.";
    var lede = g.heldBack ? "Snout kept " + (labels.join(", ") || "bulk") + " out of the agent's context. Every source file it needed went in, in full."
      : labels.length ? "When an agent opens it, Snout sends " + labels.join(", ") + " as a short head and an outline, and your own code in full."
      : "Nothing here for Snout to trim: your agents get every file whole.";

    // The callout: Snout's real report for the selected file, filled in once the server has read it.
    var call = h("div", { cls: "callout" }, h("div", { cls: "sk loading" }));
    var fill = function (rep) {
      if (!rep || !f) { call.replaceChildren(h("div", { cls: "none", text: "This file is no longer in the project." })); return; }
      var held = f.heldBack ? f.heldBack : rep.head ? Math.max(0, rep.tokens - rep.head.tokens) : 0;
      var shown = state.sheet.full ? rep.outline : rep.outline.slice(0, 3);
      // replaceChildren would print a null as text, so absent parts are dropped first.
      call.replaceChildren.apply(call, [
        h("h4", null, held ? [h("span", { cls: "hlt num", text: Math.round(held).toLocaleString() }), f.heldBack ? " tokens held back" : " tokens it would hold back"] : [h("span", { cls: "hlt num", text: Math.round(rep.tokens).toLocaleString() }), " tokens, read in full"]),
        h("div", { cls: "sub", text: rep.head ? "Trimmed to lines 1\u2013" + rep.head.lines + " \xB7 " + rep.label + " \xB7 confidence " + rep.confidence.toFixed(2) : rep.label === "source" ? inGroup(g, rep.path) + " \xB7 your code, always read whole" : rep.label + " \xB7 one long line, searched instead of read" }),
        rep.hint ? h("div", { cls: "grep", text: rep.hint }) : null,
        shown.length ? h("table", null, h("tr", null, h("th", { text: "Name" }), h("th", { text: "Detail" }), h("th", { text: "Line" }), h("th", { text: "Kind" })),
          shown.map(function (x) { return h("tr", null, h("td", { text: x.name }), h("td", { text: x.detail || "\u2014" }), h("td", { text: x.line ? "L" + x.line : "\u2014" }), h("td", { text: x.kind === "dependency" ? "dependency" : "match" })); })) : null,
        h("div", { cls: "cf" }, rep.outline.length > 3 ? h("button", { cls: "link", type: "button", text: state.sheet.full ? "Show less" : "Open full outline", on: { click: function () { state.sheet.full = !state.sheet.full; fill(rep); wire(); } } }) : h("span"),
          h("span", { text: rep.outline.length ? "Showing " + shown.length + " from the outline" + (rep.more ? " (+" + rep.more + " more)" : "") : "No exported names to outline in this file" }))].filter(Boolean));
      wire();
    };
    if (f) fileReport(f.path, fill); else fill(null);

    // Glowing bars, as in the landing page's lower sections.
    var kindRows = g.kinds.map(function (k) { return [labelOf(k.label), k.tokens, fmt(k.tokens) + " tok"]; });
    var bulkIdx = -1; g.kinds.forEach(function (k, i) { if (bulkIdx < 0 && bulk(k.label)) bulkIdx = i; });
    var big = bulkIdx >= 0 ? g.kinds[bulkIdx] : null;
    var cards = [gbar(name + " by kind", "tokens", big ? [h("span", { cls: "hlt", text: labelOf(big.label) + " is " + pct(big.tokens, g.tokens) + "% of it." }), " Snout trims it; your code goes in whole."] : "All of it is your own code, read whole.", kindRows, bulkIdx)];
    if (f) {
      var v = perRead(f);
      cards.push(gbar("What one read of " + shortName(f.path) + " costs", "tokens re-sent", [h("span", { cls: "hlt", text: "Read once, paid for on every message." }), v.w < v.wo ? " Unless Snout keeps it out." : " Your code is worth it."],
        [["Read once", v.wo, fmt(v.wo)], ["After 10 messages", v.wo * 10, fmt(v.wo * 10)], ["After 20 messages", v.wo * 20, fmt(v.wo * 20)], ["With Snout, 20 messages", v.w * 20, fmt(v.w * 20)]], 3));
    }

    var panel = reportPanel(r, g, { sheet: true, file: file, onFile: function (p) { state.sheet.file = p; state.sheet.full = false; renderSheet(); }, onGroup: function (k) { state.sheet = { key: k, file: null, full: false }; renderSheet(); } });
    var wireSvg = s("svg", { class: "wire", "aria-hidden": "true" });
    var grid = h("div", { cls: "sheet-grid" }, h("div", null, h("div", { cls: "eyebrow", text: "Repo map \xB7 " + name }), h("h1", { text: headline }), h("p", { cls: "lede", text: lede }), call, h("div", { cls: "stack" }, cards)), panel, wireSvg);
    var close = h("button", { cls: "btn x", type: "button", text: "Close  esc", on: { click: closeSheet } });
    el.replaceChildren(stairs("l", [56, 44, 30, 18, 42, 50], 2), stairs("r", [14, 26, 38, 54], 2),
      h("div", { cls: "sheet-in" }, h("div", { cls: "sheet-top" }, h("div", { cls: "brand" }, h("img", { src: document.querySelector(".brand img").src, alt: "" }), "Snout", h("small", { text: "Local" })), close), grid));
    el.scrollTop = keep;
    if (fresh) close.focus();

    // A pink line from the callout to the file it describes, like the landing page's.
    function wire() {
      requestAnimationFrame(function () {
        var row = panel.querySelector(".nm.sel");
        wireSvg.replaceChildren();
        if (!row || window.innerWidth <= 1100) return;
        var G = grid.getBoundingClientRect(), C = call.getBoundingClientRect(), R = row.getBoundingClientRect();
        var x0 = C.right - G.left, y0 = C.top - G.top + 34, x1 = R.left - G.left - 18, y1 = R.top - G.top + R.height / 2, xm = x0 + Math.max(16, (x1 - x0) * 0.5);
        wireSvg.appendChild(s("path", { d: "M" + x0 + "," + y0 + " H" + xm + " V" + y1 + " H" + x1 }));
        wireSvg.appendChild(s("circle", { cx: x1, cy: y1, r: 4.5 }));
      });
    }
    wire();
  }
  window.addEventListener("resize", function () { if (state.sheet) renderSheet(); });

  // --- Agent context files ------------------------------------------------------------------

  var KIND = { always: ["Every session", "loaded in full"], described: ["Every session", "its description"], "on-demand": ["When used", "read on demand"] };
  function renderAgentFiles(v) {
    var a = v.d.agentFiles, box = $("agentfiles-box");
    var c = h("div", { cls: "card" }, h("div", { cls: "card-h" }, h("div", null, h("h2", { text: "Agent context files" }), h("p", { text: "Instructions, memory, skills and commands your agents load, and what each one costs" }))));
    if (!a) { c.appendChild(h("div", { cls: "none", text: "Reading your agent files\u2026" })); box.replaceChildren(c); return; }
    c.appendChild(h("div", { cls: "af-sum" },
      h("div", null, h("div", { cls: "k", text: "Files" }), h("div", { cls: "v num", text: String(a.count) })),
      h("div", null, h("div", { cls: "k", text: "Loaded every session" }), h("div", { cls: "v num pink", text: "~" + fmt(a.alwaysPerSession) })),
      h("div", null, h("div", { cls: "k", text: "Flagged" }), h("div", { cls: "v num", text: String(a.flagged) })),
      h("div", null, h("div", { cls: "k", text: "Could save per session" }), h("div", { cls: "v num", text: a.savePerSession ? "~" + fmt(a.savePerSession) : "\u2014" }))));
    var max = 1; a.files.forEach(function (f) { max = Math.max(max, f.perSession || f.tokens); });
    a.files.slice(0, 12).forEach(function (f) {
      var k = KIND[f.kind] || [f.kind, ""], w = ((f.perSession || f.tokens) / max) * 100;
      c.appendChild(h("div", { cls: "af" },
        h("div", { cls: "p" }, h("b", { text: f.path, title: f.path }), h("small", { text: f.role + " \xB7 " + (f.agents || []).map(function (x) { return CLIENT[x] || x; }).join(", ") + (f.uses !== null && f.uses !== undefined ? " \xB7 " + (f.uses ? f.uses + (f.uses === 1 ? " use" : " uses") : "never used") : "") }),
          f.flags.length ? h("div", null, f.flags.map(function (x) { return h("span", { cls: "flag", title: x.reason + " Suggested: " + x.action + ".", text: x.code }); })) : null),
        h("div", { cls: "kind" }, h("b", { text: k[0] }), k[1]),
        h("div", { cls: "bar" }, h("i", { cls: f.kind === "always" ? "always" : f.kind === "on-demand" ? "od" : "", style: "width:" + Math.max(1.5, w).toFixed(1) + "%" })),
        h("div", { cls: "n" }, f.perSession ? "~" + fmt(f.perSession) : "~" + fmt(f.tokens), h("small", { text: f.perSession ? "per session" : "when read" }))));
    });
    c.appendChild(h("p", { cls: "note" }, "From ", h("code", { text: "snout audit context" }), ", refreshed every few minutes. It archives a file only after you confirm, and every archive can be restored."));
    box.replaceChildren(c);
  }

  // --- MCP servers ----------------------------------------------------------------------------

  // MCP servers people connect, with Simple Icons marks (CC0) where one exists. They only identify the server.
  var MCP_ICONS = {
    "github": ["GitHub", "#181717", "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"],
    "linear": ["Linear", "#5E6AD2", "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"],
    "sentry": ["Sentry", "#362D59", "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"],
    "notion": ["Notion", "#000000", "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"],
    "figma": ["Figma", "#F24E1E", "M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z"],
    "supabase": ["Supabase", "#3FCF8E", "M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"],
    "stripe": ["Stripe", "#635BFF", "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"],
    "atlassian": ["Atlassian", "#0052CC", "M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z"],
    "postgresql": ["PostgreSQL", "#4169E1", "M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z"],
    "vercel": ["Vercel", "#000000", "m12 1.608 12 20.784H0Z"],
    "cloudflare": ["Cloudflare", "#F38020", "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"],
    "googledrive": ["Google Drive", "#4285F4", "M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"],
    "mongodb": ["MongoDB", "#47A248", "M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z"],
    "gitlab": ["GitLab", "#FC6D26", "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"],
    "asana": ["Asana", "#F06A6A", "M18.78 12.653c-2.882 0-5.22 2.336-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.34 5.22-5.22-2.336-5.22-5.22-5.22zm-13.56 0c-2.88 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.338 5.22-5.22-2.336-5.22-5.22-5.22zm12-6.525c0 2.883-2.337 5.22-5.22 5.22-2.882 0-5.22-2.337-5.22-5.22 0-2.88 2.338-5.22 5.22-5.22 2.883 0 5.22 2.34 5.22 5.22z"],
    "airtable": ["Airtable", "#18BFFF", "M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z"],
    "hubspot": ["HubSpot", "#FF7A59", "M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z"],
    "shopify": ["Shopify", "#7AB55C", "M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z"],
    "playwright": ["Playwright", "#2EAD33", null],
    "slack": ["Slack", "#4A154B", null],
    "context7": ["Context7", "#0F766E", null],
    "puppeteer": ["Puppeteer", "#40B5A4", null],
    "filesystem": ["Filesystem", "#57534E", null],
  };
  var MCP_ALIAS = { postgres: "postgresql", gdrive: "googledrive", googledocs: "googledrive", jira: "atlassian", confluence: "atlassian", ctx7: "context7" };
  var MCP_BLOAT = { github: "PR diffs, issue and file lists", linear: "issue lists and comments", sentry: "events and stack traces", notion: "pages and database rows", figma: "design node trees",
    supabase: "query results and logs", stripe: "API objects", atlassian: "Jira issues, Confluence pages", postgresql: "query results", vercel: "build and deploy logs", cloudflare: "logs and configs",
    googledrive: "documents", mongodb: "query results", gitlab: "MR diffs and pipelines", asana: "task lists", airtable: "records", hubspot: "CRM records", shopify: "store data",
    playwright: "page snapshots", slack: "channel history", context7: "library docs", puppeteer: "page content", filesystem: "file listings" };
  var MCP_GALLERY = ["github", "linear", "sentry", "playwright", "notion", "figma", "supabase", "atlassian", "slack", "stripe", "postgresql", "vercel", "cloudflare", "gitlab", "googledrive", "mongodb", "context7", "asana", "airtable", "hubspot", "shopify"];
  function mcpKey(name) {
    var n = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (MCP_ICONS[n]) return n;
    if (MCP_ALIAS[n]) return MCP_ALIAS[n];
    for (var k in MCP_ICONS) if (n.indexOf(k) >= 0) return k;
    for (var a in MCP_ALIAS) if (n.indexOf(a) >= 0) return MCP_ALIAS[a];
    return null;
  }
  function mcpTitle(name) { var k = mcpKey(name); return k ? MCP_ICONS[k][0] : String(name || "MCP").replace(/[-_]+/g, " ").replace(/^./, function (c) { return c.toUpperCase(); }); }
  function mcpLogo(name, live) {
    var k = mcpKey(name), info = k && MCP_ICONS[k];
    var color = info ? info[1] : "#6b6d65";
    if (color === "#000000" || color === "#181717") color = "#1a1418";
    var box = h("span", { cls: "mlogo" + (live ? " live" : ""), style: "--b:" + color, "aria-hidden": "true" });
    if (info && info[2]) { var svg = s("svg", { viewBox: "0 0 24 24" }); svg.appendChild(s("path", { d: info[2], fill: "currentColor" })); box.appendChild(svg); }
    else box.appendChild(h("b", { text: k === "context7" ? "C7" : (info ? info[0] : String(name || "?")).slice(0, 1).toUpperCase() }));
    return box;
  }
  function recOf(x) {
    var share = x.asked ? x.heldBack / x.asked : 0;
    if (x.after > 8000) return { tone: "warn", text: "~" + fmt(x.after) + " tokens a call still reach the agent. Ask it for fewer fields or smaller pages." };
    if (share >= 0.4) return { tone: "ok", text: "Snout trims " + Math.round(share * 100) + "% of every result. Nothing to change." };
    if (x.per < 1500) return { tone: "", text: "Results are small (~" + fmt(x.per) + " a call), so Snout leaves them whole." };
    return { tone: "warn", text: "Mostly read whole (" + Math.round(share * 100) + "% trimmed). Narrower queries would save more." };
  }
  function renderMcp(v) {
    var d = v.d, box = $("mcp-box");
    var live = {};
    (d.recent || []).forEach(function (r) { if (r.tool && r.tool.indexOf("mcp__") === 0 && Date.now() - Date.parse(r.ts) < 10 * 60 * 1000) live[r.tool.split("__")[1]] = 1; });
    var list = (d.byMcpServer || []).map(function (x) {
      var asked = x.inContext + x.heldBack;
      return { key: x.key, name: mcpTitle(x.key), calls: x.reads, inContext: x.inContext, heldBack: x.heldBack, asked: asked, per: x.reads ? asked / x.reads : 0, after: x.reads ? x.inContext / x.reads : 0, live: !!live[x.key] };
    }).sort(function (a, b) { return b.asked - a.asked; });
    var used = {}; list.forEach(function (x) { used[x.key] = 1; });
    var idle = (d.mcpConfig || []).filter(function (c) { return c.calls === 0 && !used[c.name]; });
    var held = 0, asked = 0; list.forEach(function (x) { held += x.heldBack; asked += x.asked; });
    var c = h("div", { cls: "card" }, h("div", { cls: "card-h" }, h("div", null, h("h2", { text: "MCP servers" }),
      h("p", { text: list.length ? list.length + (list.length === 1 ? " server" : " servers") + " sent results \xB7 ~" + fmt(held) + " tokens kept out, " + pct(held, asked) + "% of what they returned" : "Results from every MCP server your agents use, and what Snout trimmed" }))));
    var grid = h("div", { cls: "mcp-grid" });
    list.forEach(function (x, i) {
      var r = recOf(x), max = x.per || 1;
      grid.appendChild(h("div", { cls: "mtile" + (state.first ? " pop" : ""), style: "--d:" + (i * 0.05).toFixed(2) + "s" },
        h("div", { cls: "mtile-h" }, mcpLogo(x.key, x.live), h("div", { style: "min-width:0" }, h("div", { cls: "nm", text: x.name }), h("div", { cls: "sub", text: x.calls.toLocaleString() + (x.calls === 1 ? " call \xB7 " : " calls \xB7 ") + (MCP_BLOAT[mcpKey(x.key)] || "tool results") })), x.live ? h("span", { cls: "live-tag", text: "LIVE" }) : null),
        h("div", { cls: "big num" }, x.heldBack ? "~" + fmt(x.heldBack) : "0", h("small", { text: x.heldBack ? "kept out \xB7 \u2212" + pct(x.heldBack, x.asked) + "%" : "kept out" })),
        h("div", { cls: "wbars", title: "Tokens per call" }, h("span", { text: "Without" }), h("i", { style: "width:100%;background:var(--without)" }), h("span", { cls: "n", text: fmt(x.per) }),
          h("span", { text: "With Snout" }), h("i", { style: "width:" + Math.max(2, (x.after / max) * 100) + "%;background:var(--ink)" }), h("span", { cls: "n", text: fmt(x.after) })),
        h("div", { cls: "rec " + r.tone }, h("i", { text: r.tone === "ok" ? "\u2713" : r.tone === "warn" ? "!" : "i" }), h("span", { text: r.text }))));
    });
    idle.forEach(function (x) {
      grid.appendChild(h("div", { cls: "mtile" }, h("div", { cls: "mtile-h" }, mcpLogo(x.name), h("div", { style: "min-width:0" }, h("div", { cls: "nm", text: mcpTitle(x.name) }), h("div", { cls: "sub", text: x.source }))),
        h("div", { cls: "big num", style: "color:var(--ink)" }, "0", h("small", { text: "calls in 30 days" })),
        h("div", { cls: "rec warn" }, h("i", { text: "!" }), h("span", null, "Never called, but its tool list rides along on every request. ", h("code", { text: "snout audit" }), " shows how to turn it off."))));
    });
    if (!list.length && !idle.length) c.appendChild(h("div", { cls: "none", text: "No MCP calls yet. Results from every MCP server your agents use show up here." }));
    else c.appendChild(grid);
    var seen = {}; list.forEach(function (x) { var k = mcpKey(x.key); if (k) seen[k] = 1; }); (d.mcpConfig || []).forEach(function (x) { var k = mcpKey(x.name); if (k) seen[k] = 1; });
    c.appendChild(h("h3", { style: "margin:22px 0 0", text: "Works with any MCP server" }));
    c.appendChild(h("div", { cls: "gallery" }, MCP_GALLERY.map(function (k) {
      return h("span", { cls: "gal-i" + (seen[k] ? " seen" : ""), title: (seen[k] ? "Connected here" : "Not connected") + " \xB7 typical bloat: " + MCP_BLOAT[k] }, mcpLogo(k), MCP_ICONS[k][0]);
    })));
    box.replaceChildren(c);
  }

  // --- Spend tab --------------------------------------------------------------------------

  function renderSpend(v) {
    var sp = v.sp;
    var svg = $("bars"), tip = $("bars-tip");
    svg.replaceChildren();
    if (!sp) {
      $("sp-total").textContent = "\u2014"; $("sp-meta").textContent = "No Claude Code or Codex usage found for this project yet.";
      $("kinds").replaceChildren(h("div", { cls: "none", text: "Appears after the first session." }));
      tableOf($("sp-models"), [], [], "No spend yet.");
      return;
    }
    $("bars-p").textContent = "Last " + sp.days + " days \xB7 API list prices of " + sp.pricesAsOf;
    $("sp-total").textContent = usd(sp.costUsd);
    $("sp-meta").textContent = sp.requests.toLocaleString() + " requests \xB7 " + fmt(sp.tokens) + " tokens";
    var byDay = {}; sp.series.forEach(function (r) { byDay[r.day] = r; });
    var list = lastDays(sp.days, byDay, function (k) { return { day: k, costUsd: 0, tokens: 0 }; });
    var W = Math.max(280, svg.clientWidth || 600), H = 160, B = 18;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var top = 0; list.forEach(function (r) { top = Math.max(top, r.costUsd); });
    var bw = W / list.length;
    list.forEach(function (r, i) {
      var hgt = top ? (r.costUsd / top) * (H - B - 6) : 0;
      var rect = s("rect", { cls: "b", class: "b" + (i === list.length - 1 ? " today" : ""), x: i * bw + 1.5, y: H - B - hgt, width: Math.max(1, bw - 3), height: Math.max(hgt, r.costUsd ? 1.5 : 0), rx: 2 });
      rect.addEventListener("mousemove", function () {
        var rb = svg.getBoundingClientRect();
        tip.replaceChildren(h("b", { text: dayName(r.day) }), h("br"), usd(r.costUsd) + " \xB7 " + fmt(r.tokens) + " tokens");
        tip.style.left = ((i + 0.5) * bw / W) * rb.width + "px"; tip.style.top = ((H - B - hgt) / H) * rb.height - 6 + "px"; tip.style.opacity = 1;
      });
      rect.addEventListener("mouseleave", function () { tip.style.opacity = 0; });
      svg.appendChild(rect);
    });
    [0, Math.floor(list.length / 2), list.length - 1].forEach(function (i) {
      var t = s("text", { x: i === 0 ? 0 : i === list.length - 1 ? W : (i + 0.5) * bw, y: H - 3, "text-anchor": i === 0 ? "start" : i === list.length - 1 ? "end" : "middle" });
      t.textContent = i === list.length - 1 ? "Today" : dayName(list[i].day); svg.appendChild(t);
    });

    var uncached = Math.max(0, sp.input), kinds = [
      ["Input", uncached, "var(--ink)"], ["Cache writes", sp.cacheWrite, "#8a8a93"], ["Cache reads", sp.cacheRead, "var(--bar-in)"], ["Output", sp.output, "var(--accent)"],
    ];
    var total = kinds.reduce(function (a, k) { return a + k[1]; }, 0) || 1;
    var split = h("div", { cls: "split" }); kinds.forEach(function (k) { if (k[1]) split.appendChild(h("i", { style: "--c:" + k[2] + ";flex:" + k[1] })); });
    var kv = h("dl", { cls: "kv" });
    kinds.forEach(function (k) { kv.appendChild(h("dt", { style: "--c:" + k[2] }, h("i"), k[0])); kv.appendChild(h("dd", { text: fmt(k[1]) + " \xB7 " + pct(k[1], total) + "%" })); });
    var notes = [];
    if (sp.cacheRead) notes.push("Cache reads bill at about a tenth of the input price, so most of the volume costs little.");
    if (sp.unpriced.length) notes.push("No list price for " + sp.unpriced.join(", ") + ", so it isn't in the totals.");
    notes.push("On a Claude or ChatGPT subscription, this is what the same work would cost on the API.");
    $("kinds").replaceChildren(split, kv, h("p", { cls: "none", style: "margin-top:10px", text: notes.join(" ") }));

    $("sp-models-p").textContent = "Last " + sp.days + " days";
    tableOf($("sp-models"), [["Model"], ["Agent", "hide-sm"], ["Requests", "n"], ["Tokens", "n hide-sm"], ["Cost", "n"], ["Share", "n"]], v.models.map(function (m) {
      return h("tr", null,
        h("td", null, h("span", { cls: "who", style: "--c:" + m.color }, modelLogo(m.key, true), h("i", { cls: "dot" }), h("span", { text: m.label }))),
        h("td", { cls: "hide-sm", text: m.client ? CLIENT[m.client] || m.client : "" }),
        h("td", { cls: "n", text: (sp.byModel.filter(function (x) { return x.key === m.key; })[0] || { requests: 0 }).requests.toLocaleString() }),
        h("td", { cls: "n hide-sm", text: fmt((sp.byModel.filter(function (x) { return x.key === m.key; })[0] || { tokens: 0 }).tokens) }),
        h("td", { cls: "n", text: usd(m.cost30) }), h("td", { cls: "n strong", text: (m.share * 100).toFixed(1) + "%" }));
    }), "No spend yet.");
  }

  function renderAbout(v) {
    var m = v.d.meta || {};
    $("about").textContent = "Snout " + (m.version || "") + " \xB7 project " + (m.project || "") + " \xB7 " + v.d.reads.toLocaleString() + " reads classified, p50 " + v.d.latency.p50 + " ms, p95 " + v.d.latency.p95 + " ms per decision. Everything on this page is computed on your machine.";
  }

  function render(d) {
    state.data = d;
    var v = view(d);
    renderHead(v);
    renderBand(v);
    renderModels(v);
    renderToday(v);
    renderFeed(v);
    renderTrend(v);
    renderCost(v);
    renderMix(v);
    renderContext(v);
    renderAgentFiles(v);
    renderMcp(v);
    if (state.tab === "overview") renderRepo(v);
    if (state.tab === "spend" || state.first) renderSpend(v);
    renderAbout(v);
    state.first = false;
  }

  // --- tabs, live connection ----------------------------------------------------------------

  function showTab(tab) {
    state.tab = tab;
    [].forEach.call(document.querySelectorAll(".tab"), function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === tab)); });
    [].forEach.call(document.querySelectorAll("[data-view]"), function (sec) { sec.hidden = sec.getAttribute("data-view") !== tab; });
    $("title").textContent = { overview: "Dashboard", context: "Context", spend: "Spend", settings: "Settings" }[tab];
    if (history.replaceState) history.replaceState(null, "", tab === "overview" ? location.pathname + location.search : "#" + tab);
    if (state.data) { var v = view(state.data); if (tab === "spend") renderSpend(v); if (tab === "overview") { renderTrend(v); renderRepo(v); } }
  }
  [].forEach.call(document.querySelectorAll(".tab"), function (b) { b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); window.scrollTo(0, 0); }); });
  [].forEach.call(document.querySelectorAll("[data-go]"), function (b) { b.addEventListener("click", function () { showTab(b.getAttribute("data-go")); window.scrollTo(0, 0); }); });
  ["modeSwitch", "modeSwitch2"].forEach(function (id) {
    [].forEach.call($(id).querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () { if (!b.classList.contains("on")) act({ type: "mode", value: b.getAttribute("data-mode") }); });
    });
  });
  [].forEach.call($("coachSwitch").querySelectorAll("button"), function (b) {
    b.addEventListener("click", function () { if (!b.classList.contains("on")) act({ type: "coach", value: b.getAttribute("data-coach") }); });
  });
  ["connect", "connect2"].forEach(function (id) { $(id).addEventListener("click", function () { act({ type: "login" }); }); });

  var es = null, poll = null;
  function setLive(ok, text) { $("live").className = "live" + (ok ? " on" : ""); $("live-t").textContent = text; }
  function query() { return state.session ? "?session=" + encodeURIComponent(state.session) : ""; }
  function open() {
    if (es) es.close();
    if (poll) { clearInterval(poll); poll = null; }
    state.seen = null;
    if (!window.EventSource) return startPolling();
    es = new EventSource("/events" + query());
    es.addEventListener("summary", function (ev) { setLive(true, "Live"); render(JSON.parse(ev.data)); });
    es.onopen = function () { setLive(true, "Live"); };
    es.onerror = function () { setLive(false, "Reconnecting"); };
  }
  function startPolling() {
    function tick() { fetch("/api/summary" + query()).then(function (r) { return r.json(); }).then(function (d) { setLive(true, "Live"); render(d); }, function () { setLive(false, "Offline"); }); }
    tick(); poll = setInterval(tick, 3000);
  }
  $("session").addEventListener("change", function () { state.session = this.value; open(); });
  var rt = 0;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { if (state.data) { var v = view(state.data); renderTrend(v); if (state.tab === "overview") renderRepo(v); if (state.tab === "spend") renderSpend(v); } }, 120); });
  setInterval(function () { document.querySelectorAll("[data-ts]").forEach(function (el) { el.textContent = ago(el.getAttribute("data-ts")); }); }, 15000);
  var start = (location.hash || "").slice(1);
  if (["context", "spend", "settings"].indexOf(start) >= 0) showTab(start);
  open();
})();
</script>
</body>
</html>
`;

// src/dashboard/page.ts
var PAGE = page_default;

// src/spend/usage.ts
import { existsSync as existsSync8, readdirSync as readdirSync2, readFileSync as readFileSync8, statSync as statSync9, writeFileSync as writeFileSync3, mkdirSync as mkdirSync5 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname6, join as join10, resolve as resolve5, sep as sep2 } from "node:path";

// src/spend/prices.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { join as join9 } from "node:path";
var claude = (input, cacheRead, output, fast) => ({
  input,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
  output,
  ...fast ? { fast } : {}
});
var openai = (input, cacheRead, output, cacheWrite = 0) => ({ input, cacheWrite5m: cacheWrite, cacheWrite1h: cacheWrite, cacheRead, output });
var PRICES_AS_OF = "2026-09-28";
var PRICES = {
  "claude-fable-5-1": claude(10, 0.25, 50),
  "claude-mythos-5-1": claude(10, 0.25, 50),
  "claude-fable-5": claude(10, 1, 50),
  "claude-mythos-5": claude(10, 1, 50),
  "claude-opus-5-5": claude(4, 0.2, 20, { input: 8, output: 40 }),
  "claude-opus-5": claude(5, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-8": claude(5, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-7": claude(5, 0.5, 25),
  "claude-opus-4-6": claude(5, 0.5, 25),
  "claude-opus-4-5": claude(5, 0.5, 25),
  "claude-opus-4-1": claude(15, 1.5, 75),
  "claude-opus-4": claude(15, 1.5, 75),
  "claude-sonnet-5-5": claude(2, 0.2, 10),
  "claude-sonnet-5": claude(2, 0.2, 10),
  "claude-sonnet-4-6": claude(3, 0.3, 15),
  "claude-sonnet-4-5": claude(3, 0.3, 15),
  "claude-sonnet-4": claude(3, 0.3, 15),
  // Released 2026-10-07 (anthropic.com/claude-haiku-5-5). Prompts over 100k tokens bill at 5× these
  // rates; like the other models here, the long-context tier is not modelled.
  "claude-haiku-5-5": claude(0.1, 0.01, 0.5),
  "claude-haiku-4-5": claude(1, 0.1, 5),
  "claude-3-5-haiku": claude(0.8, 0.08, 4),
  "gpt-6-astra": openai(10, 1, 50, 12.5),
  "gpt-6-sol": openai(2, 0.2, 10, 2.5),
  "gpt-6-luna": openai(0.1, 0.01, 0.5, 0.125),
  "gpt-5.6-sol": openai(4, 0.4, 20, 5),
  "gpt-5.6-terra": openai(2, 0.2, 12, 2.5),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2, 0.25),
  "gpt-5.5": openai(5, 0.5, 30),
  "gpt-5.4": openai(2.5, 0.25, 15),
  "gpt-5.3-codex": openai(1.75, 0.175, 14),
  "gpt-5.2": openai(1.75, 0.175, 14),
  "gpt-5.1": openai(1.25, 0.125, 10)
};
function modelKey(model) {
  return model.toLowerCase().replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
}
var overrides = null;
function userPrices(configDir2) {
  if (overrides) return overrides;
  try {
    overrides = JSON.parse(readFileSync7(join9(configDir2, "prices.json"), "utf8"));
  } catch {
    overrides = {};
  }
  return overrides;
}
function priceOf(model, configDir2) {
  const key = modelKey(model);
  const user = configDir2 ? userPrices(configDir2) : {};
  return user[key] ?? PRICES[key] ?? null;
}
function costOf(model, u, configDir2) {
  const p = priceOf(model, configDir2);
  if (!p) return null;
  const scale = u.fast && p.fast ? p.fast.input / p.input : 1;
  const output = u.fast && p.fast ? p.fast.output : p.output;
  return (u.input * p.input * scale + u.cacheWrite5m * p.cacheWrite5m * scale + u.cacheWrite1h * p.cacheWrite1h * scale + u.cacheRead * p.cacheRead * scale + u.output * output) / 1e6;
}

// src/spend/usage.ts
var claudeRoot = () => join10(process.env.CLAUDE_CONFIG_DIR || join10(homedir3(), ".claude"), "projects");
var codexRoot = () => join10(process.env.CODEX_HOME || join10(homedir3(), ".codex"), "sessions");
var claudeSlug = (projectDir) => resolve5(projectDir).replace(/[^A-Za-z0-9]/g, "-");
function jsonlFiles(dir, depth = 4) {
  if (depth < 0 || !existsSync8(dir)) return [];
  const out = [];
  for (const e of readdirSync2(dir, { withFileTypes: true })) {
    const p = join10(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p, depth - 1));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
function parseLines(text, each) {
  for (const line of text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    try {
      each(JSON.parse(line));
    } catch {
    }
  }
}
function claudeRequests(text) {
  const byId = /* @__PURE__ */ new Map();
  parseLines(text, (o) => {
    const m = o?.message;
    const u = m?.usage;
    if (!u || typeof m.model !== "string" || m.model.startsWith("<")) return;
    const create = u.cache_creation_input_tokens || 0;
    const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const r = {
      day: String(o.timestamp || "").slice(0, 10),
      model: m.model,
      cwd: o.cwd,
      input: u.input_tokens || 0,
      cacheWrite1h: Math.min(oneHour, create),
      cacheWrite5m: create - Math.min(oneHour, create),
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
      fast: u.speed === "fast"
    };
    const id = o.requestId || m.id || o.uuid;
    const prev = byId.get(id);
    if (!prev || r.output >= prev.output) byId.set(id, r);
  });
  return [...byId.values()].filter((r) => r.day);
}
function codexRequests(text) {
  let cwd = null;
  let model = "unknown";
  const byId = /* @__PURE__ */ new Map();
  let lastTotal = -1;
  const add = (id, ts, u) => {
    const cached = u.cached_input_tokens || 0;
    const write2 = u.cache_write_input_tokens || 0;
    byId.set(id, {
      day: String(ts || "").slice(0, 10),
      model,
      input: Math.max(0, (u.input_tokens || 0) - cached - write2),
      cacheWrite5m: write2,
      cacheWrite1h: 0,
      cacheRead: cached,
      output: u.output_tokens || 0
      // includes reasoning tokens, which bill as output
    });
  };
  let sawRecords = false;
  const fallback = [];
  parseLines(text, (o) => {
    const p = o?.payload ?? {};
    if (o.type === "session_meta" && typeof p.cwd === "string") cwd = p.cwd;
    else if (o.type === "turn_context" && typeof p.model === "string") model = p.model;
    else if (o.type === "token_usage_record" && p.usage) {
      sawRecords = true;
      add(p.response_id || `${byId.size}`, o.timestamp, p.usage);
    } else if (o.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) {
      const total = p.info.total_token_usage?.total_tokens ?? -1;
      if (total !== lastTotal) {
        lastTotal = total;
        fallback.push([`tc${fallback.length}`, o.timestamp, p.info.last_token_usage]);
      }
    }
  });
  if (!sawRecords) for (const [id, ts, u] of fallback) add(id, ts, u);
  return { cwd, reqs: [...byId.values()].filter((r) => r.day) };
}
function rollup(reqs, client2, configDir2) {
  const m = /* @__PURE__ */ new Map();
  for (const r of reqs) {
    const key = `${r.day}\0${r.model}`;
    const s = m.get(key) ?? { day: r.day, client: client2, model: r.model, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0 };
    s.requests += 1;
    s.input += r.input;
    s.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
    s.cacheRead += r.cacheRead;
    s.output += r.output;
    const c = costOf(r.model, r, configDir2);
    s.costUsd = c === null || s.costUsd === null ? null : s.costUsd + c;
    m.set(key, s);
  }
  return [...m.values()];
}
function loadCache(path) {
  try {
    return JSON.parse(readFileSync8(path, "utf8"));
  } catch {
    return {};
  }
}
function fileRows(file2, client2, cache2, configDir2) {
  let st;
  try {
    st = statSync9(file2);
  } catch {
    return null;
  }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache2[file2];
  if (hit && hit.stamp === stamp) return hit;
  const text = readFileSync8(file2, "utf8");
  let entry;
  if (client2 === "claude") {
    const reqs = claudeRequests(text);
    entry = { stamp, client: client2, cwd: reqs.find((r) => r.cwd)?.cwd ?? null, rows: rollup(reqs, client2, configDir2) };
  } else {
    const { cwd, reqs } = codexRequests(text);
    entry = { stamp, client: client2, cwd, rows: rollup(reqs, client2, configDir2) };
  }
  cache2[file2] = entry;
  return entry;
}
var inside = (child, parent) => !!child && (child === parent || child.startsWith(parent + sep2));
function readSpend(projectDir, cachePath, configDir2) {
  const cache2 = cachePath ? loadCache(cachePath) : {};
  const out = /* @__PURE__ */ new Map();
  const push = (cwd, rows) => out.set(cwd, [...out.get(cwd) ?? [], ...rows]);
  const root = projectDir ? resolve5(projectDir) : null;
  const claudeDirs = root ? [join10(claudeRoot(), claudeSlug(root))] : existsSync8(claudeRoot()) ? readdirSync2(claudeRoot()).map((d) => join10(claudeRoot(), d)) : [];
  for (const dir of claudeDirs) {
    for (const f of jsonlFiles(dir)) {
      const e = fileRows(f, "claude", cache2, configDir2);
      if (!e || !e.rows.length) continue;
      push(root ?? e.cwd ?? dir, e.rows);
    }
  }
  for (const f of jsonlFiles(codexRoot())) {
    const e = fileRows(f, "codex", cache2, configDir2);
    if (!e || !e.rows.length) continue;
    if (root && !inside(e.cwd, root)) continue;
    push(root ?? e.cwd ?? "unknown", e.rows);
  }
  for (const k of Object.keys(cache2)) if (!existsSync8(k)) delete cache2[k];
  if (cachePath) try {
    mkdirSync5(dirname6(cachePath), { recursive: true });
    writeFileSync3(cachePath, JSON.stringify(cache2));
  } catch {
  }
  for (const [k, rows] of out) out.set(k, merge(rows));
  return out;
}
function merge(rows) {
  const m = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const key = `${r.day}\0${r.client}\0${r.model}`;
    const s = m.get(key);
    if (!s) {
      m.set(key, { ...r });
      continue;
    }
    s.requests += r.requests;
    s.input += r.input;
    s.cacheWrite += r.cacheWrite;
    s.cacheRead += r.cacheRead;
    s.output += r.output;
    s.costUsd = s.costUsd === null || r.costUsd === null ? null : s.costUsd + r.costUsd;
  }
  return [...m.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : 1);
}

// src/spend/summary.ts
var tokensOf = (r) => r.input + r.cacheWrite + r.cacheRead + r.output;
function summarizeSpend(rows, sinceDay = "", now = /* @__PURE__ */ new Date()) {
  const today = now.toISOString().slice(0, 10);
  const weekStart = new Date(now.getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const clientCounts = /* @__PURE__ */ new Map();
  const s = { requests: 0, tokens: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0, unpriced: [], inputRate: 0, byModel: [], byClient: [], series: [] };
  const models = /* @__PURE__ */ new Map();
  const clients = /* @__PURE__ */ new Map();
  const days = /* @__PURE__ */ new Map();
  const unpriced = /* @__PURE__ */ new Set();
  let rateWeight = 0;
  let rateSum = 0;
  const bump3 = (m, key, r) => {
    const x = m.get(key) ?? { key, requests: 0, tokens: 0, costUsd: 0, input: 0, output: 0, client: r.client, today: { requests: 0, tokens: 0, costUsd: 0 }, weekCostUsd: 0 };
    x.requests += r.requests;
    x.tokens += tokensOf(r);
    x.costUsd += r.costUsd ?? 0;
    x.input += r.input + r.cacheWrite + r.cacheRead;
    x.output += r.output;
    if (r.day === today) {
      x.today.requests += r.requests;
      x.today.tokens += tokensOf(r);
      x.today.costUsd += r.costUsd ?? 0;
    }
    if (r.day >= weekStart) x.weekCostUsd += r.costUsd ?? 0;
    const c = clientCounts.get(x) ?? /* @__PURE__ */ new Map();
    c.set(r.client, (c.get(r.client) ?? 0) + r.requests);
    clientCounts.set(x, c);
    m.set(key, x);
  };
  for (const r of rows) {
    if (r.day < sinceDay) continue;
    s.requests += r.requests;
    s.tokens += tokensOf(r);
    s.input += r.input;
    s.cacheWrite += r.cacheWrite;
    s.cacheRead += r.cacheRead;
    s.output += r.output;
    s.costUsd += r.costUsd ?? 0;
    if (r.costUsd === null) unpriced.add(r.model);
    const p = priceOf(r.model);
    const w = r.input + r.cacheWrite + r.cacheRead;
    if (p && w > 0) {
      rateSum += p.input * w;
      rateWeight += w;
    }
    bump3(models, modelKey(r.model), r);
    bump3(clients, r.client, r);
    const d = days.get(r.day) ?? { day: r.day, costUsd: 0, tokens: 0 };
    d.costUsd += r.costUsd ?? 0;
    d.tokens += tokensOf(r);
    days.set(r.day, d);
  }
  const byCost = (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens;
  s.unpriced = [...unpriced];
  s.inputRate = rateWeight ? rateSum / rateWeight : 0;
  for (const [x, c] of clientCounts) x.client = [...c].sort((a, b) => b[1] - a[1])[0][0];
  s.byModel = [...models.values()].sort(byCost);
  s.byClient = [...clients.values()].sort(byCost);
  s.series = [...days.values()].sort((a, b) => a.day < b.day ? -1 : 1);
  return s;
}

// src/cloud/client.ts
import { createHash as createHash2 } from "node:crypto";
import { chmodSync, existsSync as existsSync9, mkdirSync as mkdirSync6, readFileSync as readFileSync9, rmSync, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename as basename3, dirname as dirname7, join as join11 } from "node:path";
import { spawnSync } from "node:child_process";
var DEFAULT_CLOUD_URL = "https://app.usesnout.xyz";
var SYNC_DAYS = 35;
var AUTO_SYNC_MS = 60 * 1e3;
var RECENT_DAYS = 2;
var FULL_SYNC_MS = 60 * 60 * 1e3;
var AGENT_SYNC_MS = 60 * 1e3;
function configDir() {
  if (process.env.SNOUT_CONFIG_DIR) return process.env.SNOUT_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join11(process.env.APPDATA, "snout");
  return join11(process.env.XDG_CONFIG_HOME || join11(homedir4(), ".config"), "snout");
}
var credsPath = () => join11(configDir(), "cloud.json");
function loadCredentials() {
  const env = process.env.SNOUT_TOKEN;
  if (env && env.startsWith("snt_")) return { url: cloudUrl(), token: env, user: "agent", team: "workspace" };
  try {
    const c = JSON.parse(readFileSync9(credsPath(), "utf8"));
    return c.url && c.token ? c : null;
  } catch {
    return null;
  }
}
function saveCredentials(c) {
  const p = credsPath();
  mkdirSync6(dirname7(p), { recursive: true });
  writeFileSync4(p, JSON.stringify(c, null, 2) + "\n", { mode: 384 });
  try {
    chmodSync(p, 384);
  } catch {
  }
}
function forgetCredentials() {
  if (!existsSync9(credsPath())) return false;
  rmSync(credsPath());
  return true;
}
function cloudUrl(flag) {
  return (flag || process.env.SNOUT_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/+$/, "");
}
function sessionOf(paths) {
  try {
    const s = JSON.parse(readFileSync9(join11(paths.snoutDir, "state.json"), "utf8"));
    return typeof s.session === "string" && s.session ? s.session : null;
  } catch {
    return null;
  }
}
function projectKey(projectDir) {
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: projectDir, encoding: "utf8", timeout: 3e3 });
  const remote = r.status === 0 ? r.stdout.trim() : "";
  const norm = remote ? remote.replace(/^[a-z+]+:\/\/([^@/]*@)?/i, "").replace(/^[^@/]*@/, "").replace(":", "/").replace(/\.git$/, "").toLowerCase() : projectDir;
  return createHash2("sha256").update(norm).digest("hex").slice(0, 24);
}
function buildPayload(paths, version, now = /* @__PURE__ */ new Date(), days = SYNC_DAYS) {
  const since = new Date(now.getTime() - (days - 1) * 864e5).toISOString().slice(0, 10);
  return {
    v: 1,
    snout: version,
    project: { key: projectKey(paths.projectDir), name: basename3(paths.projectDir).slice(0, 80) },
    days: dailyAggregates(readDecisions(paths.ledger, 2e4), since),
    ...sessionOf(paths) ? { run: createHash2("sha256").update(sessionOf(paths)).digest("hex").slice(0, 32) } : {},
    spend: [...readSpend(paths.projectDir, join11(paths.snoutDir, "spend-cache.json"), configDir()).values()].flat().filter((r) => r.day >= since).map((r) => ({ ...r, model: modelKey(r.model).slice(0, 64), costUsd: r.costUsd === null ? null : Math.round(r.costUsd * 1e6) / 1e6 }))
  };
}
async function post(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...token ? { authorization: `Bearer ${token}` } : {} },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15e3)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
  }
  return { status: res.status, json };
}
var syncState = (paths) => join11(paths.snoutDir, "cloud-sync.json");
function lastSync(paths) {
  try {
    return JSON.parse(readFileSync9(syncState(paths), "utf8"));
  } catch {
    return null;
  }
}
async function sync(paths, version) {
  const creds = loadCredentials();
  if (!creds) return { ok: false, message: "Not logged in. Run `snout login` first; nothing is sent until you do." };
  const last = lastSync(paths);
  const full = !last?.fullAt || Date.now() - Date.parse(last.fullAt) > FULL_SYNC_MS;
  const payload = buildPayload(paths, version, /* @__PURE__ */ new Date(), full ? SYNC_DAYS : RECENT_DAYS);
  let result;
  try {
    const { status, json } = await post(`${creds.url}/api/ingest`, payload, creds.token);
    if (status === 200) result = { ok: true, message: `Synced ${payload.days.length} day-row(s) for ${payload.project.name} to ${creds.team}.` };
    else if (status === 401) result = { ok: false, message: "The saved login was revoked or expired. Run `snout login` again." };
    else if (status === 402) result = { ok: false, message: `${String(json?.error ?? "Plan limit reached.").slice(0, 200)}${json?.upgrade ? ` ${String(json.upgrade).slice(0, 200)}` : ""} (Snout itself keeps working locally.)` };
    else result = { ok: false, message: `Sync failed (${status}): ${String(json?.error ?? "no detail").slice(0, 200)}` };
  } catch (err) {
    result = { ok: false, message: `Sync failed: ${err.message}` };
  }
  try {
    mkdirSync6(paths.snoutDir, { recursive: true });
    const fullAt = full && result.ok ? (/* @__PURE__ */ new Date()).toISOString() : last?.fullAt;
    writeFileSync4(syncState(paths), JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ok: result.ok, ...fullAt ? { fullAt } : {}, ...result.ok ? {} : { error: result.message } }) + "\n");
  } catch {
  }
  return result;
}
async function login(url, say2, openBrowser2) {
  if (!url) {
    say2("Snout Cloud has no default address yet. Pass one: snout login --url https://<your-snout-cloud>");
    return false;
  }
  let start;
  const beta = url === DEFAULT_CLOUD_URL ? " Snout Cloud is in private beta; everything local works without it. To join: https://usesnout.xyz/contact" : "";
  try {
    start = await post(`${url}/api/device/start`, { client: "snout-cli" });
  } catch (err) {
    say2(`Could not reach ${url}: ${err.message}.${beta}`);
    return false;
  }
  if (start.status !== 200 || !start.json?.device_code) {
    say2(`${url} did not start a login (${start.status}).${beta}`);
    return false;
  }
  const { device_code, user_code, verify_url, interval = 3, expires_in = 600 } = start.json;
  say2(`Open ${verify_url} and approve code ${user_code}.`);
  openBrowser2(verify_url);
  const deadline = Date.now() + expires_in * 1e3;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1e3));
    let res;
    try {
      res = await post(`${url}/api/device/poll`, { device_code });
    } catch {
      continue;
    }
    if (res.status === 428) continue;
    if (res.status === 200 && res.json?.token) {
      saveCredentials({ url, token: res.json.token, user: res.json.user, team: res.json.team });
      say2(`Logged in as ${res.json.user} (${res.json.team}). Totals sync when a session ends; \`snout sync --dry-run\` shows what is sent.`);
      return true;
    }
    say2(`Login ${res.status === 410 ? "expired" : "was refused"}. Run \`snout login\` to try again.`);
    return false;
  }
  say2("Login timed out. Run `snout login` to try again.");
  return false;
}

// src/map/map.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { readdirSync as readdirSync3, readFileSync as readFileSync10, statSync as statSync10 } from "node:fs";
import { basename as basename4, extname as extname2, join as join12, relative as relative5, sep as sep3 } from "node:path";
var TEXT_EXT = /\.(m?js|cjs|jsx|ts|tsx|mts|cts|py|pyi|go|rs|java|kt|kts|cs|rb|php|swift|scala|c|cc|cpp|h|hpp|m|mm|ex|exs|erl|clj|lua|sh|bash|zsh|sql|graphql|proto|vue|svelte|astro|md|mdx|rst|txt|toml|ya?ml|json|ini|cfg|conf|env\.example|html|css|scss)$/i;
var SKIP_DIR = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", "third_party", "coverage", ".next", ".venv", "venv", "__pycache__", ".snout", ".claude", ".tox", ".mypy_cache", ".pytest_cache"]);
var MAX_FILE_BYTES = 512 * 1024;
var MAX_FILES = 2e4;
var MAX_WORDS = 3e3;
var WORD = /[A-Za-z_][A-Za-z0-9_]{3,63}/g;
var TESTS = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*$|_tests?\.[a-z]+$|\.(test|spec)\.[a-z]+$/i;
var URL2 = /\b(?:https?:\/\/|www\.)\S+/g;
var PROSE = /\.(md|mdx|rst|txt|ya?ml|json|toml|ini|cfg|html)$|(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS)/i;
var STOP2 = new Set("this that with from import export return const self None True False null true false function class def async await else elif while yield None void static public private protected final string number boolean object undefined type interface extends implements raise except finally lambda pass break continue default switch case throw catch new delete typeof instanceof struct enum impl trait match package module require include using namespace println printf print len range dict list tuple int float str bool char auto var let elif then done when unless begin end".split(" "));
var DECLARATIONS2 = [
  [/\.(m?js|cjs|jsx|ts|tsx|mts|cts|vue|svelte)$/, /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)|^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm],
  [/\.pyi?$/, /^\s{0,4}(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm],
  [/\.go$/, /^(?:func\s+(?:\([^)\n]*\)\s*)?|type\s+)([A-Za-z_]\w*)/gm],
  [/\.rs$/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_]\w*)/gm],
  [/\.(java|kt|kts|cs|scala|swift)$/, /^\s{0,8}(?:(?:public|private|protected|internal|static|final|abstract|open|data|sealed|override)\s+)*(?:class|interface|enum|record|object|struct|fun|func|def|void|[\w<>\[\]]+)\s+([A-Za-z_]\w*)\s*[({<:]/gm],
  [/\.rb$/, /^\s*(?:def\s+(?:self\.)?|class\s+|module\s+)([A-Za-z_]\w*[?!]?)/gm],
  [/\.php$/, /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function|class|interface|trait)\s+([A-Za-z_]\w*)/gm],
  [/\.(c|cc|cpp|h|hpp)$/, /^(?:[A-Za-z_][\w\s\*]*\s)?\**([A-Za-z_]\w*)\s*\([^;]*$/gm]
];
var CONSTANT = /^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+|final\s+|static\s+)*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*[:=]/gm;
function listFiles(projectDir) {
  const git = spawnSync2("git", ["ls-files", "-co", "--exclude-standard"], { cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && git.stdout.trim()) {
    return git.stdout.split("\n").filter((f) => f && TEXT_EXT.test(f) && !f.split("/").some((p) => SKIP_DIR.has(p))).slice(0, MAX_FILES);
  }
  const out = [];
  const walk2 = (dir) => {
    let entries;
    try {
      entries = readdirSync3(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk2(join12(dir, e.name));
      } else if (e.isFile() && TEXT_EXT.test(e.name)) out.push(relative5(projectDir, join12(dir, e.name)).split(sep3).join("/"));
    }
  };
  walk2(projectDir);
  return out;
}
function entryFor(rel, text, size, mtime) {
  const defs = /* @__PURE__ */ new Set();
  for (const [ext, re] of DECLARATIONS2) {
    if (!ext.test(rel)) continue;
    for (const m of text.matchAll(re)) {
      const n = m[1] ?? m[2];
      if (n && n.length >= 3) defs.add(n);
    }
  }
  for (const m of text.matchAll(CONSTANT)) defs.add(m[1]);
  const words = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(WORD)) {
    if (words.size >= MAX_WORDS) break;
    if (!STOP2.has(m[0]) && !STOP2.has(m[0].toLowerCase())) words.add(m[0]);
  }
  return { size, mtime, defs: [...defs], words: [...words] };
}
function buildMap(projectDir, prev, skip) {
  const files = {};
  let read3 = 0, reused = 0;
  for (const rel of listFiles(projectDir)) {
    if (skip?.(rel)) continue;
    let st;
    try {
      st = statSync10(join12(projectDir, rel));
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const old = prev?.files[rel];
    if (old && old.size === st.size && old.mtime === st.mtimeMs) {
      files[rel] = old;
      reused++;
      continue;
    }
    let text;
    try {
      text = readFileSync10(join12(projectDir, rel), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    files[rel] = entryFor(rel, text, st.size, st.mtimeMs);
    read3++;
  }
  return { map: { version: 1, builtAt: (/* @__PURE__ */ new Date()).toISOString(), files }, read: read3, reused };
}
function requestNames(prompt) {
  const names = /* @__PURE__ */ new Set();
  for (const m of prompt.matchAll(WORD)) if (!STOP2.has(m[0].toLowerCase())) names.add(m[0]);
  const words = prompt.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [];
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (a.length < 3 || b.length < 2) continue;
    names.add(`${a}_${b}`);
    names.add(a + b[0].toUpperCase() + b.slice(1));
    names.add(a[0].toUpperCase() + a.slice(1) + b[0].toUpperCase() + b.slice(1));
  }
  return names;
}
function codeNames(request) {
  const out = /* @__PURE__ */ new Set();
  const prompt = request.replace(URL2, " ");
  const spans = [
    ...[...prompt.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]),
    ...prompt.split("\n").filter((l) => /^(\t| {4})|^\s*File "|^\s*(>>>|\$|In \[\d+\]:)/.test(l))
  ];
  for (const sp of spans) for (const m of sp.matchAll(WORD)) out.add(m[0]);
  for (const m of prompt.matchAll(/(?<=[.@])[A-Za-z_]\w{3,63}|[A-Za-z_]\w{3,63}(?=\()/g)) out.add(m[0]);
  for (const m of prompt.matchAll(WORD)) if (/_|\d|^[a-z]+[A-Z]/.test(m[0])) out.add(m[0]);
  return out;
}
function namedExactly(prompt, name) {
  if (!new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[$]/g, "\\$")}($|[^A-Za-z0-9_])`).test(prompt)) return false;
  return /[A-Z_0-9]/.test(name.slice(1)) || name.length >= 8 || /^[A-Z]/.test(name) && name.length >= 6;
}
function shouldSuggest(cs, prompt) {
  return cs.some((c) => c.defines.some((name) => namedExactly(prompt, name)));
}
function candidates(map, prompt, k = 15) {
  const paths = Object.keys(map.files);
  const N = paths.length;
  if (!N) return [];
  const asked = requestNames(prompt.replace(URL2, " "));
  const asCode = codeNames(prompt);
  const askedLower = /* @__PURE__ */ new Map();
  for (const a of asked) if (a.length >= 6) askedLower.set(a.toLowerCase(), a);
  const definedBy = /* @__PURE__ */ new Map();
  for (const p of paths) for (const d of map.files[p].defs) {
    if (asked.has(d) || askedLower.has(d.toLowerCase())) (definedBy.get(d) ?? definedBy.set(d, []).get(d)).push(p);
  }
  const usedBy = /* @__PURE__ */ new Map();
  for (const p of paths) for (const w of map.files[p].words) {
    if (asked.has(w) || w.length >= 6 && askedLower.has(w.toLowerCase())) (usedBy.get(w) ?? usedBy.set(w, []).get(w)).push(p);
  }
  const scored = /* @__PURE__ */ new Map();
  const add = (p, s, name, def) => {
    const c = scored.get(p) ?? { path: p, score: 0, defines: [], uses: [] };
    c.score += s;
    const list = def ? c.defines : c.uses;
    if (!list.includes(name)) list.push(name);
    scored.set(p, c);
  };
  for (const [name, users] of usedBy) {
    const defs = definedBy.get(name) ?? [];
    if (!defs.length && !asCode.has(name)) continue;
    if (/^[a-z]{1,4}$/.test(name)) continue;
    const linked = /* @__PURE__ */ new Set([...users, ...defs]);
    if (linked.size < 2 && !(defs.length && asked.has(name))) continue;
    if (linked.size > Math.max(25, N * 0.05)) continue;
    const idf = Math.log(1 + N / linked.size);
    for (const p of defs) add(p, 2 * idf, name, true);
    if (/^[a-z]+$/.test(name) && !asCode.has(name)) continue;
    for (const p of users) if (!defs.includes(p)) add(p, PROSE.test(p) ? idf * 0.3 : TESTS.test(p) ? idf * 0.5 : idf, name, false);
  }
  const lower = prompt.replace(URL2, " ").toLowerCase();
  for (const p of paths) {
    const stem = basename4(p, extname2(p)).toLowerCase();
    if (stem.length < 5) continue;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w.])${esc}\\.[a-z]{1,5}\\b|/${esc}\\b|\\b${esc} (module|file|package)\\b`).test(lower)) add(p, Math.log(1 + N), stem, true);
  }
  return [...scored.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k);
}
function renderCandidates(cs) {
  if (!cs.length) return "";
  const why = (c) => [c.defines.length ? `defines ${c.defines.slice(0, 3).join(", ")}` : "", c.uses.length ? `uses ${c.uses.slice(0, 3).join(", ")}` : ""].filter(Boolean).join("; ");
  return `snout map: files in this repo that define or use names in this request, most relevant first (candidates from a local index, not a plan): ${cs.map((c) => `${c.path} (${why(c)})`).join(" \xB7 ")}`;
}

// src/audit/mcp-servers.ts
import { existsSync as existsSync10, readdirSync as readdirSync4, readFileSync as readFileSync11, statSync as statSync11 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join13, resolve as resolve6 } from "node:path";
import { spawn } from "node:child_process";
var readJson = (path) => {
  try {
    return JSON.parse(readFileSync11(path, "utf8"));
  } catch {
    return null;
  }
};
function fromMap(map, source, agent) {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).map(([name, c]) => ({
    name,
    source,
    agent,
    command: typeof c?.command === "string" ? c.command : void 0,
    args: Array.isArray(c?.args) ? c.args.map(String) : void 0,
    env: c?.env && typeof c.env === "object" ? c.env : void 0,
    url: typeof c?.url === "string" ? c.url : typeof c?.httpUrl === "string" ? c.httpUrl : void 0
  }));
}
function codexServers(path) {
  let text = "";
  try {
    text = readFileSync11(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  const re = /^\s*\[mcp_servers\.("?)([^\]"]+)\1\]\s*$/gm;
  let m;
  while (m = re.exec(text)) out.push({ name: m[2], source: "Codex (user)", agent: "codex" });
  return out;
}
function configuredServers(projectDir, home = homedir5()) {
  const dir = resolve6(projectDir);
  const servers = [];
  servers.push(...fromMap(readJson(join13(dir, ".mcp.json"))?.mcpServers, "project .mcp.json", "claude"));
  const claude2 = readJson(join13(process.env.CLAUDE_CONFIG_DIR ? join13(process.env.CLAUDE_CONFIG_DIR, "..") : home, ".claude.json"));
  if (claude2) {
    servers.push(...fromMap(claude2.mcpServers, "Claude Code (user)", "claude"));
    servers.push(...fromMap(claude2.projects?.[dir]?.mcpServers, "Claude Code (this project)", "claude"));
    const disabled = claude2.projects?.[dir]?.disabledMcpjsonServers ?? [];
    for (let i = servers.length - 1; i >= 0; i--) if (servers[i].source === "project .mcp.json" && disabled.includes(servers[i].name)) servers.splice(i, 1);
  }
  servers.push(...fromMap(readJson(join13(dir, ".cursor", "mcp.json"))?.mcpServers, "Cursor (project)", "cursor"));
  servers.push(...fromMap(readJson(join13(home, ".cursor", "mcp.json"))?.mcpServers, "Cursor (user)", "cursor"));
  servers.push(...fromMap(readJson(join13(dir, ".gemini", "settings.json"))?.mcpServers, "Gemini CLI (project)", "gemini"));
  servers.push(...fromMap(readJson(join13(home, ".gemini", "settings.json"))?.mcpServers, "Gemini CLI (user)", "gemini"));
  servers.push(...codexServers(join13(process.env.CODEX_HOME || join13(home, ".codex"), "config.toml")));
  return servers;
}
function mcpUsage(projectDir, days = 30, home = homedir5()) {
  const root = join13(process.env.CLAUDE_CONFIG_DIR || join13(home, ".claude"), "projects", resolve6(projectDir).replace(/[^A-Za-z0-9]/g, "-"));
  const counts = /* @__PURE__ */ new Map();
  if (!existsSync10(root)) return counts;
  const since = Date.now() - days * 864e5;
  for (const f of readdirSync4(root)) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join13(root, f);
    try {
      if (statSync11(path).mtimeMs < since) continue;
      const text = readFileSync11(path, "utf8");
      const re = /"name":"mcp__([A-Za-z0-9_.-]+?)__[A-Za-z0-9_.-]+"/g;
      let m;
      while (m = re.exec(text)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    } catch {
    }
  }
  return counts;
}
var toolPrefixName = (name) => name.replace(/[^A-Za-z0-9_-]/g, "_");
var MEASURE_TIMEOUT_MS = Number(process.env.SNOUT_MCP_MEASURE_MS) || 1e4;
function measureServer(s, timeoutMs = MEASURE_TIMEOUT_MS) {
  if (!s.command) return Promise.resolve({ error: s.url ? "remote server: not measured" : "no command to start" });
  return new Promise((done) => {
    let settled = false;
    const finish2 = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      done(r);
    };
    const viaCmd = process.platform === "win32" && !/[\\/]|\.(exe|com)$/i.test(s.command);
    const [file2, argv] = viaCmd ? [process.env.ComSpec || "cmd.exe", ["/d", "/c", s.command, ...s.args ?? []]] : [s.command, s.args ?? []];
    const child = spawn(file2, argv, { env: { ...process.env, ...s.env ?? {} }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => finish2({ error: `no tool list within ${timeoutMs / 1e3}s` }), timeoutMs);
    child.on("error", (e) => finish2({ error: e.message.slice(0, 80) }));
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools) ? msg.result.tools : [];
          finish2({ tools: tools.length, listTokens: Math.round(JSON.stringify(tools).length / 4) });
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "snout-audit", version: "1" } } }) + "\n");
  });
}
async function auditServers(projectDir, opts = {}) {
  const servers = configuredServers(projectDir, opts.home);
  const usage = mcpUsage(projectDir, opts.days ?? 30, opts.home);
  const reports = servers.map((s) => ({ ...s, calls: s.agent === "claude" ? usage.get(toolPrefixName(s.name)) ?? 0 : null }));
  const known = new Set(servers.map((s) => toolPrefixName(s.name)));
  for (const [name, calls] of usage) {
    if (!known.has(name)) reports.push({ name, source: name.startsWith("claude_ai_") ? "Claude account connector" : "plugin or other config", agent: "claude", calls });
  }
  if (opts.measure) {
    await Promise.all(reports.map(async (r) => {
      const m = await measureServer(r);
      if ("error" in m) r.measureError = m.error;
      else Object.assign(r, m);
    }));
  }
  return reports;
}
function disableHint(r) {
  if (r.agent === "claude") return r.source === "project .mcp.json" ? `disable it in Claude Code's /mcp menu, or remove it from .mcp.json` : `claude mcp remove ${r.name}${r.source.includes("user") ? " -s user" : ""}`;
  if (r.agent === "cursor") return "turn it off in Cursor Settings \u2192 MCP";
  if (r.agent === "gemini") return "remove it from mcpServers in .gemini/settings.json";
  return `remove [mcp_servers.${r.name}] from ~/.codex/config.toml`;
}

// src/dashboard/repo.ts
var GROUPS = 8;
var TOP = 8;
var KINDS = 6;
var HEAD_BYTES2 = 6 * 1024;
var WHOLE = /* @__PURE__ */ new Set(["source", "always-allow", "secret", "reversal"]);
var isBulk = (label) => !WHOLE.has(label);
var SPLIT_SHARE = 0.35;
var MAX_DECLARERS = 4;
var LINKS = 14;
var first = (p) => p.includes("/") ? p.slice(0, p.indexOf("/")) : "/";
var second = (p) => {
  const parts = p.split("/");
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
};
function buildRepoView(listing, read3, labelOf2, map) {
  const files = listing.map(({ path, size }) => {
    const r = read3.get(path);
    const label = r && r.label !== "source" ? r.label : labelOf2(path, size);
    return {
      path,
      tokens: estimateTokens(size, path),
      label,
      sendTokens: estimateTokens(isBulk(label) ? Math.min(size, HEAD_BYTES2) : size, path),
      reads: r?.reads ?? 0,
      inContext: r?.inContext ?? 0,
      heldBack: r?.heldBack ?? 0,
      last: r?.last ?? null
    };
  });
  const total = files.reduce((a, f) => a + f.tokens, 0);
  const byTop = /* @__PURE__ */ new Map();
  for (const f of files) byTop.set(first(f.path), (byTop.get(first(f.path)) ?? 0) + f.tokens);
  const split = new Set([...byTop].filter(([k, t]) => k !== "/" && total > 0 && t / total > SPLIT_SHARE).map(([k]) => k));
  const groupOf = (p) => split.has(first(p)) ? second(p) : first(p);
  const groups = /* @__PURE__ */ new Map();
  for (const f of files) {
    const k = groupOf(f.path);
    const g = groups.get(k) ?? { key: k, files: 0, tokens: 0, bulk: 0, reads: 0, inContext: 0, heldBack: 0, top: [], kinds: [], all: [] };
    g.files += 1;
    g.tokens += f.tokens;
    if (isBulk(f.label)) g.bulk += f.tokens;
    g.reads += f.reads;
    g.inContext += f.inContext;
    g.heldBack += f.heldBack;
    g.all.push(f);
    groups.set(k, g);
  }
  const weight = (f) => f.heldBack * 4 + (isBulk(f.label) ? f.tokens * 2 : f.tokens);
  const ranked = [...groups.values()].sort((a, b) => b.heldBack + b.bulk - (a.heldBack + a.bulk) || b.tokens - a.tokens);
  const shown = ranked.slice(0, GROUPS).map(({ all, ...g }) => {
    const kinds = /* @__PURE__ */ new Map();
    for (const f of all) {
      const k = kinds.get(f.label) ?? { label: f.label, files: 0, tokens: 0, heldBack: 0 };
      k.files += 1;
      k.tokens += f.tokens;
      k.heldBack += f.heldBack;
      kinds.set(f.label, k);
    }
    return { ...g, top: all.sort((a, b) => weight(b) - weight(a)).slice(0, TOP), kinds: [...kinds.values()].sort((a, b) => b.tokens - a.tokens).slice(0, KINDS) };
  });
  return {
    files: files.length,
    tokens: total,
    bulk: files.reduce((a, f) => a + (isBulk(f.label) ? f.tokens : 0), 0),
    groups: shown,
    more: Math.max(0, ranked.length - shown.length),
    links: map ? linksOf(map, groupOf, new Set(shown.map((g) => g.key))) : [],
    mapBuiltAt: map?.builtAt ?? null
  };
}
function linksOf(map, groupOf, keep) {
  const declared = /* @__PURE__ */ new Map();
  for (const [path, e] of Object.entries(map.files)) {
    const g = groupOf(path);
    if (!keep.has(g)) continue;
    for (const d of e.defs) {
      const s = declared.get(d) ?? /* @__PURE__ */ new Set();
      s.add(g);
      declared.set(d, s);
    }
  }
  const pairs = /* @__PURE__ */ new Map();
  for (const [path, e] of Object.entries(map.files)) {
    const g = groupOf(path);
    if (!keep.has(g)) continue;
    for (const w of e.words) {
      const by = declared.get(w);
      if (!by || by.size > MAX_DECLARERS || by.has(g)) continue;
      for (const d of by) {
        const key = g < d ? `${g}\0${d}` : `${d}\0${g}`;
        const s = pairs.get(key) ?? /* @__PURE__ */ new Set();
        s.add(w);
        pairs.set(key, s);
      }
    }
  }
  return [...pairs].map(([key, names]) => {
    const [a, b] = key.split("\0");
    return { a, b, names: names.size, sample: [...names].sort((x, y) => y.length - x.length).slice(0, 3) };
  }).sort((x, y) => y.names - x.names).slice(0, LINKS);
}

// src/dashboard/file.ts
import { readFileSync as readFileSync12, statSync as statSync12 } from "node:fs";
import { isAbsolute as isAbsolute7, join as join14, relative as relative6, resolve as resolve7 } from "node:path";
var HEAD_LINES2 = 60;
var HEAD_BYTES3 = 6 * 1024;
var MAX_BYTES2 = 4 * 1024 * 1024;
function fileReport(projectDir, path, cfg) {
  const abs = resolve7(isAbsolute7(path) ? path : join14(projectDir, path));
  const rel = relative6(projectDir, abs).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute7(rel)) throw new Error("outside the project");
  const st = statSync12(abs);
  if (!st.isFile()) throw new Error("not a file");
  const d = tier0({ absPath: abs, projectDir, cfg });
  const label = d && d.value <= 1 ? d.rule : "source";
  const base = { path: rel, tokens: estimateTokens(st.size, rel), label, confidence: d?.confidence ?? 0, band: bandOf(d), reason: d?.reason ?? "" };
  if (label === "secret" || label === "binary" || label === "binary-content") return { ...base, lines: 0, head: null, outline: [], more: 0, hint: "" };
  const text = readFileSync12(abs, "utf8").slice(0, MAX_BYTES2);
  const lines = text.split("\n");
  const oneLine2 = st.size / Math.max(1, lines.length) > 1e3;
  let head = null;
  if (label !== "source" && !oneLine2) {
    let used = 0, n = 0;
    for (const l of lines.slice(0, HEAD_LINES2)) {
      if (used + l.length + 1 > HEAD_BYTES3) break;
      used += l.length + 1;
      n++;
    }
    head = { lines: n, tokens: estimateTokens(used, rel) };
  }
  const { items, more } = parseOutline(outline(rel, label, text), text, lines);
  const cmd = /`([^`]+)`/.exec(searchHint(label, rel, { oneLine: oneLine2 }))?.[1] ?? "";
  return { ...base, lines: lines.length, head, outline: items, more, hint: cmd };
}
function parseOutline(sentence, text, lines) {
  const more = Number(/\(\+(\d+) more\)/.exec(sentence)?.[1] ?? 0);
  if (sentence.includes("Direct dependencies")) {
    const body = sentence.slice(sentence.indexOf(":") + 1);
    const items2 = [];
    for (const m of body.matchAll(/(@?[\w.\/-]+) (\d+\.\d+\.\d+(?:[-+][\w.-]*[\w])?)/g)) {
      const at = text.indexOf(`"node_modules/${m[1]}"`);
      items2.push({ name: m[1], detail: m[2], line: at < 0 ? null : text.slice(0, at).split("\n").length, kind: "dependency" });
    }
    return { items: items2, more };
  }
  const items = [];
  for (const m of sentence.matchAll(/([A-Za-z_$][\w$]*) L(\d+)/g)) {
    const line = Number(m[2]);
    const src = lines[line - 1] ?? "";
    const kw = /\b(function|class|interface|type|enum|const|let|var|def|struct|trait|fn)\b/.exec(src)?.[1] ?? "";
    items.push({ name: m[1], detail: kw, line, kind: "declaration" });
  }
  return { items, more };
}

// src/dashboard/server.ts
var ROWS = 2e4;
var POLL_MS = 500;
var HEARTBEAT_MS = 15e3;
var SPEND_MS = 4e3;
var SPEND_DAYS = 30;
var REPO_MS = 6e4;
var AUDIT_MS = 10 * 6e4;
var CLASSIFY_MIN_BYTES = 4096;
function startDashboard(paths, opts) {
  const streams = /* @__PURE__ */ new Set();
  const key = randomBytes(24).toString("base64url");
  const page = PAGE.replace("__SNOUT_KEY__", key);
  let version = "";
  let cache2 = /* @__PURE__ */ new Map();
  const stamp = () => {
    try {
      const s = statSync13(paths.ledger);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "none";
    }
  };
  let spend = null;
  const readSpendNow = () => {
    try {
      const since = new Date(Date.now() - (SPEND_DAYS - 1) * 864e5).toISOString().slice(0, 10);
      const rows = [...readSpend(paths.projectDir, join15(paths.snoutDir, "spend-cache.json"), configDir()).values()].flat();
      const next = summarizeSpend(rows, since);
      const changed = !spend || next.requests !== spend.requests || next.costUsd !== spend.costUsd;
      spend = next;
      return changed;
    } catch {
      return false;
    }
  };
  readSpendNow();
  let listing = [];
  let listedAt = 0;
  let repoMap = null;
  let mapStamp = "";
  const labels = /* @__PURE__ */ new Map();
  let cfg = null;
  const labelOf2 = (path, size) => {
    if (size < CLASSIFY_MIN_BYTES) return "source";
    const key2 = `${path}:${size}`;
    let l = labels.get(key2);
    if (l === void 0) {
      try {
        cfg ??= loadConfig(paths);
        const d = tier0({ absPath: join15(paths.projectDir, path), projectDir: paths.projectDir, cfg });
        l = d && d.value <= 1 ? d.rule : "source";
      } catch {
        l = "source";
      }
      labels.set(key2, l);
    }
    return l;
  };
  const repoView = (s) => {
    try {
      if (Date.now() - listedAt > REPO_MS) {
        listedAt = Date.now();
        const seen = /* @__PURE__ */ new Set();
        const next = [];
        for (const p of [...listFiles(paths.projectDir), ...s.readFiles.map((f) => f.key)]) {
          if (seen.has(p) || isAbsolute8(p) || p.startsWith("..")) continue;
          seen.add(p);
          try {
            const st = statSync13(join15(paths.projectDir, p));
            if (st.isFile()) next.push({ path: p, size: st.size });
          } catch {
          }
        }
        listing = next;
        try {
          const st = statSync13(paths.map);
          const v = `${st.size}:${st.mtimeMs}`;
          if (v !== mapStamp) {
            mapStamp = v;
            repoMap = JSON.parse(readFileSync13(paths.map, "utf8"));
          }
        } catch {
          repoMap = null;
        }
      }
      const read3 = new Map(s.readFiles.map((f) => [f.key, f]));
      return buildRepoView(listing, read3, labelOf2, repoMap);
    } catch {
      return null;
    }
  };
  let agentFiles = null;
  let mcpConfig = null;
  let auditedAt = 0;
  function agentFilesNow() {
    const rows = readDecisions(paths.ledger, ROWS).map((r) => ({ path: r.path, ts: r.ts }));
    const a = auditContext(paths.projectDir, { days: 30, ledger: rows });
    const t = totals(a);
    return {
      files: a.files.slice().sort((x, y) => y.perSession - x.perSession || y.tokens - x.tokens).slice(0, 16).map((f) => ({ path: f.path, role: f.role, kind: f.kind, agents: f.agents, tokens: f.tokens, perSession: f.perSession, uses: f.uses, savePerSession: f.savePerSession, flags: f.flags.map((x) => ({ code: x.code, reason: x.reason, action: x.action })) })),
      count: a.files.length,
      alwaysPerSession: t.always.perSession,
      flagged: t.flagged,
      savePerSession: t.savePerSession
    };
  }
  const audit = () => {
    if (Date.now() - auditedAt < AUDIT_MS) return;
    auditedAt = Date.now();
    setTimeout(() => {
      try {
        agentFiles = agentFilesNow();
      } catch {
        agentFiles = null;
      }
      auditServers(paths.projectDir, { days: 30 }).then((r) => {
        mcpConfig = r.map((x) => ({ name: x.name, source: x.source, agent: x.agent, calls: x.calls }));
      }).catch(() => {
        mcpConfig = null;
      }).finally(() => {
        cache2 = /* @__PURE__ */ new Map();
        for (const st of streams) send(st.res, st.session);
      });
    }, 50);
  };
  const summary = (session) => {
    const v = stamp();
    if (v !== version) {
      version = v;
      cache2 = /* @__PURE__ */ new Map();
    }
    const key2 = session ?? "";
    let s = cache2.get(key2);
    if (!s) {
      const rows = readDecisions(paths.ledger, ROWS);
      s = summarizeLedger(session ? rows.filter((r) => r.session === session) : rows);
      cache2.set(key2, s);
    }
    const sessions = session ? summarizeLedger(readDecisions(paths.ledger, ROWS)).sessions : s.sessions;
    audit();
    return {
      ...s,
      readFiles: [],
      repo: repoView(s),
      agentFiles,
      mcpConfig,
      sessions,
      meta: {
        project: basename5(paths.projectDir),
        mode: opts.actions?.mode() ?? opts.mode,
        version: opts.version,
        session,
        coach: opts.actions?.coach() ?? null,
        cloud: opts.actions?.cloud() ?? null,
        controls: !!opts.actions
      },
      spend: spend && spend.requests ? { ...spend, days: SPEND_DAYS, pricesAsOf: PRICES_AS_OF } : null
    };
  };
  const send = (res, session) => {
    res.write(`event: summary
data: ${JSON.stringify(summary(session))}

`);
  };
  let last = stamp();
  const onChange = () => {
    const now = stamp();
    if (now === last) return;
    last = now;
    for (const s of streams) send(s.res, s.session);
  };
  watchFile(paths.ledger, { interval: POLL_MS, persistent: true }, onChange);
  const heartbeat = setInterval(() => {
    for (const s of streams) s.res.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);
  const spendTimer = setInterval(() => {
    if (streams.size && readSpendNow()) for (const s of streams) send(s.res, s.session);
  }, SPEND_MS);
  let port = opts.port;
  const { createServer } = createRequire(import.meta.url)("node:http");
  const server = createServer((req, res) => handle2(req, res));
  function handle2(req, res) {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const session = url.searchParams.get("session") || null;
    const common = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (req.method !== "GET" && !(req.method === "POST" && url.pathname === "/api/action")) {
      res.writeHead(405, common).end();
    } else if (url.pathname === "/") {
      res.writeHead(200, {
        ...common,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:"
      }).end(page);
    } else if (url.pathname === "/api/summary") {
      res.writeHead(200, { ...common, "content-type": "application/json" }).end(JSON.stringify(summary(session)));
    } else if (url.pathname === "/api/file") {
      try {
        cfg ??= loadConfig(paths);
        const body = fileReport(paths.projectDir, url.searchParams.get("path") ?? "", cfg);
        res.writeHead(200, { ...common, "content-type": "application/json" }).end(JSON.stringify(body));
      } catch {
        res.writeHead(404, { ...common, "content-type": "application/json" }).end(JSON.stringify({ error: "no such file in this project" }));
      }
    } else if (url.pathname === "/api/action" && req.method === "POST") {
      return void action(req, res, common);
    } else if (url.pathname === "/events") {
      res.writeHead(200, { ...common, "content-type": "text/event-stream", connection: "keep-alive" });
      res.write("retry: 1500\n\n");
      const entry = { res, session };
      streams.add(entry);
      send(res, session);
      req.on("close", () => streams.delete(entry));
    } else {
      res.writeHead(404, { ...common, "content-type": "text/plain" }).end("not found");
    }
  }
  async function action(req, res, common) {
    const reply = (status, body) => {
      res.writeHead(status, { ...common, "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const given = Buffer.from(String(req.headers["x-snout-key"] ?? ""));
    const want = Buffer.from(key);
    if (!opts.actions || given.length !== want.length || !timingSafeEqual(given, want)) return reply(403, { error: "forbidden" });
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 4096) return reply(413, { error: "too large" });
    }
    let a;
    try {
      a = JSON.parse(raw || "{}");
    } catch {
      return reply(400, { error: "invalid json" });
    }
    const act = opts.actions;
    try {
      const message = a.type === "mode" ? act.setMode(String(a.value)) : a.type === "allow" ? act.allow(String(a.path)) : a.type === "coach" ? act.setCoach(String(a.value)) : a.type === "login" ? act.login() : null;
      if (message === null) return reply(400, { error: "unknown action" });
      cache2 = /* @__PURE__ */ new Map();
      reply(200, { ok: true, message });
      for (const st of streams) send(st.res, st.session);
    } catch (err) {
      reply(500, { error: err.message.slice(0, 200) });
    }
  }
  let tries = 0;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && opts.port !== 0 && tries < 20) {
      tries += 1;
      port += 1;
      server.listen(port, "127.0.0.1");
      return;
    }
    throw err;
  });
  server.on("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") port = addr.port;
    opts.onListen(`http://127.0.0.1:${port}/`);
  });
  server.listen(port, "127.0.0.1");
  return {
    close() {
      unwatchFile(paths.ledger, onChange);
      clearInterval(heartbeat);
      clearInterval(spendTimer);
      for (const s of streams) s.res.end();
      server.close();
    }
  };
}

// src/dashboard/registry.ts
import { existsSync as existsSync11, mkdirSync as mkdirSync7, readFileSync as readFileSync14 } from "node:fs";
import { dirname as dirname8, join as join16, resolve as resolve8 } from "node:path";
var file = (configDir2) => join16(configDir2, "dashboards.json");
function read(configDir2) {
  try {
    return JSON.parse(readFileSync14(file(configDir2), "utf8"));
  } catch {
    return {};
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function liveDashboard(configDir2, projectDir) {
  const e = read(configDir2)[resolve8(projectDir)];
  return e && alive(e.pid) ? e : null;
}
function registerDashboard(configDir2, projectDir, entry) {
  try {
    const all = read(configDir2);
    for (const [k, v] of Object.entries(all)) if (!alive(v.pid)) delete all[k];
    all[resolve8(projectDir)] = entry;
    const f = file(configDir2);
    if (!existsSync11(dirname8(f))) mkdirSync7(dirname8(f), { recursive: true });
    writeAtomic(f, JSON.stringify(all, null, 2) + "\n");
  } catch {
  }
}

// src/cli.ts
import { createRequire as createRequire2 } from "node:module";

// src/replay/replay.ts
import { existsSync as existsSync13, mkdirSync as mkdirSync8, mkdtempSync, readFileSync as readFileSync16, rmSync as rmSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirname9, isAbsolute as isAbsolute10, join as join18, relative as relative8, sep as sep5 } from "node:path";

// src/compact/memory.ts
import { closeSync as closeSync3, existsSync as existsSync12, openSync as openSync3, readFileSync as readFileSync15, readSync as readSync3, statSync as statSync14 } from "node:fs";
import { isAbsolute as isAbsolute9, join as join17, relative as relative7, resolve as resolve9, sep as sep4 } from "node:path";
var TAIL_BYTES = 16 * 1024 * 1024;
var HEAD_BYTES4 = 2 * 1024 * 1024;
var MAX_CHARS = 6e3;
var TEST = /\b(pytest|runtests\.py|bin\/test|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm test|yarn test|node --test|rspec|phpunit|tox|unittest)\b/;
var RAN = /\b\d+ (passed|failed|errors?|skipped)\b|\bRan \d+ tests?\b|tests finished|^OK\b|\bOK \(|^FAILED\b|\bTests?:\s+\d+/m;
var NOT_RUNNER = /* @__PURE__ */ new Set(["cat", "grep", "rg", "sed", "awk", "head", "tail", "echo", "printf", "ls", "find", "pip", "pip3", "conda", "apt", "apt-get", "brew", "which", "type", "man"]);
function testCommand(command, projectDir) {
  const noHeredoc = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "");
  const segments = [];
  let text = "", bare = "", quote = "";
  const flush = () => {
    if (text.trim()) segments.push({ text: text.trim(), bare: bare.trim() });
    text = "";
    bare = "";
  };
  for (let i = 0; i < noHeredoc.length; i++) {
    const ch = noHeredoc[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        text += ch + (noHeredoc[++i] ?? "");
        continue;
      }
      text += ch;
      if (ch === quote) {
        quote = "";
        bare += '""';
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      text += ch;
      continue;
    }
    const two = noHeredoc.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flush();
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      flush();
      continue;
    }
    text += ch;
    bare += ch;
  }
  flush();
  const runs = [];
  let cd;
  for (const s of segments) {
    const words = s.bare.split(/\s+/);
    if (words[0] === "cd") {
      cd = s.text.slice(2).trim().replace(/^['"]|['"]$/g, "");
      continue;
    }
    while (words.length && (/^\w+=/.test(words[0]) || words[0] === "timeout" || /^\d+[smh]?$/.test(words[0]))) words.shift();
    if (!words.length || NOT_RUNNER.has(words[0]) || !TEST.test(s.bare)) continue;
    let run = s.text.replace(/\s*2>&1\s*$/, "").split(`${projectDir}/`).join("");
    if (cd) {
      const abs = isAbsolute9(cd) ? cd : resolve9(projectDir, cd);
      const r = relative7(projectDir, abs).split(sep4).join("/");
      if (r) run = `cd ${r.startsWith("..") ? cd : r} && ${run}`;
    }
    runs.push(run);
  }
  return runs.length ? runs.join(" && ") : void 0;
}
var MISSING = [
  [/No module named ['"]?([\w.]+)['"]?/, (m) => m[1]],
  [/(?:^|\s)([\w.-]+): command not found/m, (m) => m[1]],
  [/command not found: ([\w.-]+)/, (m) => m[1]]
];
var EDITS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function firstRequest(file2) {
  const fd = openSync3(file2, "r");
  const buf = Buffer.alloc(Math.min(HEAD_BYTES4, statSync14(file2).size));
  try {
    readSync3(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync3(fd);
  }
  for (const line of buf.toString("utf8").split("\n")) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const text = userText(o);
    const request = text === void 0 ? void 0 : requestText(text.replace(/<issue>[\s\S]*?(<\/issue>|$)/g, " "));
    if (request) return request;
  }
  return void 0;
}
function tail(file2) {
  const size = statSync14(file2).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync3(file2, "r");
  try {
    readSync3(fd, buf, 0, buf.length, start);
  } finally {
    closeSync3(fd);
  }
  const text = buf.toString("utf8");
  return start ? text.slice(text.indexOf("\n") + 1) : text;
}
var oneLine = (s, n) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
};
var resultText = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("\n") : "";
var SLOW = /did not complete within its \d+s timeout|moved to the background/;
function projectModule(name, projectDir) {
  if (name.includes(".")) return true;
  return existsSync12(join17(projectDir, name)) || existsSync12(join17(projectDir, `${name}.py`));
}
function requestText(text) {
  const t = text.trim();
  if (!t || /^<(command-|local-command|system-reminder)/.test(t)) return void 0;
  const own = t.replace(/<\\?pasted_content\b[^>]*>[\s\S]*?(<\\?\/pasted_content>|$)/g, " ").replace(/\[Image #\d+\]/g, " ").replace(/\s+/g, " ").trim();
  const letters = own.replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, "").length;
  return own.length >= 3 && letters / own.replace(/\s+/g, "").length >= 0.6 && !/(.)\1{5,}/.test(own) ? own : void 0;
}
var INSTRUCTION = /^(?:(?:please|also|and|but|so|ok(?:ay)?|now|then|again|remember|note)[,:]?\s+)*(always|never|don'?t|do not|must|only|make sure|ensure|avoid|keep|no new|ask (?:me )?(?:first|before)|use|run|stop|leave|strip|remove|commit|push)\b/i;
var MAX_RULES = 12;
var ERROR_LINE = /^(?:[\w.]+(?:Error|Exception)\b(?::.*)?|(?:FAILED|ERROR) [\w./:\[\]-]+.*|(?:FAIL|ERROR): \w+ \(.*|error\[\w+\]: .+|[^\s:]+:\d+(?::\d+)?: error: .+|(?:\S+:\s+)?error TS\d+: .+)$/;
var PASSED = (verdict) => RAN.test(verdict) && !/\b[1-9]\d* (failed|errors?)\b|FAILED|\b(failures|errors)=\d/i.test(verdict);
function errorLine(out) {
  const lines = out.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i])) return lines[i];
  return void 0;
}
var RULE_CHARS = 1600;
function instructions(request) {
  return request.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length >= 15 && x.length <= 300 && !x.endsWith("?") && INSTRUCTION.test(x));
}
function userText(o) {
  const content = o.message?.content;
  if (o.type === "attachment" && o.attachment?.type === "queued_command" && typeof o.attachment.prompt === "string") return o.attachment.prompt;
  if (o.type !== "user" || o.isMeta || o.isCompactSummary || o.isSidechain) return void 0;
  return typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
}
function sessionFacts(transcriptPath, projectDir) {
  const rel = (p) => {
    if (!isAbsolute9(p)) return p;
    const r = relative7(projectDir, p);
    return r && !r.startsWith("..") && !isAbsolute9(r) ? r.split(sep4).join("/") : p;
  };
  const facts = { rules: [], missing: [], slow: [], changed: [], todos: [] };
  const uses = /* @__PURE__ */ new Map();
  if (statSync14(transcriptPath).size > TAIL_BYTES) {
    const first2 = firstRequest(transcriptPath);
    if (first2) facts.goal = oneLine(first2, 600);
  }
  for (const line of tail(transcriptPath).split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    const content = o.message?.content;
    const text = userText(o);
    if (text !== void 0) {
      const request = requestText(text.replace(/<issue>[\s\S]*?(<\/issue>|$)/g, " "));
      if (request) {
        facts.goal ??= oneLine(request, 600);
        facts.request = oneLine(request, 400);
        for (const r of instructions(request)) {
          const key = r.toLowerCase();
          facts.rules = [...facts.rules.filter((x) => x.toLowerCase() !== key), r];
        }
      }
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use") {
        uses.set(b.id, b);
        const file2 = b.input?.file_path ?? b.input?.notebook_path;
        if (EDITS.has(b.name) && typeof file2 === "string") {
          const p = rel(file2);
          facts.changed = [p, ...facts.changed.filter((x) => x !== p)];
        }
        if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) facts.todos = b.input.todos.filter((t) => t?.status !== "completed").map((t) => oneLine(String(t.content ?? ""), 120));
        continue;
      }
      if (b.type !== "tool_result") continue;
      const use = uses.get(b.tool_use_id);
      if (use?.name !== "Bash") continue;
      const command = String(use.input?.command ?? "");
      const out = resultText(b.content);
      const slowTest = SLOW.test(out) ? testCommand(command, projectDir) : void 0;
      if (slowTest) {
        const c = oneLine(slowTest, 160);
        facts.slow = [c, ...facts.slow.filter((x) => x !== c)].slice(0, 3);
      }
      let missing = false;
      for (const [re, name] of MISSING) {
        const m = out.match(re);
        if (!m) continue;
        const n = name(m);
        if (projectModule(n, projectDir)) continue;
        missing = true;
        facts.missing = [{ name: n, evidence: oneLine(m[0], 80) }, ...facts.missing.filter((x) => x.name !== n)];
      }
      const runner = !missing && RAN.test(out) ? testCommand(command, projectDir) : void 0;
      let verdict = "";
      if (runner) {
        const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
        verdict = [...lines].reverse().find((l) => RAN.test(l)) ?? "";
        facts.test = { command: oneLine(runner, 200), result: oneLine(verdict, 120) };
      }
      const prints = NOT_RUNNER.has(command.trim().split(/\s+/)[0] ?? "");
      const err = missing || prints ? void 0 : errorLine(out);
      const cmd = oneLine(command, 160);
      if (err && !(runner && PASSED(verdict))) facts.error = { line: oneLine(err, 200), command: cmd };
      else if (runner && PASSED(verdict) || facts.error?.command === cmd) facts.error = void 0;
    }
  }
  if (facts.test) facts.missing = facts.missing.filter((m) => !facts.test.command.includes(m.name));
  const projectFirst = (list) => [...list.filter((p) => !isAbsolute9(p)), ...list.filter((p) => isAbsolute9(p))];
  facts.changed = projectFirst(facts.changed);
  facts.missing = facts.missing.slice(0, 5);
  const kept = [];
  let chars = 0;
  for (const r of [...facts.rules].reverse()) {
    if (kept.length >= MAX_RULES || chars + r.length > RULE_CHARS) break;
    kept.unshift(r);
    chars += r.length;
  }
  facts.rules = kept;
  return facts;
}
function readPins(projectDir, snoutDir) {
  const file2 = join17(snoutDir, "pins.md");
  if (!existsSync12(file2)) return [];
  const pins = [];
  for (const raw of readFileSync15(file2, "utf8").split("\n")) {
    const m = raw.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!m) continue;
    const text = m[1];
    const reread = Number(text.match(/\[re-?read (\d+)\]/i)?.[1] ?? 0) || void 0;
    const first2 = text.match(/^`([^`]+)`|^(\S+)/);
    const candidate = first2?.[1] ?? first2?.[2] ?? "";
    const looksLikePath = !/^https?:/.test(candidate) && (first2?.[1] !== void 0 || /[/\\]|^\.\w|\.\w{1,10}$/.test(candidate));
    pins.push(looksLikePath ? { text, path: candidate, reread: reread ? Math.min(reread, 40) : void 0 } : { text });
    if (pins.length >= 10) break;
  }
  return pins;
}
function pinLines(pins, projectDir, secrets) {
  const out = [];
  for (const p of pins) {
    out.push(`- ${p.text.replace(/\s*\[re-?read \d+\]/i, "")}`);
    if (!p.path || !p.reread) continue;
    const abs = isAbsolute9(p.path) ? p.path : resolve9(projectDir, p.path);
    if (!existsSync12(abs)) {
      out.push(`  (not on disk now: ${p.path})`);
      continue;
    }
    const rel = relative7(projectDir, abs);
    const asPattern = rel && !rel.startsWith("..") ? rel : abs.replace(/^\/+/, "");
    if (secrets && matchesAny(asPattern, secrets.redact) && !matchesAny(asPattern, secrets.redactExempt)) {
      out.push("  (contents not restored: the file matches a credential pattern)");
      continue;
    }
    try {
      const lines = readFileSync15(abs, "utf8").split("\n").slice(0, p.reread);
      out.push("  ```", ...lines.map((l) => `  ${l.slice(0, 200)}`), "  ```");
    } catch {
      out.push(`  (could not read ${p.path})`);
    }
  }
  return out;
}
var PROGRESS_FILE = "progress.md";
var PROGRESS_MAX_CHARS = 1500;
var PROGRESS_ASK = "- Keep `.snout/progress.md` current while you work, at most 10 lines: the goal, your current approach, what failed and why, the next step. Snout restores it verbatim after the next compaction.";
function sessionStartMs(transcriptPath) {
  try {
    const fd = openSync3(transcriptPath, "r");
    const buf = Buffer.alloc(64 * 1024);
    let n = 0;
    try {
      n = readSync3(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync3(fd);
    }
    const t = Date.parse(buf.toString("utf8", 0, n).match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
    return Number.isFinite(t) ? t : statSync14(transcriptPath).birthtimeMs || 0;
  } catch {
    return 0;
  }
}
function readProgress(snoutDir, sinceMs) {
  const file2 = join17(snoutDir, PROGRESS_FILE);
  try {
    if (statSync14(file2).mtimeMs < sinceMs) return void 0;
    const text = readFileSync15(file2, "utf8").trim();
    return text ? text.length > PROGRESS_MAX_CHARS ? `${text.slice(0, PROGRESS_MAX_CHARS - 1)}\u2026` : text : void 0;
  } catch {
    return void 0;
  }
}
function memoryText(facts, pins, projectDir, secrets, progress) {
  const sections = [];
  if (progress) sections.push(["Your progress notes (.snout/progress.md, written before the compaction):", ...progress.split("\n").slice(0, 25)]);
  if (facts.rules?.length) sections.push(["Your instructions this session, verbatim (oldest first; where two conflict, the later one holds):", ...facts.rules.map((r) => `- ${r}`)]);
  if (pins.length) sections.push(["Pinned for this project:", ...pinLines(pins, projectDir, secrets)]);
  const f = [];
  if (facts.test) f.push(`- Tests run here with: \`${facts.test.command}\`${facts.test.result ? ` (last result: ${facts.test.result})` : ""}`);
  for (const m of facts.missing) f.push(`- Not available here: ${m.name} (${m.evidence})`);
  for (const c of facts.slow) f.push(`- Ran past the 2-minute tool limit here (prefer narrower tests): \`${c}\``);
  if (facts.error) f.push(`- Last error, not yet followed by a passing run: ${facts.error.line} (from \`${facts.error.command}\`)`);
  if (facts.goal && facts.goal !== facts.request) f.push(`- First request this session: ${facts.goal}`);
  if (facts.request) f.push(`- Current request: ${facts.request}`);
  if (facts.todos.length) f.push(`- Open to-dos: ${facts.todos.slice(0, 6).join("; ")}`);
  const head = "Snout restored these exact facts after compaction (from this session and .snout/pins.md):";
  const room = MAX_CHARS - head.length - PROGRESS_ASK.length - 2;
  const render = () => [...sections, ...f.length ? [["From this session:", ...f]] : []].flat().join("\n");
  if (facts.changed.length) {
    const label = "- Files changed this session: ";
    let left = room - render().length - 1 - label.length - (f.length ? 0 : "From this session:\n".length);
    const listed = [];
    for (const p of facts.changed) {
      const cost = p.length + (listed.length ? 2 : 0);
      if (cost > left) break;
      listed.push(p);
      left -= cost;
    }
    if (listed.length) f.push(`${label}${listed.join(", ")}${listed.length < facts.changed.length ? ` (and ${facts.changed.length - listed.length} more)` : ""}`);
  }
  let body = render();
  if (!body) return "";
  if (body.length > room) body = `${body.slice(0, room - 1)}\u2026`;
  return [head, body, PROGRESS_ASK].join("\n");
}

// src/replay/replay.ts
var tokens = (text) => estimateTokens(Buffer.byteLength(text), "output.txt");
var textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => typeof p?.text === "string" ? p.text : "").join("\n") : "";
var EDITS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var withoutCd = (c) => c.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "");
function readLines(file2) {
  const out = [];
  for (const raw of readFileSync16(file2, "utf8").split("\n")) {
    if (!raw) continue;
    try {
      out.push({ o: JSON.parse(raw), raw });
    } catch {
    }
  }
  return out;
}
function projectOf(lines) {
  const counts = /* @__PURE__ */ new Map();
  for (const { o } of lines) if (typeof o.cwd === "string") counts.set(o.cwd, (counts.get(o.cwd) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? process.cwd();
}
function shadowProject(lines, projectDir) {
  const root = mkdtempSync(join18(tmpdir(), "snout-replay-project-"));
  const best = /* @__PURE__ */ new Map();
  for (const { o } of lines) {
    const f = o.toolUseResult?.file;
    if (!f || typeof f.filePath !== "string" || typeof f.content !== "string") continue;
    const r = relative8(projectDir, f.filePath);
    if (!r || r.startsWith("..") || isAbsolute10(r)) continue;
    const prev = best.get(r);
    if (!prev || f.content.length > prev.content.length) best.set(r, { content: f.content, start: Number(f.startLine) || 1, total: Number(f.totalLines) || 0 });
  }
  for (const [r, f] of best) {
    const known = f.content.split("\n");
    const avg = Math.max(1, Math.round(f.content.length / Math.max(1, known.length)));
    const filler = "x".repeat(avg);
    const total = Math.max(f.total, f.start - 1 + known.length);
    const out = Array.from({ length: total }, (_, i) => i >= f.start - 1 && i < f.start - 1 + known.length ? known[i - f.start + 1] : filler);
    const dest = join18(root, r);
    mkdirSync8(dirname9(dest), { recursive: true });
    writeFileSync5(dest, out.join("\n"));
  }
  return { root, files: best.size };
}
function replaySession(file2, run) {
  const lines = readLines(file2).filter(({ o }) => !o.isSidechain);
  const projectDir = projectOf(lines);
  const shadow = existsSync13(projectDir) ? null : shadowProject(lines, projectDir);
  const onDisk = (v) => {
    if (!shadow) return v;
    if (typeof v === "string") return v.split(projectDir).join(shadow.root);
    if (Array.isArray(v)) return v.map(onDisk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, onDisk(x)]));
    return v;
  };
  const session = String(lines.find(({ o }) => o.sessionId)?.o.sessionId ?? file2);
  const rel = (p) => {
    if (!isAbsolute10(p)) return p;
    const r2 = relative8(projectDir, p);
    return r2 && !r2.startsWith("..") && !isAbsolute10(r2) ? r2.split(sep5).join("/") : p;
  };
  const r = {
    session,
    file: file2,
    projectDir,
    rebuilt: shadow?.files ?? 0,
    calls: 0,
    requests: 0,
    inputTokens: 0,
    keptOut: 0,
    carried: 0,
    denied: 0,
    narrowed: 0,
    repeats: 0,
    asked: 0,
    trimmed: 0,
    added: 0,
    regrets: 0,
    interventions: 0,
    compactions: 0,
    memory: { withTest: 0, testUsed: 0, testMissed: 0, editsAfter: 0, editsListed: 0, chars: 0 },
    examples: { regret: [], kept: [] }
  };
  const seenReq = /* @__PURE__ */ new Set();
  const reqAt = [];
  const boundaries = [];
  lines.forEach(({ o }, i) => {
    if (o.subtype === "compact_boundary") boundaries.push(i);
    const u = o.message?.usage;
    if (!u || o.type !== "assistant") return;
    const id = String(o.requestId ?? o.message?.id ?? i);
    if (seenReq.has(id)) return;
    seenReq.add(id);
    reqAt.push(i);
    r.inputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  });
  r.requests = reqAt.length;
  r.compactions = boundaries.length;
  const laterRequests = (i) => {
    const end = boundaries.find((b) => b > i) ?? Infinity;
    return reqAt.filter((x) => x > i && x < end).length;
  };
  const keep = (i, saved, label) => {
    if (saved <= 0) return;
    r.keptOut += saved;
    r.carried += saved * laterRequests(i);
    if (r.examples.kept.length < 5) r.examples.kept.push(`${label} (~${saved} tokens)`);
  };
  const heldPaths = /* @__PURE__ */ new Map();
  const trimmedCommands = [];
  const uses = /* @__PURE__ */ new Map();
  let callIndex = 0;
  lines.forEach(({ o }, i) => {
    const content = o.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") {
        r.calls++;
        callIndex++;
        const input = { hook_event_name: "PreToolUse", session_id: session, cwd: onDisk(o.cwd ?? projectDir), tool_name: b.name, tool_input: onDisk(b.input ?? {}), tool_use_id: b.id, transcript_path: file2 };
        const path2 = typeof b.input?.file_path === "string" ? b.input.file_path : typeof b.input?.notebook_path === "string" ? b.input.notebook_path : void 0;
        if (path2 && heldPaths.has(path2)) {
          r.regrets++;
          if (r.examples.regret.length < 5) r.examples.regret.push(`${b.name} ${rel(path2)} after Snout held it back (${heldPaths.get(path2)})`);
          heldPaths.delete(path2);
        }
        if (b.name === "Bash" && typeof b.input?.command === "string") {
          const c = b.input.command;
          const hit = trimmedCommands.findIndex((t) => callIndex - t.at <= 5 && withoutCd(c).includes(t.key));
          if (hit >= 0) {
            r.regrets++;
            if (r.examples.regret.length < 5) r.examples.regret.push(`re-ran \`${trimmedCommands[hit].label}\` within 5 calls of a trim`);
            trimmedCommands.splice(hit, 1);
          }
        }
        uses.set(b.id, { name: b.name, input: b.input ?? {}, at: callIndex, pre: run.pre(input) });
        continue;
      }
      if (b?.type !== "tool_result") continue;
      const use = uses.get(b.tool_use_id);
      if (!use) continue;
      const resultText2 = textOf(b.content);
      const resultTokens = tokens(resultText2);
      const pre = use.pre?.hookSpecificOutput;
      const path = typeof use.input.file_path === "string" ? use.input.file_path : void 0;
      if (pre?.permissionDecision === "deny") {
        r.denied++;
        r.interventions++;
        const reason = String(pre.permissionDecisionReason ?? "");
        keep(i, resultTokens - tokens(reason), `${use.name} ${path ? rel(path) : ""} held back`);
        if (path) heldPaths.set(path, reason.slice(0, 80));
        continue;
      }
      const upd = pre?.updatedInput;
      if (pre?.permissionDecision === "allow" && upd && typeof upd.limit === "number" && path) {
        const file3 = o.toolUseResult?.file;
        const full = typeof file3?.content === "string" ? file3.content : resultText2;
        const from = Math.max(0, (Number(upd.offset) || 1) - (Number(file3?.startLine) || 1));
        const slice = full.split("\n").slice(from, from + upd.limit).join("\n");
        const note = typeof pre.additionalContext === "string" ? pre.additionalContext : "";
        const saved = tokens(full) - tokens(slice) - tokens(note);
        if (/is unchanged since you read/.test(note)) {
          r.repeats++;
          keep(i, saved, `${use.name} ${rel(path)} repeat read`);
          continue;
        }
        r.narrowed++;
        r.interventions++;
        keep(i, saved, `${use.name} ${rel(path)} narrowed to ${upd.limit} lines`);
        heldPaths.set(path, `narrowed to ${upd.limit} lines`);
        continue;
      }
      if (typeof pre?.additionalContext === "string") r.added += tokens(pre.additionalContext);
      if (pre?.permissionDecision === "ask") r.asked++;
      const response = o.toolUseResult ?? { stdout: resultText2, stderr: "", interrupted: false, isImage: false };
      const postInput = { hook_event_name: "PostToolUse", session_id: session, cwd: onDisk(o.cwd ?? projectDir), tool_name: use.name, tool_input: onDisk(use.input), tool_use_id: b.tool_use_id, tool_response: onDisk(response), transcript_path: file2 };
      if (use.name === "Bash" || use.name.startsWith("mcp__")) {
        const sq = run.squeeze(postInput)?.hookSpecificOutput;
        const updated = sq?.updatedToolOutput;
        if (updated) {
          const after = typeof updated === "string" ? updated : `${updated.stdout ?? ""}${updated.stderr ?? ""}${textOf(updated.content)}`;
          r.trimmed++;
          r.interventions++;
          const command = String(use.input.command ?? use.name);
          keep(i, resultTokens - tokens(after), `trimmed \`${command.slice(0, 60)}\``);
          trimmedCommands.push({ key: withoutCd(command).slice(0, 40), at: use.at, label: withoutCd(command).slice(0, 60) });
        }
        if (typeof sq?.additionalContext === "string") r.added += tokens(sq.additionalContext);
      }
      run.post(postInput);
    }
  });
  if (boundaries.length) {
    const dir = mkdtempSync(join18(tmpdir(), "snout-replay-mem-"));
    try {
      for (const at of boundaries) {
        const prefix = join18(dir, "prefix.jsonl");
        writeFileSync5(prefix, lines.slice(0, at).map((l) => l.raw).join("\n") + "\n");
        const facts = sessionFacts(prefix, projectDir);
        const restored = memoryText(facts, [], projectDir);
        r.memory.chars += restored.length;
        const next = lines.slice(at + 1).flatMap(({ o }) => Array.isArray(o.message?.content) ? o.message.content : []).filter((b) => b?.type === "tool_use").slice(0, 40);
        const runner = (c) => c.split(/\s+/).slice(0, 3).join(" ");
        const testsNext = next.filter((b) => b.name === "Bash" && typeof b.input?.command === "string").map((b) => testCommand(b.input.command, projectDir)).filter(Boolean);
        if (facts.test) {
          r.memory.withTest++;
          if (testsNext.some((t) => runner(t) === runner(facts.test.command))) r.memory.testUsed++;
        } else if (testsNext.length) r.memory.testMissed++;
        const listed = new Set(facts.changed.filter((p) => restored.includes(p)));
        for (const b of next) {
          const p = b.input?.file_path;
          if (!EDITS2.has(b.name) || typeof p !== "string") continue;
          r.memory.editsAfter++;
          if (listed.has(rel(p))) r.memory.editsListed++;
        }
      }
    } finally {
      rmSync2(dir, { recursive: true, force: true });
    }
  }
  if (shadow) rmSync2(shadow.root, { recursive: true, force: true });
  return r;
}
var COMPACTION_COSTS = {
  // Fitted to the two long-session runs measured both ways (2026-10-08/09): live savings were
  // 6–8 points larger than even this predicts, so it errs toward saving less.
  usual: { summary: 0.12, reread: 0.05, rereadCalls: 2 },
  harsh: { summary: 0.25, reread: 0.3, rereadCalls: 8 }
};
function requestsOf(lines) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  lines.forEach(({ o }, i) => {
    const u = o.message?.usage;
    if (!u || o.type !== "assistant") return;
    const id = String(o.requestId ?? o.message?.id ?? i);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ written: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 });
  });
  return out;
}
var W = 1.25;
var R = 0.1;
var O = 5;
function compactionWhatIf(file2, cap2, costs) {
  const reqs = requestsOf(readLines(file2).filter(({ o }) => !o.isSidechain));
  const prefix = reqs.length ? reqs[0].written + reqs[0].cached : 0;
  let base = 0, sim = 0, ctx = 0, prev = 0, compactions = 0, peak = 0, rewrite = false;
  for (const q of reqs) {
    const size = q.written + q.cached;
    base += q.written * W + q.cached * R + q.output * O;
    if (prev && size < prev * 0.67) ctx = size;
    else ctx += size - prev;
    prev = size;
    if (ctx > cap2) {
      compactions++;
      const summary = costs.summary * cap2, reread = costs.reread * cap2;
      sim += ctx * R + summary * O;
      ctx = prefix + summary + reread;
      sim += costs.rereadCalls * ctx * R + reread * W;
      rewrite = true;
    }
    peak = Math.max(peak, ctx);
    const written = rewrite ? ctx : Math.min(q.written, ctx);
    sim += written * W + Math.max(0, ctx - written) * R + q.output * O;
    rewrite = false;
  }
  return { cap: cap2, baseCost: base, capCost: sim, change: base ? sim / base - 1 : 0, compactions, peak };
}
function totals2(rows) {
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const input = sum((r) => r.inputTokens);
  const net = sum((r) => r.carried) - sum((r) => r.added);
  const interventions = sum((r) => r.interventions);
  const withTest = sum((r) => r.memory.withTest);
  const editsAfter = sum((r) => r.memory.editsAfter);
  return {
    sessions: rows.length,
    calls: sum((r) => r.calls),
    inputTokens: input,
    keptOut: sum((r) => r.keptOut),
    carried: sum((r) => r.carried),
    added: sum((r) => r.added),
    share: input ? net / input : 0,
    regretRate: interventions ? sum((r) => r.regrets) / interventions : null,
    compactions: sum((r) => r.compactions),
    testRecall: withTest ? sum((r) => r.memory.testUsed) / withTest : null,
    fileRecall: editsAfter ? sum((r) => r.memory.editsListed) / editsAfter : null
  };
}
var fmt2 = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n));
var pct = (x) => x === null ? "\u2013" : `${(x * 100).toFixed(1)}%`;
function renderReplay(rows) {
  const t = totals2(rows);
  const out = [
    `Replay of ${t.sessions} session(s), ${t.calls} tool calls, offline (no model, nothing sent).`,
    "",
    `  input the sessions used        ${fmt2(t.inputTokens)} tokens`,
    `  kept out at the call           ${fmt2(t.keptOut)} tokens`,
    `  carried to later requests      ${fmt2(t.carried)} tokens  (until each compaction)`,
    `  Snout's own notes              ${fmt2(t.added)} tokens`,
    `  would have saved               ${pct(t.share)} of input`,
    `  regret                         ${pct(t.regretRate)} of interventions were needed later`
  ];
  if (t.compactions) out.push(`  memory, ${t.compactions} compaction(s)   test command matched next runs ${pct(t.testRecall)} \xB7 files edited next listed ${pct(t.fileRecall)}`);
  const count = (f) => rows.reduce((a, r) => a + f(r), 0);
  out.push(`  interventions                  ${count((r) => r.narrowed)} reads narrowed \xB7 ${count((r) => r.denied)} held back \xB7 ${count((r) => r.trimmed)} outputs trimmed \xB7 ${count((r) => r.repeats)} repeat reads`);
  out.push("", "  session       calls  input    saved   regret  compactions");
  for (const r of rows) {
    const share = r.inputTokens ? (r.carried - r.added) / r.inputTokens : 0;
    out.push(`  ${r.session.slice(0, 12).padEnd(12)}  ${String(r.calls).padStart(5)}  ${fmt2(r.inputTokens).padStart(6)}  ${pct(share).padStart(6)}  ${`${r.regrets}/${r.interventions}`.padStart(6)}  ${String(r.compactions).padStart(4)}`);
  }
  const regrets = rows.flatMap((r) => r.examples.regret).slice(0, 5);
  if (regrets.length) out.push("", "  needed after all:", ...regrets.map((x) => `    ${x}`));
  const rebuilt = rows.filter((r) => r.rebuilt);
  out.push("", "  An estimate of tokens, not of outcomes: an agent that sees less acts differently.");
  out.push(rebuilt.length ? `  ${rebuilt.length} session(s) whose project is gone were judged on the file copies they recorded (${rebuilt.reduce((a, r) => a + r.rebuilt, 0)} files); the rest on the files as they are on disk now.` : "  Files are judged as they are on disk now.");
  return out.join("\n");
}

// src/gate/install.ts
import { existsSync as existsSync14, mkdirSync as mkdirSync9, readFileSync as readFileSync17 } from "node:fs";
import { join as join19 } from "node:path";

// src/squeeze/squeeze.ts
var KINDS2 = [
  ["test", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(jest|vitest|mocha|playwright\s+test)\b|(jest|vitest|mocha|pytest|rspec|phpunit)\b|python3?\s+-m\s+(pytest|unittest)\b|python3?\s+(\S*\/)?runtests\.py\b|python3?\s+(\S*\/)?manage\.py\s+test\b|go\s+test\b|cargo\s+test\b|node\s+--test\b|deno\s+test\b)/],
  ["install", /(^|[\s;&|(])((npm|pnpm)\s+(i|install|ci|add)\b|yarn(\s+(install|add))?\s*($|[;&|])|bun\s+(i|install|add)\b|pip3?\s+install\b|poetry\s+install\b|bundle(\s+install)?\s*($|[;&|])|go\s+mod\s+(download|tidy)\b|cargo\s+fetch\b|brew\s+install\b)/],
  ["build", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?build\b|npx\s+(tsc|vite|next|webpack)\b|\btsc\b|vite\s+build\b|next\s+build\b|webpack\b|cargo\s+build\b|go\s+build\b|make\b|mvn\b|\.?\/?gradlew?\b|docker\s+build\b)/],
  // Searches that walk a tree: recursive grep, ripgrep and friends, git grep, find, ls -R.
  ["search", /(^|[\s;&|(])(grep\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]|rg\s|ag\s|ack\s|git\s+grep\b|find\s+(\.|\/|~|\S+\s+-)|ls\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*R)/]
];
var unquoted = (command) => command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "").replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
function kindOf(command) {
  const bare = unquoted(command);
  for (const [k, re] of KINDS2) if (re.test(bare)) return k;
  return null;
}
var MIN_BYTES = 4e3;
var agentOutputLimit = () => Number(process.env.BASH_MAX_OUTPUT_LENGTH) || 3e4;
var MIN_CUT = 0.3;
var KEEP_HEAD = 5;
var KEEP_TAIL = 15;
var ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
var TROUBLE = /\b(error|errors|err!|fail(ed|ure|ing)?|fatal|panic|exception|traceback|warn(ing)?s?|deprecated|vulnerab|critical|denied|cannot|can't|unable|not found|missing|undefined|timeout|timed out|segmentation)\b|✗|✕|×|❌|⚠|^\s*\(!\)/i;
var PASSING = /^\s*(✓|✔|√|ok\s+\d+\b|PASS\b|\S+::\S+.*\sPASSED(\s+\[\s*\d+%\])?$|\.{3,}$|test\s+\S+.*\.\.\.\s+ok$|\w+ \([\w.]+\)( \S+)? \.\.\. (ok|skipped\b.*|expected failure)$|--- PASS:|=== RUN\b|RUN\s|\[\s*PASSED\s*\]|\s*passed\s*$)/;
var SUMMARY = /\b(tests?:|suites?:|passed|passing|failed|failing|skipped|pending|todo|duration|time:|elapsed|total|ran \d+|\d+ (tests?|specs?|examples?)|added \d+ packages?|removed \d+|changed \d+|audited \d+|up to date|found \d+ vulnerabilit|built in|compiled|done in|successfully|finished)\b|^#\s*(tests|pass|fail|suites|duration)/i;
var LOCATION = /^\s*File "[^"]+", line \d+|^\s*at .+[(\s]\S+:\d+(:\d+)?\)?$|^\s*-->\s+\S+:\d+|^\s*\S+\.\w{1,6}:\d+(:\d+)?:\s/;
var NOISE = /^\s*([|/\\\-]\s*$|\d{1,3}%|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Downloading\b|Fetching\b|Resolving\b|Collecting\b|Using cached\b|Requirement already satisfied\b|Compiling \S+ v?\d|Checking \S+ v?\d|npm (http|timing|sill|verb)\b|#\d+ \[)/i;
function clean(text) {
  return text.replace(ANSI, "").split("\n").map((l) => (l.includes("\r") ? l.slice(l.lastIndexOf("\r") + 1) : l).replace(/\s+$/, ""));
}
function squeeze(kind, output, savedTo) {
  if (Buffer.byteLength(output) < MIN_BYTES || output.length > agentOutputLimit()) return null;
  if (kind === "search") return squeezeSearch(output, savedTo);
  const lines = clean(output);
  const n = lines.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < Math.min(KEEP_HEAD, n); i++) keep[i] = true;
  for (let i = Math.max(0, n - KEEP_TAIL); i < n; i++) keep[i] = true;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (TROUBLE.test(l)) {
      keep[i] = true;
      for (let j = i + 1; j < Math.min(n, i + 4); j++) if (lines[j].trim() && !PASSING.test(lines[j])) keep[j] = true;
      continue;
    }
    if (kind === "test" && PASSING.test(l)) keep[i] = false;
    else if (SUMMARY.test(l) || LOCATION.test(l)) keep[i] = true;
    else if (NOISE.test(l)) keep[i] = false;
  }
  const out = [];
  let dropped = 0;
  let last = "";
  let repeats = 0;
  const flushRepeats = () => {
    if (repeats > 0) out.push(`  (same line ${repeats} more time${repeats === 1 ? "" : "s"})`);
    repeats = 0;
  };
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (!keep[i] || !l.trim() && (out.length === 0 || !out[out.length - 1].trim())) {
      if (l.trim()) dropped += 1;
      continue;
    }
    if (dropped > 0) {
      flushRepeats();
      out.push(`  \u2026 ${dropped} line${dropped === 1 ? "" : "s"} omitted`);
      dropped = 0;
      last = "";
    }
    if (l === last && l.trim()) {
      repeats += 1;
      continue;
    }
    flushRepeats();
    out.push(l);
    last = l;
  }
  flushRepeats();
  if (dropped > 0) out.push(`  \u2026 ${dropped} line${dropped === 1 ? "" : "s"} omitted`);
  const body = out.join("\n");
  const text = `${body}

[Snout squeezed this ${kind} output: ${out.length} of ${n} lines kept, problems and summary included. Full output: ${savedTo}]`;
  const beforeBytes = Buffer.byteLength(output);
  const afterBytes = Buffer.byteLength(text);
  if (afterBytes > beforeBytes * (1 - MIN_CUT)) return null;
  return { kind, text, beforeLines: n, afterLines: out.length, beforeBytes, afterBytes };
}
var MATCHES_PER_FILE = 3;
var FILES_LISTED = 40;
var SMALL_SEARCH_LINES = 200;
var SMALL_SEARCH_FILES = 10;
var FILES_NAMED = 120;
var LIST_LINES = 60;
var MATCH_LINE = /^([^\s:][^:]{0,300}?):(\d+[:-])?(.*)$/;
function squeezeSearch(output, savedTo) {
  const lines = clean(output).filter((l) => l.trim());
  const n = lines.length;
  const matched = lines.map((l) => MATCH_LINE.exec(l));
  const fileCount = new Set(matched.map((m) => m?.[1]).filter(Boolean)).size;
  if (n <= SMALL_SEARCH_LINES && (fileCount <= SMALL_SEARCH_FILES || matched.every((m) => !m))) return null;
  const matchShare = matched.filter(Boolean).length / Math.max(n, 1);
  const out = [];
  let summary;
  if (matchShare >= 0.6) {
    const files = /* @__PURE__ */ new Map();
    lines.forEach((l, i) => {
      const file2 = matched[i]?.[1] ?? "(other)";
      const list = files.get(file2);
      if (list) list.push(l);
      else files.set(file2, [l]);
    });
    let shown = 0;
    let hiddenFiles = 0, hiddenMatches = 0;
    const named = [];
    for (const [file2, hits] of files) {
      if (shown >= FILES_LISTED) {
        hiddenFiles++;
        hiddenMatches += hits.length;
        if (named.length < FILES_NAMED) named.push(`${file2} (${hits.length})`);
        continue;
      }
      shown++;
      out.push(...hits.slice(0, MATCHES_PER_FILE));
      if (hits.length > MATCHES_PER_FILE) out.push(`  (+${hits.length - MATCHES_PER_FILE} more in ${file2})`);
    }
    if (hiddenFiles) {
      out.push(`  \u2026 ${hiddenFiles} more file${hiddenFiles === 1 ? "" : "s"} with ${hiddenMatches} match${hiddenMatches === 1 ? "" : "es"}, lines not shown:`);
      out.push(`    ${named.join(", ")}${hiddenFiles > named.length ? `, and ${hiddenFiles - named.length} more` : ""}`);
    }
    summary = `${n} matches in ${files.size} files; first ${MATCHES_PER_FILE} per file shown`;
  } else {
    out.push(...lines.slice(0, LIST_LINES));
    const rest = lines.slice(LIST_LINES);
    if (rest.length) {
      const shared = commonDirPrefix(lines.map((l) => l.replace(/^\.\//, "")));
      const prefix = shared.slice(0, shared.slice(0, -1).lastIndexOf("/") + 1);
      const dirs = /* @__PURE__ */ new Map();
      for (const l of rest) {
        const parts = l.replace(/^\.\//, "").slice(prefix.length).split("/");
        const top = parts.length > 2 ? parts.slice(0, 2).join("/") + "/" : parts.length === 2 ? parts[0] + "/" : "(top level)";
        dirs.set(top, (dirs.get(top) ?? 0) + 1);
      }
      out.push(`  \u2026 ${rest.length} more:`);
      for (const [d, c] of [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`    ${d}  ${c}`);
      if (dirs.size > 15) out.push(`    and ${dirs.size - 15} more directories`);
    }
    summary = `${n} lines; first ${Math.min(n, LIST_LINES)} shown, the rest counted by directory`;
  }
  const text = `${out.join("\n")}

[Snout grouped this search output: ${summary}. Narrow the search, or open the full output: ${savedTo}]`;
  const beforeBytes = Buffer.byteLength(output);
  const afterBytes = Buffer.byteLength(text);
  if (afterBytes > beforeBytes * (1 - MIN_CUT)) return null;
  return { kind: "search", text, beforeLines: n, afterLines: out.length, beforeBytes, afterBytes };
}
function commonDirPrefix(paths) {
  if (!paths.length) return "";
  let p = paths[0].slice(0, paths[0].lastIndexOf("/") + 1);
  for (const x of paths) while (p && !x.startsWith(p)) p = p.slice(0, p.slice(0, -1).lastIndexOf("/") + 1);
  return p;
}
var SQUEEZE_IFS = [
  "npm *",
  "pnpm *",
  "yarn *",
  "bun *",
  "npx *",
  "node --test *",
  "pytest *",
  "python -m pytest *",
  "python3 -m pytest *",
  "python -m unittest*",
  "python3 -m unittest*",
  "python tests/runtests.py*",
  "python3 tests/runtests.py*",
  "python runtests.py*",
  "python3 runtests.py*",
  "python manage.py test*",
  "python3 manage.py test*",
  "pip install *",
  "pip3 install *",
  "poetry install *",
  "go *",
  "cargo *",
  "make *",
  "tsc *",
  "mvn *",
  "gradle *",
  "./gradlew *",
  "docker build *",
  "bundle *",
  "rspec *",
  "jest *",
  "vitest *",
  "deno test *",
  "brew install *",
  "grep *",
  "rg *",
  "ag *",
  "ack *",
  "git grep *",
  "find *",
  "ls -R*"
];

// src/gate/install.ts
var PRINTING_COMMANDS = ["cat", "head", "tail", "less", "more", "bat", "nl", "tac", "rev", "sed", "awk", "jq", "xxd", "od", "strings"];
var MARK = "snout.mjs";
var SETTINGS = ["settings.json", "settings.local.json"];
var HOOK_PORT = Number(process.env.SNOUT_PORT) || 47613 + (process.getuid?.() ?? 0) % 1e3;
var URL_MARK = "/snout/v1/";
var isSnoutUrl = (url) => typeof url === "string" && url.includes(URL_MARK);
var hookUrl = (event) => `http://127.0.0.1:${HOOK_PORT}${URL_MARK}${event}`;
var hookFor = (bin, event, fast, extra = {}) => fast ? { type: "http", url: hookUrl(event), timeout: 5, ...extra } : { type: "command", command: `node "${bin}" ${event}`, timeout: 5, ...extra };
function squeezeEntries(bin, fast = false) {
  return [
    { matcher: "Bash", hooks: SQUEEZE_IFS.map((c) => hookFor(bin, "squeeze", fast, { if: `Bash(${c})` })) },
    // Every MCP tool: large results (browser snapshots, diffs, query rows) are trimmed the same way.
    { matcher: "mcp__.*", hooks: [hookFor(bin, "squeeze", fast)] }
  ];
}
function gateEntries(bin, fast = false) {
  return [
    { matcher: "Read|NotebookRead", hooks: [hookFor(bin, "pre-tool", fast)] },
    { matcher: "Bash", hooks: PRINTING_COMMANDS.map((c) => hookFor(bin, "pre-tool", fast, { if: `Bash(${c} *)` })) }
  ];
}
var ours = (h, event) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes(event) || typeof h.url === "string" && h.url.includes(URL_MARK + event);
var isGate = (e) => (e.hooks ?? []).some((h) => ours(h, "pre-tool"));
var isSqueeze = (e) => (e.hooks ?? []).some((h) => ours(h, "squeeze"));
function read2(file2) {
  try {
    return JSON.parse(readFileSync17(file2, "utf8"));
  } catch {
    return {};
  }
}
function write(file2, settings) {
  mkdirSync9(join19(file2, ".."), { recursive: true });
  writeAtomic(file2, JSON.stringify(settings, null, 2) + "\n");
}
function strip(settings) {
  let changed = false;
  for (const [event, mine] of [["PreToolUse", isGate], ["PostToolUse", isSqueeze]]) {
    const list = settings.hooks?.[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !mine(e));
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}
function installGate(projectDir, bin, fast = false) {
  removeGate(projectDir);
  const file2 = join19(projectDir, ".claude", "settings.local.json");
  const settings = read2(file2);
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...settings.hooks.PreToolUse ?? [], ...gateEntries(bin, fast)];
  settings.hooks.PostToolUse = [...settings.hooks.PostToolUse ?? [], ...squeezeEntries(bin, fast)];
  write(file2, settings);
  return file2;
}
function removeGate(projectDir) {
  let removed = false;
  for (const name of SETTINGS) {
    const file2 = join19(projectDir, ".claude", name);
    if (!existsSync14(file2)) continue;
    const settings = read2(file2);
    if (strip(settings)) {
      write(file2, settings);
      removed = true;
    }
  }
  return removed;
}
function refreshGate(projectDir, bin) {
  for (const name of SETTINGS) {
    const file2 = join19(projectDir, ".claude", name);
    if (!existsSync14(file2)) continue;
    const pre = read2(file2).hooks?.PreToolUse ?? [];
    const stale = pre.some((e) => isGate(e) && (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && !h.command.includes(`"${bin}"`)));
    if (stale) {
      installGate(projectDir, bin);
      return true;
    }
  }
  return false;
}

// src/coach/coach.ts
import { spawnSync as spawnSync3 } from "node:child_process";
var TASK = /\b(fix|add|implement|build|create|make|refactor|debug|update|change|write|remove|delete|improve|optimi[sz]e|migrate|rename|support|handle|investigate|clean ?up|speed up|port|convert|rewrite|finish|wire|hook up)\b/i;
var FOLLOW_UP = /^(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks?|thank you|continue|go( ahead)?|do it|proceed|next|again|looks good|lgtm|that|it|this|now|also|and|then|same|please)\b/i;
var FILE = /(?:^|[\s`'"(])(?:[\w.-]+\/)*[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|c|h|cpp|hpp|scala|sql|sh|ya?ml|toml|json|md|html|css|scss|vue|svelte|proto|graphql|tf|lock)\b/i;
var DIR = /(?:^|\s)(?:\.{0,2}\/)?(?:[\w-]+\/){1,}[\w-]*/;
var BACKTICK = /`[^`\n]{2,}`/;
var IDENT2 = /\b(?:[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+|[a-z][a-z0-9]*_[a-z0-9_]+)\b/;
var CALL = /\b[A-Za-z_][\w.]*\(\)/;
var LINE = /\b(?:line|L)\s?\d+\b|:\d+(?::\d+)?\b/;
var STACK = /(?:Error|Exception|Traceback|panic):|\bat\s+[\w.<>]+\s+\(/;
var BEHAVIOR = /\b(support(s|ing)?|so it|to show|to return|should|shouldn't|expected?|instead( of)?|returns?|returning|must|so that|currently|but it|when i|whenever|errors?|throws?|fails?|failing|crash(es|ing)?|undefined|null|nan|wrong|broken|incorrect|missing|hangs?|slow|timeout|ignores?|doesn'?t|isn'?t|never|always|equals?)\b/i;
var QUOTED = /"[^"\n]{4,}"|'[^'\n]{6,}'/;
var VERIFY = /\b(tests?|specs?|pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm test|yarn test|make test|passes|passing|pass|verify|reproduce|repro|curl|assert|snapshot|ci|lint|typecheck|build succeeds)\b/i;
var CODE_BLOCK = /```/;
function scorePrompt(prompt) {
  const text = prompt.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const slash = text.startsWith("/");
  const followUp = words < 10 && FOLLOW_UP.test(text);
  const taskLike = !slash && !followUp && words >= 3 && TASK.test(text);
  const target = FILE.test(text) || DIR.test(text) || BACKTICK.test(text) || IDENT2.test(text) || CALL.test(text) || LINE.test(text) || STACK.test(text);
  const behavior = BEHAVIOR.test(text) || QUOTED.test(text) || STACK.test(text);
  const verify = VERIFY.test(text) || CODE_BLOCK.test(text);
  return finish({ taskLike, words, target, behavior, verify, source: "rules" });
}
function finish(c) {
  const score = (c.target ? 0.45 : 0) + (c.behavior ? 0.3 : 0) + (c.verify ? 0.25 : 0);
  const missing = [];
  if (!c.target) missing.push("target");
  if (!c.behavior) missing.push("behavior");
  if (!c.verify) missing.push("verify");
  const needsTip = c.taskLike && (!c.target || !c.behavior && !c.verify && c.words < 12);
  return { ...c, score: Math.round(score * 100) / 100, missing, tip: needsTip ? tipFor(missing) : null };
}
var ASK = {
  target: "which file or function",
  behavior: "what should happen",
  verify: "how to check it"
};
function tipFor(missing) {
  const asks = missing.map((m) => ASK[m]);
  const list = asks.length > 1 ? `${asks.slice(0, -1).join(", ")} and ${asks[asks.length - 1]}` : asks[0];
  return `Snout prompt coach: add ${list}, and the agent searches less.`;
}
var QUESTIONS = {
  target: {
    type: "noul",
    instructions: "`prompt` is a request to an AI coding agent. Does it name a specific target for the work: a file, directory, function, class, command, error message or line?",
    criteria: {
      true: "Names at least one concrete thing in the codebase or its output that the agent can go straight to.",
      false: "Describes the work only in general terms, so the agent must search to find where it applies."
    }
  },
  behavior: {
    type: "noul",
    instructions: "`prompt` is a request to an AI coding agent. Does it say what the correct behaviour should be, or describe what currently goes wrong?"
  },
  verify: {
    type: "noul",
    instructions: "`prompt` is a request to an AI coding agent. Does it say how to check the result: a test to pass, a command to run, or steps that reproduce the problem?"
  }
};
function scoreWithJev(prompt, rules, timeoutMs = 2500) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key || !rules.taskLike) return rules;
  const body = JSON.stringify({ model: process.env.SNOUT_COACH_MODEL || "jev-latest", state: { prompt: prompt.slice(0, 4e3) }, questions: QUESTIONS });
  const url = `${(process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "")}/v1/systemone`;
  const script = `fetch(process.argv[1],{method:"POST",headers:{authorization:"Bearer "+process.env.TYPESAFE_API_KEY,"content-type":"application/json"},body:require("fs").readFileSync(0,"utf8"),signal:AbortSignal.timeout(${timeoutMs - 300})}).then(r=>r.ok?r.text():Promise.reject(r.status)).then(t=>process.stdout.write(t),()=>process.exit(1))`;
  const r = spawnSync3(process.execPath, ["-e", script, url], { input: body, encoding: "utf8", timeout: timeoutMs });
  if (r.status !== 0 || !r.stdout) return rules;
  try {
    const a = JSON.parse(r.stdout).answers ?? {};
    const yes = (k) => typeof a[k]?.noul === "number" ? a[k].noul >= 0.5 : null;
    const [t, b, v] = [yes("target"), yes("behavior"), yes("verify")];
    if (t === null || b === null || v === null) return rules;
    return finish({ taskLike: rules.taskLike, words: rules.words, target: t, behavior: b, verify: v, source: "jev" });
  } catch {
    return rules;
  }
}

// src/squeeze/mcp.ts
var MIN_CHARS = 6e3;
var TEXT_BUDGET = 24e3;
var MAX_ITEMS2 = 25;
var KEEP_ITEMS = 20;
var MAX_STRING = 400;
var MAX_LINE = 600;
var MIN_CUT2 = 0.3;
var mcpLimitChars = () => (Number(process.env.MAX_MCP_OUTPUT_TOKENS) || 25e3) * 4;
function trimJson(v, depth = 0) {
  if (depth > 12) return v;
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}\u2026 (${v.length} chars)` : v;
  if (Array.isArray(v)) {
    const kept = v.slice(0, v.length > MAX_ITEMS2 ? KEEP_ITEMS : v.length).map((x) => trimJson(x, depth + 1));
    if (v.length > MAX_ITEMS2) kept.push(`\u2026 ${v.length - KEEP_ITEMS} more items (${v.length} total)`);
    return kept;
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = trimJson(x, depth + 1);
    return out;
  }
  return v;
}
function trimText(text) {
  const out = [];
  let last = "";
  let repeats = 0;
  let blank = false;
  const flush = () => {
    if (repeats) out.push(`(+${repeats} identical)`);
    repeats = 0;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      if (!blank) out.push("");
      blank = true;
      continue;
    }
    blank = false;
    if (line === last) {
      repeats += 1;
      continue;
    }
    flush();
    out.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}\u2026 (${line.length} chars)` : line);
    last = line;
  }
  flush();
  let s = out.join("\n");
  if (s.length > TEXT_BUDGET) {
    const head = s.slice(0, Math.floor(TEXT_BUDGET * 0.7));
    const tail2 = s.slice(s.length - Math.floor(TEXT_BUDGET * 0.3));
    s = `${head}
\u2026 ${s.length - head.length - tail2.length} characters omitted \u2026
${tail2}`;
  }
  return s;
}
function trimBlockText(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(trimJson(JSON.parse(t)));
    } catch {
    }
  }
  return trimText(text);
}
function trimMcp(response, savedTo) {
  const blocks = Array.isArray(response) ? response : response && typeof response === "object" && Array.isArray(response.content) ? response.content : null;
  if (!blocks || !blocks.every((b) => b && typeof b === "object" && typeof b.type === "string")) return null;
  const beforeChars = blocks.reduce((a, b) => a + (b.type === "text" && typeof b.text === "string" ? b.text.length : 0), 0);
  if (beforeChars < MIN_CHARS || beforeChars > mcpLimitChars()) return null;
  const trimmed = blocks.map((b) => b.type === "text" && typeof b.text === "string" ? { ...b, text: trimBlockText(b.text) } : b);
  const kept = trimmed.reduce((a, b) => a + (b.type === "text" && typeof b.text === "string" ? b.text.length : 0), 0);
  if (kept > beforeChars * (1 - MIN_CUT2)) return null;
  trimmed.push({ type: "text", text: `[Snout trimmed this result from ${beforeChars.toLocaleString()} to ${kept.toLocaleString()} characters: long lists shortened, repeats collapsed, structure kept. Full result: ${savedTo}]` });
  const afterChars = kept + trimmed[trimmed.length - 1].text.length;
  const output = Array.isArray(response) ? trimmed : { ...response, content: trimmed };
  return { output, beforeChars, afterChars };
}

// src/gate/longdoc.ts
var LONG_DOC_BYTES = 32 * 1024;
var HEAD_LINES3 = 60;
var HEAD_BYTES5 = 6 * 1024;
var TAIL_LINES = 120;
var TAIL_BYTES2 = 8 * 1024;
var MAX_HEADINGS = 60;
var MAX_ERROR_LINES = 30;
var DOC_EXT = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt|org)$/i;
var LOG_EXT = /\.(log|out|err)$/i;
var LOG_DIR = /(^|\/)(logs?|tmp\/logs?)\//i;
var INSTRUCTION_NAMES = /^(claude|agents|gemini|copilot-instructions|readme|contributing|security|skill|memory)(\.[a-z]+)*$/i;
var INSTRUCTION_DIRS = /(^|\/)(\.claude|\.cursor|\.gemini|\.codex|\.github\/instructions|\.windsurf|\.clinerules)\//i;
function docKindOf(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (INSTRUCTION_DIRS.test(rel) || INSTRUCTION_NAMES.test(base) || base === ".cursorrules") return null;
  if (LOG_EXT.test(base) || LOG_DIR.test(rel) && /\.(txt|json|jsonl)$/i.test(base)) return "log";
  if (DOC_EXT.test(base)) return "doc";
  return null;
}
var byteLen = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 128 ? 1 : c < 2048 ? 2 : c >= 55296 && c <= 56319 ? (i++, 4) : 3;
  }
  return n;
};
function cleanHeading(raw) {
  return raw.replace(/[`*_~[\]<>{}]/g, "").replace(/[^\p{L}\p{N} .,:;()'/&+#-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
}
function docWindow(rel, text, totalBytes) {
  const kind = docKindOf(rel);
  if (!kind || totalBytes < LONG_DOC_BYTES) return null;
  const all = text.split("\n");
  if (all.length < HEAD_LINES3 * 2) return null;
  return kind === "doc" ? docHead(all) : logTail(all);
}
function docHead(all) {
  let bytes = 0, lines = 0;
  for (const line of all.slice(0, HEAD_LINES3)) {
    const b = byteLen(line) + 1;
    if (bytes + b > HEAD_BYTES5) break;
    bytes += b;
    lines++;
  }
  const items = [];
  let total = 0, fence = false;
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const atx = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    const setext = !atx && i > 0 && /^(=+|-{3,})\s*$/.test(line) && /\S/.test(all[i - 1]) && !/^\s*[-*+>|]/.test(all[i - 1]);
    if (!atx && !setext) continue;
    const level = atx ? atx[1].length : line[0] === "=" ? 1 : 2;
    const text = cleanHeading(atx ? atx[2] : all[i - 1]);
    if (!text) continue;
    total++;
    if (items.length < MAX_HEADINGS) items.push(`${"#".repeat(level)} ${text} L${atx ? i + 1 : i}`);
  }
  if (lines < 5 || items.length < 2) return null;
  const more = total > items.length ? ` (+${total - items.length} more)` : "";
  return { kind: "doc", start: 1, lines, bytes, totalLines: all.length, map: ` Its sections, with line numbers: ${items.join(" \xB7 ")}${more}.` };
}
function logTail(all) {
  const n = all.length - (all[all.length - 1] === "" ? 1 : 0);
  let bytes = 0, lines = 0;
  for (let i = n - 1; i >= 0 && lines < TAIL_LINES; i--) {
    const b = byteLen(all[i]) + 1;
    if (bytes + b > TAIL_BYTES2) break;
    bytes += b;
    lines++;
  }
  if (lines < 5) return null;
  const start = n - lines + 1;
  const errors = [];
  let total = 0;
  for (let i = 0; i < start - 1; i++) {
    if (!/\b(error|fail(ed|ure)?|exception|panic|fatal|traceback)\b/i.test(all[i])) continue;
    total++;
    if (errors.length < MAX_ERROR_LINES) errors.push(i + 1);
  }
  const map = errors.length ? ` Earlier lines that mention an error or failure: ${errors.map((l) => `L${l}`).join(", ")}${total > errors.length ? ` (+${total - errors.length} more)` : ""}.` : " No earlier line mentions an error or failure.";
  return { kind: "log", start, lines, bytes, totalLines: n, map };
}

// src/gate/repeat.ts
import { existsSync as existsSync15, readFileSync as readFileSync18, statSync as statSync15 } from "node:fs";
import { join as join20 } from "node:path";
import { createHash as createHash3 } from "node:crypto";
var MAX_ENTRIES = 2e3;
var MAX_WINDOWS = 20;
var storePath = (snoutDir) => join20(snoutDir, "reads.json");
function load2(snoutDir, session) {
  try {
    const s = JSON.parse(readFileSync18(storePath(snoutDir), "utf8"));
    if (s.session === session && s.reads && typeof s.reads === "object") return s;
  } catch {
  }
  return { session, reads: {} };
}
function trim(map) {
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
}
function save2(snoutDir, store) {
  try {
    trim(store.reads);
    if (store.outputs) trim(store.outputs);
    writeAtomic(storePath(snoutDir), JSON.stringify(store));
  } catch {
  }
}
function requestedWindow(toolInput) {
  const t = toolInput ?? {};
  const limit = Number(t.limit);
  if (!Number.isFinite(limit) || limit <= 0) return "full";
  const offset = Math.max(1, Number(t.offset) || 1);
  return `${offset}:${limit}`;
}
function returnedWindow(toolResponse) {
  const file2 = toolResponse?.file;
  if (!file2 || typeof file2.numLines !== "number") return null;
  const start = Number(file2.startLine) || 1;
  const total = Number(file2.totalLines) || file2.numLines;
  if (start <= 1 && file2.numLines >= total) return "full";
  return `${start}:${file2.numLines}`;
}
var span = (w) => {
  const [s, n] = w.split(":").map(Number);
  return [s, s + n - 1];
};
function coveringWindow(have, want) {
  if (have.includes(want)) return want;
  if (have.includes("full")) return "full";
  if (want === "full") return null;
  const [a, b] = span(want);
  return have.find((w) => w !== "full" && span(w)[0] <= a && span(w)[1] >= b) ?? null;
}
var keyOf = (agentId, rel) => `${agentId || "main"}\0${rel}`;
function statOf(absPath) {
  try {
    const s = statSync15(absPath);
    return s.isFile() ? { size: s.size, mtimeMs: Math.round(s.mtimeMs) } : null;
  } catch {
    return null;
  }
}
function rememberRead(snoutDir, session, agentId, absPath, rel, window, turn) {
  const st = statOf(absPath);
  if (!st || !existsSync15(snoutDir)) return;
  const store = load2(snoutDir, session);
  const key = keyOf(agentId, rel);
  const prior = store.reads[key];
  const same = prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs;
  const windows = same ? prior.windows.filter((w) => w !== window) : [];
  windows.push(window);
  delete store.reads[key];
  store.reads[key] = { ...st, turn, windows: windows.slice(-MAX_WINDOWS) };
  save2(snoutDir, store);
}
function repeatOf(snoutDir, session, agentId, absPath, rel, window, native = false) {
  const prior = load2(snoutDir, session).reads[keyOf(agentId, rel)];
  if (!prior || !Array.isArray(prior.windows)) return null;
  const st = statOf(absPath);
  if (!st || st.size !== prior.size || st.mtimeMs !== prior.mtimeMs) return null;
  const covering = coveringWindow(prior.windows, window);
  if (!covering || native && covering === window) return null;
  return { turn: prior.turn, window: covering };
}
var MIN_REPEAT_CHARS = 800;
var outputKey = (agentId, tool, text) => `${agentId || "main"}\0${tool}\0${createHash3("sha256").update(text).digest("hex").slice(0, 32)}`;
function repeatOutput(snoutDir, session, agentId, tool, text, turn, call) {
  if (text.length < MIN_REPEAT_CHARS || !existsSync15(snoutDir)) return null;
  const store = load2(snoutDir, session);
  store.outputs ??= {};
  const key = outputKey(agentId, tool, text);
  const prior = store.outputs[key];
  if (prior) return prior.call && prior.call === call ? null : prior;
  store.outputs[key] = { turn, chars: text.length, ...call ? { call } : {} };
  save2(snoutDir, store);
  return null;
}
function forgetReads(snoutDir, session) {
  if (!existsSync15(snoutDir)) return;
  save2(snoutDir, { session, reads: {}, outputs: {} });
}

// src/cli.ts
var VERSION2 = "0.2.2";
var BIN = resolve10(process.argv[1] ?? "dist/snout.mjs");
var requestStart = 0;
var elapsedMs = () => Math.round(performance.now() - requestStart);
var HOOK_EVENTS = /* @__PURE__ */ new Set(["session-start", "prompt-submit", "pre-tool", "post-tool", "pre-compact", "stop", "squeeze"]);
var RECORDING_HOOKS = ["session-start", "prompt-submit", "post-tool", "pre-compact", "stop"];
var GATED_TOOLS = /* @__PURE__ */ new Set(["Read", "NotebookRead"]);
function main() {
  const command = process.argv[2] ?? "status";
  if (command === "mcp") {
    const paths = resolvePaths(process.argv[3]);
    attach(paths);
    return startMcp(paths.projectDir, loadConfig(paths), VERSION2, writeOut);
  }
  if (command === "dashboard") return cmdDashboard(process.argv.slice(3));
  if (command === "serve") {
    if (process.argv.includes("--ensure")) void ensureServer().finally(() => process.exit(0));
    else startServer();
    return;
  }
  if (command === "audit") {
    void cmdAudit(process.argv.slice(3)).catch((err) => recordError("audit", err)).finally(() => process.exit(0));
    return;
  }
  if (command === "login" || command === "logout" || command === "sync") {
    void cmdCloud(command, process.argv.slice(3)).catch((err) => recordError(command, err)).finally(() => process.exit(0));
    return;
  }
  const input = readHookInput();
  if (command === "hook") return onAgentHook(process.argv[3], process.argv[4] ?? "", input);
  if (command === "init") return cmdInit(process.argv[3], input.cwd);
  dispatch(command, input);
}
function onAgentHook(agent, event, raw) {
  if (!isAgent(agent)) return say(`snout hook: unknown agent "${safeText(agent ?? "", 20)}". Supported: ${AGENTS.join(", ")}.`);
  const mapped = Object.keys(raw).length ? toInternal(agent, event, raw) : null;
  let out = null;
  if (mapped) {
    captured = null;
    capturing = true;
    client = agent;
    try {
      dispatch(mapped.command, mapped.input);
    } catch (err) {
      recordError(`hook ${agent} ${event}`, err);
    } finally {
      capturing = false;
    }
    out = captured;
  }
  const text = fromInternal(agent, event, out);
  if (text) writeOut(text);
}
function maybeAutoSync(paths) {
  if (replayDir) return;
  try {
    if (!loadCredentials()) return;
    const last = lastSync(paths);
    if (last && Date.now() - Date.parse(last.at) < (process.env.SNOUT_TOKEN ? AGENT_SYNC_MS : AUTO_SYNC_MS)) return;
    const script = process.argv[1];
    if (!script) return;
    spawn2(process.execPath, [script, "sync", "--quiet", paths.projectDir], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {
    }).unref();
  } catch (err) {
    recordError("autoSync", err);
  }
}
async function cmdCloud(command, args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : void 0;
  };
  const dir = args.find((a, i) => !a.startsWith("-") && !["--url"].includes(args[i - 1] ?? ""));
  if (command === "logout") {
    return say(forgetCredentials() ? "Logged out. Nothing more is sent; the local ledger is untouched." : "Not logged in.");
  }
  if (command === "login") {
    await login(cloudUrl(flag("--url")), say, args.includes("--no-open") ? () => {
    } : openBrowser);
    return;
  }
  const paths = resolvePaths(dir);
  if (args.includes("--dry-run")) {
    return say(JSON.stringify(buildPayload(paths, VERSION2), null, 2));
  }
  const r = await sync(paths, VERSION2);
  if (!args.includes("--quiet") || !r.ok) say(r.message);
}
var spendCache = (paths) => existsSync16(paths.snoutDir) ? join21(paths.snoutDir, "spend-cache.json") : null;
function cmdStatus(paths, cfg) {
  const rows = readDecisions(paths.ledger, 2e4);
  const s = summarizeLedger(rows);
  let rate = 0;
  let spentToday = 0;
  try {
    const spend = summarizeSpend([...readSpend(paths.projectDir, spendCache(paths), configDir()).values()].flat());
    rate = spend.inputRate;
    spentToday = spend.series.find((d) => d.day === s.today.day)?.costUsd ?? 0;
  } catch {
  }
  const usd = (tokens2) => rate ? ` (~$${(tokens2 * rate / 1e6).toFixed(2)})` : "";
  const lines = [`snout ${VERSION2} \xB7 ${basename6(paths.projectDir)} \xB7 mode ${cfg.mode}`, ""];
  if (!s.reads) {
    lines.push("  No reads recorded yet in this project.", "", `  Next: ${gateInstalled(paths) || existsSync16(paths.hooks) ? "start your agent here and work as usual" : "snout init claude (or codex, cursor, gemini)"}`);
    return say(lines.join("\n"));
  }
  lines.push(`  Today     ~${fmtTokens(s.today.heldBack)} tokens kept out of context${usd(s.today.heldBack)} across ${s.today.reads} read(s)${spentToday ? ` \xB7 agents spent $${spentToday.toFixed(2)}` : ""}`);
  lines.push(`  All time  ~${fmtTokens(s.heldBack)} tokens kept out${usd(s.heldBack)} \xB7 ${s.gated} of ${s.reads} reads trimmed \xB7 ${Math.round(s.savedShare * 100)}% of what agents asked to read`);
  if (s.couldHoldBack > 0 && cfg.mode === "observe") lines.push(`  Waiting   ~${fmtTokens(s.couldHoldBack)} more tokens would have been kept out in enforce mode`);
  lines.push("", `  Next: ${cfg.mode === "observe" ? "snout mode enforce   (start trimming)" : "snout dashboard      (watch it live)"}`);
  say(lines.join("\n"));
}
function cmdSpend(paths, args) {
  const all = args.includes("--all");
  const i = args.indexOf("--days");
  const days = i >= 0 ? Math.max(1, Number(args[i + 1]) || 30) : 30;
  const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  const spend = readSpend(all ? null : paths.projectDir, all ? join21(configDir(), "spend-cache.json") : join21(paths.snoutDir, "spend-cache.json"), configDir());
  const s = summarizeSpend([...spend.values()].flat(), since);
  const held = all ? 0 : dailyAggregates(readDecisions(paths.ledger, 2e4), since).reduce((a, d) => a + d.heldBack, 0);
  const projects = [...spend.entries()].map(([dir, r]) => ({ dir, s: summarizeSpend(r, since) })).filter((p) => p.s.requests > 0).sort((a, b) => b.s.costUsd - a.s.costUsd);
  if (args.includes("--json")) {
    return say(JSON.stringify({ days, pricesAsOf: PRICES_AS_OF, ...s, heldBack: held, projects: all ? projects.map((p) => ({ dir: p.dir, costUsd: p.s.costUsd, requests: p.s.requests, tokens: p.s.tokens })) : void 0 }, null, 2));
  }
  const usd = (n) => `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
  const pad = (v, n, left = false) => left ? v.padEnd(n) : v.padStart(n);
  const lines = [`snout spend \u2014 ${all ? "all projects on this machine" : basename6(paths.projectDir)} \xB7 last ${days} days \xB7 API list prices of ${PRICES_AS_OF}`, ""];
  if (!s.requests) {
    lines.push("  No agent usage recorded in this range. Claude Code and Codex sessions are read from their own logs.");
    return say(lines.join("\n"));
  }
  const cachedShare = s.tokens ? Math.round(s.cacheRead / s.tokens * 100) : 0;
  lines.push(`  ${usd(s.costUsd)} across ${s.requests.toLocaleString()} requests \xB7 ${fmtTokens(s.tokens)} tokens (${cachedShare}% cache reads)`);
  if (held > 0) lines.push(`  Snout held back ~${fmtTokens(held)} tokens, about ${usd(held * s.inputRate / 1e6)} at your blended input rate ($${s.inputRate.toFixed(2)}/M), counted once`);
  lines.push("", `  ${pad("BY MODEL", 26, true)}${pad("requests", 10)}${pad("tokens", 10)}${pad("cost", 11)}`);
  for (const m of s.byModel) lines.push(`    ${pad(safeText(m.key, 22), 22, true)}${pad(m.requests.toLocaleString(), 10)}${pad(fmtTokens(m.tokens), 10)}${pad(usd(m.costUsd), 11)}`);
  if (all) {
    lines.push("", `  ${pad("BY PROJECT", 46, true)}${pad("cost", 11)}`);
    for (const p of projects.slice(0, 10)) lines.push(`    ${pad(safeText(p.dir.replace(homedir6(), "~"), 60).slice(-42), 42, true)}${pad(usd(p.s.costUsd), 11)}`);
    const rest = projects.slice(10);
    if (rest.length) lines.push(`    ${pad(`${rest.length} more`, 42, true)}${pad(usd(rest.reduce((a, p) => a + p.s.costUsd, 0)), 11)}`);
  }
  if (s.unpriced.length) lines.push("", `  No list price for ${s.unpriced.map((m) => safeText(m, 40)).join(", ")}: tokens counted, cost left out. Add it to ${join21(configDir(), "prices.json")}.`);
  lines.push("", "  A Claude or ChatGPT subscription is not billed per token; this is what the same work costs on the API.");
  say(lines.join("\n"));
}
function cmdDashboard(args) {
  let port = 4747;
  let open = true;
  let dir;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") port = Number(args[++i]);
    else if (a === "--no-open") open = false;
    else if (!a.startsWith("-")) dir = a;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) return say("snout dashboard: --port takes a number from 0 to 65535.");
  const paths = resolvePaths(dir);
  const cfg = loadConfig(paths);
  const running = liveDashboard(configDir(), paths.projectDir);
  if (running && !args.includes("--port")) {
    const url = `http://127.0.0.1:${running.port}/`;
    say(`Snout dashboard for ${paths.projectDir} is already running: ${url}`);
    if (open) openBrowser(url);
    process.exit(0);
  }
  startDashboard(paths, {
    port,
    mode: cfg.mode,
    version: VERSION2,
    actions: dashboardActions(paths),
    onListen(url) {
      registerDashboard(configDir(), paths.projectDir, { port: Number(new URL(url).port), pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
      say(`Snout dashboard for ${paths.projectDir}: ${url}
Updates live as agents read files. Ctrl-C to stop.`);
      if (open) openBrowser(url);
    }
  });
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn2(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {
    }).unref();
  } catch {
  }
}
function cmdInit(agent, cwd) {
  if (process.argv.includes("--remove")) return cmdRemove(agent, cwd);
  if (agent === "claude" || agent === "claude-code") {
    return say("Claude Code runs Snout as a plugin:\n\n  claude plugin marketplace add biffbuster/snout-context\n  claude plugin install snout@snout-context\n\nThen start a new session in this project. `snout` shows what it's doing.");
  }
  if (!isAgent(agent)) return say(`Usage: snout init <claude|${AGENTS.join("|")}>

Sets that agent up in this project so it runs Snout on every read.`);
  const paths = resolvePaths(cwd);
  try {
    const { file: file2, events } = initAgent(agent, paths.projectDir);
    say(`snout init ${agent}: wrote ${toRel(file2, paths.projectDir)} (${events.join(", ")}).`);
    if (agent === "codex") say("Codex loads project hooks only in a trusted folder: open Codex here, trust the folder, then approve Snout's hooks with /hooks.");
    const mode = loadConfig(paths).mode;
    say(mode === "observe" ? "Mode: observe (records only). `snout mode enforce` makes it act; `snout report` shows what it saw." : `Mode: ${mode}. \`snout report\` shows what it saw.`);
  } catch (err) {
    recordError("init", err);
    say(`snout init ${agent} failed: ${safeText(err.message, 200)}`);
  }
}
function cmdRemove(agent, cwd) {
  const rest = "Snout's records stay in .snout/ until you delete that folder; the local fast-hook server, if running, stops after 30 idle minutes.";
  if (agent === "claude" || agent === "claude-code") {
    return say(`To remove Snout from Claude Code:

  snout mode observe                        # takes out the gate in .claude/settings.local.json
  claude plugin uninstall snout@snout-context

${rest}`);
  }
  if (!isAgent(agent)) return say(`Usage: snout init <claude|${AGENTS.join("|")}> --remove`);
  const paths = resolvePaths(cwd);
  try {
    const { file: file2, removed } = removeAgent(agent, paths.projectDir);
    say(removed ? `Removed Snout's ${removed} hook entr${removed === 1 ? "y" : "ies"} from ${toRel(file2, paths.projectDir)}; other hooks are untouched. ${rest}` : `No Snout hooks in ${toRel(file2, paths.projectDir)}. ${rest}`);
  } catch (err) {
    recordError("init", err);
    say(`snout init ${agent} --remove failed: ${safeText(err.message, 200)}`);
  }
}
function dispatch(command, input) {
  if (HOOK_EVENTS.has(command) && Object.keys(input).length === 0) {
    debug("empty hook payload for", command, "- doing nothing");
    return;
  }
  const paths = replayDir ? rebase(resolvePaths(input.cwd), replayDir) : resolvePaths(input.cwd);
  attach(paths);
  const cfg = replayDir ? { ...loadConfig(paths), mode: "enforce" } : loadConfig(paths);
  if (HOOK_EVENTS.has(command)) recordHeartbeat(paths, command, input);
  switch (command) {
    case "session-start":
      return onSessionStart(input, paths, cfg);
    case "prompt-submit":
      return onPromptSubmit(input, paths, cfg);
    case "pre-tool":
      return onPreTool(input, paths, cfg);
    case "post-tool":
      return onPostTool(input, paths, cfg);
    case "squeeze":
      return onSqueeze(input, paths, cfg);
    case "pre-compact":
      return onPreCompact(input, paths);
    case "stop":
      return onStop(input, paths, cfg);
    case "report":
      return cmdReport(paths, cfg, process.argv.slice(3));
    case "replay":
      return cmdReplay(paths, process.argv.slice(3));
    case "statusline":
      return cmdStatusline(paths, cfg);
    case "mode":
      return cmdMode(paths, cfg, process.argv[3]);
    case "allow":
      return cmdAllow(paths, cfg, process.argv[3]);
    case "apply":
      return cmdApply(paths, cfg, process.argv.slice(3));
    case "explain":
      return cmdExplain(paths, cfg, process.argv.slice(3));
    case "scan":
      return cmdScan(paths, cfg, process.argv.slice(3));
    case "reset":
      return cmdReset(paths);
    case "doctor":
      return cmdDoctor(paths, cfg);
    case "spend":
      return cmdSpend(paths, process.argv.slice(3));
    case "coach":
      return cmdCoach(paths, cfg, process.argv.slice(3));
    case "output":
      return cmdOutput(paths, cfg, process.argv.slice(3));
    case "map":
      return cmdMap(paths, cfg, process.argv.slice(3));
    case "fast":
      return cmdFast(paths, cfg, process.argv[3]);
    case "version":
      return say(`snout ${VERSION2}`);
    case "status":
      return cmdStatus(paths, cfg);
    case "help":
    case "--help":
    case "-h":
      return say(HELP);
    default:
      return say(`snout: unknown command "${safeText(command, 30)}".

${HELP}`);
  }
}
function recordHeartbeat(paths, event, input) {
  const row = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    event,
    session: input.session_id ?? "unknown"
  };
  appendRow(paths.hooks, { ...row, ...agentOf2(input) });
  rotateIfLarge(paths.hooks);
}
function agentOf2(input) {
  const out = {};
  if (typeof input.agent_id === "string" && input.agent_id) out.agentId = input.agent_id.slice(0, 128);
  if (typeof input.agent_type === "string" && input.agent_type) out.agentType = input.agent_type.slice(0, 128);
  return out;
}
function readShape(input, absPath, bashBytes) {
  const out = {};
  const fp = fingerprintOf(absPath);
  if (fp) out.fp = fp;
  if (input.tool_name === "Bash" || input.tool_name === "Grep") {
    out.range = `${input.tool_name.toLowerCase()}:${bashBytes ?? 0}`;
  } else {
    const t = input.tool_input ?? {};
    const part = (k) => typeof t[k] === "number" || typeof t[k] === "string" ? String(t[k]) : "";
    out.range = `${part("offset")}:${part("limit")}${part("pages") ? `:p${part("pages")}` : ""}`;
  }
  return out;
}
function lastSeenByEvent(paths) {
  const out = /* @__PURE__ */ new Map();
  for (const r of readRows(paths.hooks, 500)) {
    if (!r || typeof r.event !== "string") continue;
    const prev = out.get(r.event);
    if (!prev || r.ts > prev) out.set(r.event, r.ts);
  }
  return out;
}
function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1e3);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function onSessionStart(input, paths, cfg) {
  const session = input.session_id ?? "unknown";
  const state = loadState(paths.state, session);
  state.session = session;
  if (typeof input.model === "string" && input.model) state.model = input.model.slice(0, 64);
  saveState(paths.state, state);
  try {
    if (gateInstalled(paths)) refreshGate(paths.projectDir, BIN);
  } catch (err) {
    recordError("refreshGate", err);
  }
  if (cfg.mode !== "observe" && fastGateInstalled(paths)) {
    try {
      spawnSync4(process.execPath, [BIN, "serve", "--ensure"], { stdio: "ignore", timeout: 3e3 });
    } catch (err) {
      recordError("ensureServer", err);
    }
  }
  if ((input.source ?? input.session_start_reason) === "compact" && cfg.mode !== "observe" && input.transcript_path) {
    try {
      const progress = readProgress(paths.snoutDir, sessionStartMs(input.transcript_path));
      const text = memoryText(sessionFacts(input.transcript_path, paths.projectDir), readPins(paths.projectDir, paths.snoutDir), paths.projectDir, cfg, progress);
      if (text) return emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: cfg.output === "concise" ? `${text}

${CONCISE_INSTRUCTION}` : text } });
    } catch (err) {
      recordError("memory", err);
    }
  }
  const s = summarizeLedger(readDecisions(paths.ledger, 5e3));
  const report = firstRunReport(paths, cfg, s);
  if (report) return emit(withOutputStyle(cfg, { systemMessage: report }));
  const kept = s.today.heldBack ? ` \xB7 ~${fmtTokens(s.today.heldBack)} tokens kept out today` : "";
  const dash = liveDashboard(configDir(), paths.projectDir);
  const where = dash ? ` \xB7 dashboard http://127.0.0.1:${dash.port}/` : " \xB7 `snout dashboard` to watch it live";
  emit(withOutputStyle(cfg, { systemMessage: `Snout is on (${cfg.mode})${kept}${where}${cfg.output === "concise" ? " \xB7 concise output on" : ""}` }));
}
var CONCISE_INSTRUCTION = "Output style, set by the user through Snout: be concise. Skip recaps of what you just did, don't restate code you wrote or files you read, and prefer short answers and diffs over long explanations unless asked. Keep the quality of the code and its tests unchanged.";
function withOutputStyle(cfg, out) {
  if (cfg.output !== "concise") return out;
  return { ...out, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CONCISE_INSTRUCTION } };
}
async function cmdAudit(args) {
  if (args[0] === "context") return cmdAuditContext(args.slice(1));
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : void 0;
  };
  const days = Math.max(1, Number(flag("--days")) || 30);
  const dir = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--days");
  const paths = resolvePaths(dir);
  const measure = args.includes("--measure");
  const reports = await auditServers(paths.projectDir, { days, measure });
  if (!reports.length) return say("No MCP servers are configured for this project, and none appear in its recent sessions. Nothing adds a tool list to your agent's requests.");
  const lines = [`MCP servers for ${paths.projectDir} \xB7 usage from the last ${days} days of Claude Code sessions`, ""];
  const unused = reports.filter((r) => r.calls === 0);
  for (const r of reports) {
    const used = r.calls === null ? "usage not tracked" : r.calls === 0 ? "never used" : `${r.calls} call${r.calls === 1 ? "" : "s"}`;
    const cost = r.listTokens !== void 0 ? ` \xB7 ${r.tools} tools, ~${fmtTokens(r.listTokens)} tokens per request` : r.measureError ? ` \xB7 ${r.measureError}` : "";
    lines.push(`  ${r.calls === 0 ? "\u2717" : "\xB7"} ${safeText(r.name, 40).padEnd(22)} ${used.padEnd(18)} ${r.source}${cost}`);
  }
  if (unused.length) {
    const perReq = unused.reduce((a, r) => a + (r.listTokens ?? 0), 0);
    lines.push("", `${unused.length} server${unused.length === 1 ? " was" : "s were"} never used, but still send ${unused.length === 1 ? "its" : "their"} tool list with every request${perReq ? ` (~${fmtTokens(perReq)} tokens each time)` : ""}. To turn ${unused.length === 1 ? "it" : "them"} off:`);
    for (const r of unused) lines.push(`  ${safeText(r.name, 40)}: ${disableHint(r)}`);
  } else lines.push("", "Every configured server was used. Nothing to turn off.");
  const saved = summarizeLedger(readDecisions(paths.ledger, 2e4)).byMcpServer.filter((m) => m.reads > 0);
  if (saved.length) {
    const held = saved.reduce((a, m) => a + m.heldBack, 0);
    const all = saved.reduce((a, m) => a + m.heldBack + m.inContext, 0);
    lines.push("", `Results Snout trimmed or skipped as repeats: ~${fmtTokens(held)} tokens saved, ${all ? Math.round(held / all * 100) : 0}% of what MCP servers returned`);
    for (const m of saved) lines.push(`  ${safeText(m.key, 40).padEnd(22)} ${`${m.reads} result${m.reads === 1 ? "" : "s"}`.padEnd(12)} ~${fmtTokens(m.inContext)} in context \xB7 ~${fmtTokens(m.heldBack)} saved`);
  }
  if (!measure) lines.push("", "Add --measure to start each local server once and count what its tool list costs.");
  if (reports.some((r) => r.source === "Claude account connector")) lines.push("Connectors from your Claude account can't be listed from local files, so unused ones don't show here. Claude Code loads large tool sets on demand, which limits their cost; review them at claude.ai \u2192 Settings \u2192 Connectors.");
  say(lines.join("\n"));
}
async function cmdAuditContext(args) {
  const valued = /* @__PURE__ */ new Set(["--days", "--restore", "--max-tokens"]);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : void 0;
  };
  const ai = args.indexOf("--archive");
  const archivePaths = ai >= 0 ? args.slice(ai + 1).filter((a) => !a.startsWith("-")) : [];
  const dir = ai >= 0 ? void 0 : args.find((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
  const paths = resolvePaths(dir);
  const projectDir = paths.projectDir;
  if (args.includes("--restore")) {
    const id = flag("--restore");
    if (!id || id.startsWith("-")) {
      const list = listArchives(projectDir);
      if (!list.length) return say("No archives in .snout/archive/.");
      return say(["Archives (restore with: snout audit context --restore <id>)", ...list.map((m) => `  ${m.id}  ${m.files.length} file${m.files.length === 1 ? "" : "s"}: ${m.files.slice(0, 3).map((f) => f.path).join(", ")}${m.files.length > 3 ? ", \u2026" : ""}`)].join("\n"));
    }
    try {
      const r = restoreArchive(projectDir, id);
      return say([`Restored ${r.restored.length} file${r.restored.length === 1 ? "" : "s"} from ${id}.`, ...r.restored.map((p) => `  ${p}`), ...r.skipped.length ? [`Left in the archive (a file is back at that path, or it's missing): ${r.skipped.join(", ")}`] : []].join("\n"));
    } catch (err) {
      return say(`snout audit context: ${err.message}`);
    }
  }
  if (ai >= 0) {
    if (!archivePaths.length) return say("Usage: snout audit context --archive <path> [more paths]");
    const audit2 = auditContext(projectDir, { days: Math.max(1, Number(flag("--days")) || 30), noGit: true });
    const kinds = new Map(audit2.files.map((f) => [f.path, f]));
    const lines = archivePaths.map((p) => {
      const f = kinds.get(p.replace(/^\.\//, ""));
      return `  ${p}${f ? `  (${f.kind}${f.kind === "always" ? ", loaded into every session" : ""})` : ""}`;
    });
    const instructions2 = archivePaths.some((p) => kinds.get(p.replace(/^\.\//, ""))?.kind === "always");
    say([`Move ${archivePaths.length} file${archivePaths.length === 1 ? "" : "s"} to .snout/archive/ (restorable with --restore):`, ...lines, ...instructions2 ? ["Includes instruction files your agents load every session; they will stop seeing them."] : []].join("\n"));
    if (!args.includes("--yes")) {
      if (!process.stdin.isTTY) return say("Not moved. Confirm by running it again with --yes.");
      const answer = await new Promise((done) => {
        process.stdout.write("Move them? [y/N] ");
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", (d) => {
          process.stdin.pause();
          done(String(d).trim().toLowerCase());
        });
      });
      if (answer !== "y" && answer !== "yes") return say("Not moved.");
    }
    try {
      const m = archiveFiles(projectDir, archivePaths);
      return say(`Archived to .snout/archive/${m.id}/. Undo with: snout audit context --restore ${m.id}`);
    } catch (err) {
      return say(`snout audit context: ${err.message}. Nothing was moved.`);
    }
  }
  const days = Math.max(1, Number(flag("--days")) || 30);
  const max = Number(flag("--max-tokens")) || void 0;
  const ledger = readDecisions(paths.ledger, 2e4).map((r) => ({ path: r.path, ts: r.ts }));
  const audit = auditContext(projectDir, { days, ledger, oversizedTokens: max });
  if (args.includes("--json")) return say(JSON.stringify(toJson(audit), null, 2));
  if (args.includes("--map")) return say(renderMap(audit));
  say(renderAudit(audit, { all: args.includes("--all") }));
}
function cmdOutput(paths, cfg, args) {
  const v = args[0];
  if (v === "concise" || v === "normal") {
    setConfigKey(paths.config, "output", v);
    return say(v === "concise" ? "Concise output on. New sessions start with one short instruction (~60 tokens) to skip recaps and restated code. Turn it off with `snout output normal`." : "Concise output off. Snout adds nothing to the agent's context.");
  }
  say(`Output style is "${cfg.output ?? "normal"}". Usage: snout output concise|normal`);
}
var FIRST_RUN_MIN_READS = 3;
function firstRunReport(paths, cfg, s) {
  const flag = join21(paths.snoutDir, "first-run.json");
  if (cfg.mode !== "observe" || existsSync16(flag) || s.reads < FIRST_RUN_MIN_READS || s.couldHoldBack <= 0) return null;
  let usd = "";
  try {
    const rate = summarizeSpend([...readSpend(paths.projectDir, spendCache(paths), configDir()).values()].flat()).inputRate;
    if (rate) usd = ` (~$${(s.couldHoldBack * rate / 1e6).toFixed(2)} at your model mix, counted once)`;
  } catch {
  }
  try {
    writeAtomic(flag, JSON.stringify({ shownAt: (/* @__PURE__ */ new Date()).toISOString() }) + "\n");
  } catch {
    return null;
  }
  const junk = s.recent.filter((r) => r.outcome === "would hold back").length;
  return `Snout watched ${s.reads} read${s.reads === 1 ? "" : "s"}${junk ? `; ${junk} of them would have been trimmed` : ""}: in enforce mode it would have kept ~${fmtTokens(s.couldHoldBack)} tokens out of context${usd}. Turn it on with /snout:mode enforce (or snout mode enforce).`;
}
function setMode(paths, next) {
  setConfigKey(paths.config, "mode", next);
  if (next === "observe") {
    removeGate(paths.projectDir);
    return "Observe: Snout records what agents read and trims nothing.";
  }
  installGate(paths.projectDir, BIN, loadConfig(paths).fastHooks !== false);
  return `${next === "enforce" ? "Enforce: Snout gates what enters context (trims bulky reads and results, sends long docs by section, skips repeats)" : "Advise: Snout asks before a read that would crowd context"}. New agent sessions pick it up; running ones after /reload-plugins.`;
}
function dashboardActions(paths) {
  return {
    mode: () => loadConfig(paths).mode,
    setMode: (m) => {
      if (m !== "observe" && m !== "advise" && m !== "enforce") throw new Error("unknown mode");
      return setMode(paths, m);
    },
    allow: (p) => {
      const target = p.trim();
      if (!target || target.length > 300 || target.includes("\0") || target.split(/[\\/]/).includes("..")) throw new Error("not a project path");
      const cfg = loadConfig(paths);
      if (!cfg.alwaysAllow.includes(target)) setConfigKey(paths.config, "alwaysAllow", [...cfg.alwaysAllow, target]);
      return `${target} will always be read in full.`;
    },
    coach: () => loadConfig(paths).coach ?? "tip",
    setCoach: (v) => {
      if (v !== "off" && v !== "tip" && v !== "jev") throw new Error("unknown coach mode");
      setConfigKey(paths.config, "coach", v);
      return v === "off" ? "Prompt coach off." : "Prompt coach on.";
    },
    cloud: () => {
      const c = loadCredentials();
      return c ? { loggedIn: true, team: c.team } : { loggedIn: false };
    },
    login: () => {
      spawn2(process.execPath, [BIN, "login", paths.projectDir], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {
      }).unref();
      return "Opening the sign-in page in your browser.";
    }
  };
}
var SQUEEZE_LOGS_KEPT = 30;
function firstForCall(paths, id) {
  if (!id) return true;
  const dir = join21(paths.snoutDir, "calls");
  try {
    mkdirSync10(dir, { recursive: true });
    writeFileSync6(join21(dir, createHash4("sha256").update(id).digest("hex").slice(0, 24)), "", { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") return false;
    return true;
  }
  try {
    const all = readdirSync5(dir);
    if (all.length > 400) for (const f of all.map((f2) => ({ f: f2, t: statSync16(join21(dir, f2)).mtimeMs })).sort((a, b) => a.t - b.t).slice(0, all.length - 200)) rmSync3(join21(dir, f.f), { force: true });
  } catch {
  }
  return true;
}
var duplicateCall = false;
function onSqueeze(input, paths, cfg) {
  const started = Date.now();
  duplicateCall = !firstForCall(paths, input.tool_use_id);
  if ((input.tool_name ?? "").startsWith("mcp__")) return onMcpTrim(input, paths, cfg, started);
  const command = stringField(input.tool_input, "command") ?? "";
  const resp = input.tool_response;
  const kind = kindOf(command);
  if (cfg.mode === "observe" || !kind || !resp || typeof resp !== "object" || typeof resp.stdout !== "string" || resp.interrupted === true || resp.isImage === true) {
    emit({});
    return;
  }
  const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
  const full = stderr ? `${resp.stdout}
${stderr}` : resp.stdout;
  if (cfg.repeatReads !== false) {
    const state2 = loadState(paths.state, input.session_id ?? "unknown");
    const prior = repeatOutput(paths.snoutDir, state2.session, input.agent_id, `Bash:${command}`, full, state2.turn, input.tool_use_id);
    if (prior) {
      const note = `snout: same output as when you ran this command at turn ${prior.turn}, earlier in this conversation. Nothing changed; use that copy.`;
      recordRepeatOutput(input, paths, state2, "Bash", `$ ${safeText(command, 80)}`, full.length, note.length, started, cfg);
      return emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...resp, stdout: note, stderr: "" } } });
    }
  }
  const dir = join21(paths.snoutDir, "squeeze");
  const logName = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${createHash4("sha256").update(command).digest("hex").slice(0, 8)}.log`;
  const s = squeeze(kind, full, `.snout/squeeze/${logName}`);
  if (!s) {
    emit({});
    return;
  }
  try {
    mkdirSync10(dir, { recursive: true });
    writeAtomic(join21(dir, logName), `$ ${command}

${full}`);
    const logs = readdirSync5(dir).filter((f) => f.endsWith(".log")).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - SQUEEZE_LOGS_KEPT))) rmSync3(join21(dir, old), { force: true });
  } catch (err) {
    recordError("squeeze log", err);
    emit({});
    return;
  }
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const before = estimateTokens(s.beforeBytes, "output.txt");
  const after = estimateTokens(s.afterBytes, "output.txt");
  recordRow(paths.ledger, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    tool: "Bash",
    path: `$ ${safeText(command, 80)}`,
    tier: 0,
    rule: "command-output",
    value: 1,
    confidence: 1,
    decision: "deny",
    mode: cfg.mode,
    reason: `Squeezed ${kind} output: kept ${s.afterLines} of ${s.beforeLines} lines`,
    bytes: s.beforeBytes,
    tokensAvoidedEst: Math.max(0, before - after),
    tokensReadEst: after,
    jevInputTokens: 0,
    latencyMs: Date.now() - started,
    model: null,
    reversedByUser: false,
    trimmed: true,
    ...input.agent_id ? { agentId: input.agent_id, agentType: input.agent_type } : {}
  });
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...resp, stdout: s.text, stderr: "" } } });
}
var mcpPath = (tool) => `mcp: ${tool.replace(/^mcp__/, "").replace(/__/g, " \u203A ")}`;
function recordRepeatOutput(input, paths, state, tool, path, beforeChars, afterChars, started, cfg) {
  const before = estimateTokens(beforeChars, "output.json");
  const after = estimateTokens(afterChars, "output.json");
  recordRow(paths.ledger, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    tool,
    path,
    tier: 0,
    rule: "repeat-output",
    value: 1,
    confidence: 1,
    decision: "deny",
    mode: cfg.mode,
    reason: "Identical to a result this agent already received",
    bytes: beforeChars,
    tokensAvoidedEst: Math.max(0, before - after),
    tokensReadEst: after,
    jevInputTokens: 0,
    latencyMs: Date.now() - started,
    model: null,
    reversedByUser: false,
    trimmed: true,
    ...input.agent_id ? { agentId: input.agent_id, agentType: input.agent_type } : {}
  });
}
function onMcpTrim(input, paths, cfg, started) {
  const tool = safeText(input.tool_name ?? "mcp", 80);
  if (cfg.mode === "observe") return emit({});
  if (cfg.repeatReads !== false) {
    const text = JSON.stringify(input.tool_response ?? null);
    const state2 = loadState(paths.state, input.session_id ?? "unknown");
    const prior = repeatOutput(paths.snoutDir, state2.session, input.agent_id, tool, text, state2.turn, input.tool_use_id);
    if (prior) {
      const note = `snout: identical to this tool's result at turn ${prior.turn}, which is earlier in this conversation and still accurate. Use that copy.`;
      recordRepeatOutput(input, paths, state2, tool, mcpPath(tool), text.length, note.length, started, cfg);
      return emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: [{ type: "text", text: note }] } });
    }
  }
  const dir = join21(paths.snoutDir, "squeeze");
  const logName = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${createHash4("sha256").update(tool).digest("hex").slice(0, 8)}.json`;
  const t = trimMcp(input.tool_response, `.snout/squeeze/${logName}`);
  if (!t) {
    recordToolOutput(input, paths, loadState(paths.state, input.session_id ?? "unknown"), responseBytes(input.tool_response));
    return emit({});
  }
  try {
    mkdirSync10(dir, { recursive: true });
    writeAtomic(join21(dir, logName), JSON.stringify({ tool, input: input.tool_input ?? null, output: input.tool_response }, null, 1));
    const logs = readdirSync5(dir).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - SQUEEZE_LOGS_KEPT))) rmSync3(join21(dir, old), { force: true });
  } catch (err) {
    recordError("mcp trim log", err);
    return emit({});
  }
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const before = estimateTokens(t.beforeChars, "output.json");
  const after = estimateTokens(t.afterChars, "output.json");
  recordRow(paths.ledger, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    tool,
    path: mcpPath(tool),
    tier: 0,
    rule: "mcp-output",
    value: 1,
    confidence: 1,
    decision: "deny",
    mode: cfg.mode,
    reason: `Trimmed ${tool} result: ${t.beforeChars} \u2192 ${t.afterChars} characters`,
    bytes: t.beforeChars,
    tokensAvoidedEst: Math.max(0, before - after),
    tokensReadEst: after,
    jevInputTokens: 0,
    latencyMs: Date.now() - started,
    model: null,
    reversedByUser: false,
    trimmed: true,
    ...input.agent_id ? { agentId: input.agent_id, agentType: input.agent_type } : {}
  });
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: t.output } });
}
function onPromptSubmit(input, paths, cfg) {
  const session = input.session_id ?? "unknown";
  const state = loadState(paths.state, session);
  state.turn += 1;
  state.goalHash = createHash4("sha256").update(input.prompt ?? "").digest("hex").slice(0, 12);
  const tip = coachPrompt(input.prompt ?? "", paths, cfg, state);
  const files = cfg.repoMap ? suggestFiles(input.prompt ?? "", paths, cfg, state) : "";
  saveState(paths.state, state);
  emit({
    ...tip ? { systemMessage: tip } : {},
    ...files ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: files } } : {}
  });
}
var MAP_CANDIDATES = 4;
function refreshMap(paths, cfg) {
  let prev = null;
  try {
    prev = JSON.parse(readFileSync19(paths.map, "utf8"));
  } catch {
  }
  const lowValue = (rel) => {
    try {
      return decide({ absPath: join21(paths.projectDir, rel), projectDir: paths.projectDir, cfg }).value === 0;
    } catch {
      return false;
    }
  };
  const { map, read: read3 } = buildMap(paths.projectDir, prev, lowValue);
  if (read3 || !prev) {
    ensureDir(paths.snoutDir);
    writeAtomic(paths.map, JSON.stringify(map));
  }
  return map;
}
function suggestFiles(prompt, paths, cfg, state) {
  if (!prompt.trim()) return "";
  try {
    const cs = candidates(refreshMap(paths, cfg), prompt, MAP_CANDIDATES);
    if (!shouldSuggest(cs, prompt)) return "";
    const line = renderCandidates(cs.map((c) => ({ ...c, path: safePath(c.path) })));
    appendRow(join21(paths.snoutDir, "map-suggestions.jsonl"), {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: state.session,
      turn: state.turn,
      paths: cs.map((c) => c.path),
      tokensEst: estimateTokens(Buffer.byteLength(line), "x.txt")
    });
    return line;
  } catch (err) {
    recordError("repoMap", err);
    return "";
  }
}
function cmdFast(paths, cfg, v) {
  if (v !== "on" && v !== "off") return say(`Fast hooks are ${cfg.fastHooks !== false ? "on" : "off"}. Usage: snout fast on|off`);
  setConfigKey(paths.config, "fastHooks", v === "on");
  if (cfg.mode !== "observe") installGate(paths.projectDir, BIN, v === "on");
  say(v === "on" ? `Fast hooks on. Gated calls go to a local Snout server on 127.0.0.1:${HOOK_PORT} instead of starting Node each time; it starts with the next session and stops after 30 idle minutes. If it is down, the agent carries on ungated.` : "Fast hooks off. Each gated call runs its own Snout process.");
}
var SERVE_IDLE_MS = 30 * 6e4;
var healthUrl = () => `http://127.0.0.1:${HOOK_PORT}/snout/v1/health`;
async function serverVersion() {
  try {
    const r = await fetch(healthUrl(), { signal: AbortSignal.timeout(300) });
    return r.ok ? (await r.json()).version ?? null : null;
  } catch {
    return null;
  }
}
async function ensureServer() {
  if (await serverVersion() === VERSION2) return;
  const child = spawn2(process.execPath, [BIN, "serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (await serverVersion() === VERSION2) return;
  }
}
function startServer() {
  const hosts = /* @__PURE__ */ new Set([`127.0.0.1:${HOOK_PORT}`, `localhost:${HOOK_PORT}`]);
  let idle = setTimeout(() => process.exit(0), SERVE_IDLE_MS);
  const { createServer } = createRequire2(import.meta.url)("node:http");
  const server = createServer((req, res) => {
    clearTimeout(idle);
    idle = setTimeout(() => process.exit(0), SERVE_IDLE_MS);
    const url = req.url ?? "";
    if (!hosts.has(req.headers.host ?? "")) return void res.writeHead(403).end();
    if (req.method === "GET" && url === "/snout/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ version: VERSION2 }));
    }
    if (req.method === "POST" && url === "/snout/v1/shutdown") {
      res.writeHead(200).end();
      return void setImmediate(() => process.exit(0));
    }
    const event = url.startsWith("/snout/v1/") ? url.slice("/snout/v1/".length) : "";
    if (req.method !== "POST" || !HOOK_EVENTS.has(event) || !String(req.headers["content-type"] ?? "").includes("application/json")) {
      return void res.writeHead(404).end();
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= 16 * 1024 * 1024) chunks.push(c);
    });
    req.on("end", () => {
      let body = "";
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        requestStart = performance.now();
        capturing = true;
        captured = null;
        client = void 0;
        duplicateCall = false;
        dispatch(event, input);
        if (captured) body = JSON.stringify(captured);
      } catch (err) {
        recordError("serve", err);
      } finally {
        capturing = false;
      }
      res.writeHead(200, body ? { "content-type": "application/json" } : {});
      res.end(body);
    });
  });
  server.on("error", async (err) => {
    if (err.code !== "EADDRINUSE") return process.exit(0);
    const v = await serverVersion();
    if (v && v !== VERSION2) {
      await fetch(`http://127.0.0.1:${HOOK_PORT}/snout/v1/shutdown`, { method: "POST" }).catch(() => {
      });
      setTimeout(() => server.listen(HOOK_PORT, "127.0.0.1"), 200);
    } else process.exit(0);
  });
  server.listen(HOOK_PORT, "127.0.0.1");
}
function cmdMap(paths, cfg, args) {
  const v = args[0];
  if (v === "on" || v === "off") {
    setConfigKey(paths.config, "repoMap", v === "on");
    return say(v === "on" ? "Repo map on. Each prompt that names code in this repo gets a short list of the files that define or use it (~300 tokens, paths only). Turn it off with `snout map off`." : "Repo map off. Snout adds nothing to your prompts.");
  }
  const t0 = Date.now();
  const map = refreshMap(paths, cfg);
  const n = Object.keys(map.files).length;
  const request = args.join(" ").trim();
  if (!request) return say(`Repo map: ${n} files indexed in ${Date.now() - t0} ms (${cfg.repoMap ? "on" : "off"}). Usage: snout map on|off \xB7 snout map "<request>"`);
  const line = renderCandidates(candidates(map, request, MAP_CANDIDATES).map((c) => ({ ...c, path: safePath(c.path) })));
  say(line || "No file in the map is linked to names in that request.");
}
var COACH_GAP_TURNS = 3;
function coachPrompt(prompt, paths, cfg, state) {
  const mode = cfg.coach ?? "tip";
  if (mode === "off" || !prompt) return null;
  try {
    const rules = scorePrompt(prompt);
    const c = mode === "jev" ? scoreWithJev(prompt, rules) : rules;
    const quiet = state.lastCoachTurn !== void 0 && state.turn - state.lastCoachTurn < COACH_GAP_TURNS;
    const tip = c.tip && !quiet ? c.tip : null;
    if (tip) state.lastCoachTurn = state.turn;
    if (c.taskLike) {
      appendRow(join21(paths.snoutDir, "prompts.jsonl"), {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        session: state.session,
        turn: state.turn,
        words: c.words,
        score: c.score,
        target: c.target,
        behavior: c.behavior,
        verify: c.verify,
        missing: c.missing,
        tipped: !!tip,
        source: c.source,
        ...client ? { client } : {}
      });
    }
    return tip;
  } catch (err) {
    recordError("coach", err);
    return null;
  }
}
function cmdCoach(paths, cfg, args) {
  const first2 = args[0];
  if (first2 === "off" || first2 === "tip" || first2 === "jev") {
    setConfigKey(paths.config, "coach", first2);
    const note = first2 === "jev" ? process.env.TYPESAFE_API_KEY ? " Prompts that look like tasks are now checked by TypeSafe's Jev; their text is sent to api.typesafe.ai." : " Set TYPESAFE_API_KEY first; until then the local rules are used." : first2 === "tip" ? " Local rules only; nothing leaves the machine." : "";
    return say(`Prompt coach: ${first2}.${note}`);
  }
  const prompt = args.join(" ").trim();
  if (!prompt) {
    return say(`Prompt coach is "${cfg.coach ?? "tip"}". Usage:
  snout coach "<prompt>"     score a prompt
  snout coach off|tip|jev    tip = local rules (default), jev = TypeSafe Jev (sends the prompt)`);
  }
  const rules = scorePrompt(prompt);
  const c = (cfg.coach ?? "tip") === "jev" ? scoreWithJev(prompt, rules) : rules;
  const mark = (ok) => ok ? "yes" : "no ";
  say([
    `prompt coach (${c.source}) \xB7 score ${c.score.toFixed(2)} \xB7 ${c.taskLike ? "task" : "not a task request, so no tip"}`,
    `  target    ${mark(c.target)}  the file, function or error it's about`,
    `  behavior  ${mark(c.behavior)}  what should happen, or what goes wrong now`,
    `  verify    ${mark(c.verify)}  the test or command that proves it`,
    c.tip ? `
  ${c.tip}` : c.taskLike ? "\n  Scoped well: the agent can go straight to the work." : ""
  ].join("\n"));
}
function onPreTool(input, paths, cfg) {
  const tool = input.tool_name ?? "";
  if (tool === "Bash") {
    const command = stringField(input.tool_input, "command");
    const targets = command ? dumpTargets(command, paths.projectDir) : [];
    const state2 = loadState(paths.state, input.session_id ?? "unknown");
    if (targets.length && cfg.repeatReads !== false && cfg.mode === "enforce") {
      const agentId = agentOf2(input).agentId;
      const seen = targets.map((a) => ({ abs: a, rel: toRel(a, paths.projectDir) })).map((t) => ({ ...t, prior: repeatOf(paths.snoutDir, state2.session, agentId, t.abs, t.rel, "full") }));
      if (seen.every((t) => t.prior)) return repeatDumpResponse(input, paths, state2, seen);
    }
    for (const absPath2 of targets) {
      const g2 = classifyForGate(input, paths, cfg, state2, absPath2);
      if (g2.d.verdict === "allow") continue;
      recordRow(paths.ledger, g2.row);
      return gateResponse(input, paths, state2, g2, "Printing it whole with Bash is gated like a Read.");
    }
    emit({});
    return;
  }
  const filePath = stringField(input.tool_input, "file_path") ?? stringField(input.tool_input, "notebook_path");
  if (!GATED_TOOLS.has(tool) || !filePath) {
    emit({});
    return;
  }
  const absPath = isAbsolute11(filePath) ? filePath : join21(paths.projectDir, filePath);
  const state = loadState(paths.state, input.session_id ?? "unknown");
  if (tool === "Read" && cfg.repeatReads !== false) {
    const rel = toRel(absPath, paths.projectDir);
    const window = requestedWindow(input.tool_input);
    const prior = repeatOf(paths.snoutDir, state.session, agentOf2(input).agentId, absPath, rel, window, !client);
    if (prior) return repeatResponse(input, paths, state, absPath, rel, window, prior);
  }
  const windowBytes = readWindowBytes(input, absPath);
  const g = classifyForGate(input, paths, cfg, state, absPath, windowBytes);
  if (!client && tool === "Read" && windowBytes === void 0 && overNativeReadLimit(absPath)) {
    recordRow(paths.ledger, { ...g.row, decision: "allow", tokensAvoidedEst: 0, tokensReadEst: 0, reason: "Over Claude Code's 256 KB read limit, which refuses this read itself" });
    emit({});
    return;
  }
  if (g.d.verdict === "deny" && windowBytes === void 0 && tool === "Read") {
    const head = headWindow(absPath);
    if (head) return trimResponse(input, paths, g, head);
  }
  if ((g.d.verdict === "allow" || g.d.rule === "oversized") && tool === "Read" && windowBytes === void 0 && cfg.mode === "enforce" && cfg.longDocs !== false && g.d.rule !== "always-allow") {
    const doc = longDocOf(absPath, g.rel);
    if (doc) return docResponse(input, paths, g, doc);
  }
  recordRow(paths.ledger, g.row);
  if (g.d.verdict === "allow") {
    emit({});
    return;
  }
  gateResponse(input, paths, state, g, "");
}
var NATIVE_READ_MAX_BYTES = 256 * 1024;
var overNativeReadLimit = (absPath) => sizeOf(absPath) > NATIVE_READ_MAX_BYTES;
function isRegularFile(absPath) {
  try {
    return statSync16(absPath).isFile();
  } catch {
    return false;
  }
}
function readWindowBytes(input, absPath) {
  const t = input.tool_input ?? {};
  const limit = typeof t.limit === "number" ? t.limit : Number(t.limit);
  if (!Number.isFinite(limit) || limit <= 0) return void 0;
  const offset = Math.max(1, typeof t.offset === "number" ? t.offset : Number(t.offset) || 1);
  try {
    const lines = readFileSync19(absPath, "utf8").split("\n").slice(offset - 1, offset - 1 + limit);
    return Buffer.byteLength(lines.join("\n"));
  } catch {
    return void 0;
  }
}
function contentsOf(absPath, rel, rule) {
  try {
    const size = sizeOf(absPath);
    if (size > 4 * 1024 * 1024) return { outline: "", oneLine: false };
    const text = readFileSync19(absPath, "utf8");
    const lines = text.split("\n").length;
    return { outline: outline(rel, rule, text), oneLine: size / lines > 1e3 };
  } catch {
    return { outline: "", oneLine: false };
  }
}
var TRIM_LINES = 60;
var TRIM_BYTES = 6 * 1024;
function headWindow(absPath) {
  try {
    if (sizeOf(absPath) > 16 * 1024 * 1024) return null;
    const all = readFileSync19(absPath, "utf8").split("\n");
    let bytes = 0, lines = 0;
    for (const line of all.slice(0, TRIM_LINES)) {
      const b = Buffer.byteLength(line) + 1;
      if (bytes + b > TRIM_BYTES) break;
      bytes += b;
      lines++;
    }
    return lines >= 5 ? { lines, bytes, totalLines: all.length } : null;
  } catch {
    return null;
  }
}
function trimResponse(input, paths, g, head) {
  const { absPath, rel, d, estimated } = g;
  const headTokens = estimateTokens(head.bytes, rel);
  recordRow(paths.ledger, {
    ...g.row,
    tokensAvoidedEst: Math.max(0, estimated - headTokens),
    tokensReadEst: headTokens,
    trimmed: true,
    range: `1:${head.lines}`
  });
  const contents = contentsOf(absPath, rel, d.rule);
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input.tool_input ?? {}, offset: 1, limit: head.lines },
      // Model-visible. Everything from the file went through outline()'s allow-list, and
      // the path through safePath (inside withOverride and d.reason).
      additionalContext: withOverride(
        `snout trimmed this read: ${d.reason} (~${fmtTokens(estimated)} tokens), so only lines 1\u2013${head.lines} of ${head.totalLines} were returned.${contents.outline} Read other ranges with offset and limit.${searchHint(d.rule, rel, { oneLine: contents.oneLine })}`,
        rel
      )
    },
    systemMessage: `snout trimmed: ${safePath(rel)} \xB7 ${d.rule} \xB7 lines 1\u2013${head.lines} of ${head.totalLines}, ~${fmtTokens(Math.max(0, estimated - headTokens))} tokens withheld`
  });
}
function longDocOf(absPath, rel) {
  try {
    const size = sizeOf(absPath);
    if (size > 16 * 1024 * 1024) return null;
    return docWindow(rel, size >= 32 * 1024 ? readFileSync19(absPath, "utf8") : "", size);
  } catch {
    return null;
  }
}
function docResponse(input, paths, g, doc) {
  const { rel, estimated } = g;
  const got = estimateTokens(doc.bytes, rel);
  const end = doc.start + doc.lines - 1;
  const rule = doc.kind === "doc" ? "long-doc" : "long-log";
  const what = doc.kind === "doc" ? `a long document (~${fmtTokens(estimated)} tokens)` : `a long log (~${fmtTokens(estimated)} tokens)`;
  recordRow(paths.ledger, {
    ...g.row,
    rule,
    value: 1,
    confidence: 1,
    decision: "deny",
    reason: doc.kind === "doc" ? "Long document: opening and section map returned" : "Long log: last lines and error locations returned",
    tokensAvoidedEst: Math.max(0, estimated - got),
    tokensReadEst: got,
    trimmed: true,
    range: `${doc.start}:${doc.lines}`
  });
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input.tool_input ?? {}, offset: doc.start, limit: doc.lines },
      additionalContext: withOverride(
        `snout: ${safePath(rel)} is ${what}, so only lines ${doc.start}\u2013${end} of ${doc.totalLines} were returned.${doc.map} Read the part you need with offset and limit; any ranged read comes back in full.`,
        rel
      )
    },
    systemMessage: `snout section read: ${safePath(rel)} \xB7 lines ${doc.start}\u2013${end} of ${doc.totalLines}, ~${fmtTokens(Math.max(0, estimated - got))} tokens not loaded`
  });
}
function repeatDumpResponse(input, paths, state, files) {
  for (const f of files) {
    const bytes = sizeOf(f.abs);
    recordRow(paths.ledger, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: state.session,
      turn: state.turn,
      tool: "Bash",
      path: f.rel,
      tier: 0,
      rule: "repeat-read",
      value: 1,
      confidence: 1,
      decision: "deny",
      mode: "enforce",
      reason: "Unchanged since this agent last read it, so the full text is already in context.",
      bytes,
      tokensAvoidedEst: Math.max(0, estimateTokens(bytes, f.rel) - 30),
      tokensReadEst: 30,
      jevInputTokens: 0,
      latencyMs: elapsedMs(),
      model: null,
      reversedByUser: false,
      trimmed: true,
      ...agentOf2(input)
    });
  }
  const names = files.map((f) => safePath(f.rel)).join(", ");
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `snout: ${names} ${files.length > 1 ? "are" : "is"} unchanged since you read ${files.length > 1 ? "them" : "it"} in full earlier in this conversation (turn ${files[0].prior.turn}). That copy is still accurate; use it instead of printing ${files.length > 1 ? "them" : "it"} again.`
    }
  });
}
var describeWindow = (w) => {
  if (w === "full") return "the whole file";
  const [start, count] = w.split(":").map(Number);
  return `lines ${start}\u2013${start + count - 1}`;
};
function repeatResponse(input, paths, state, absPath, rel, window, prior) {
  const bytes = window === "full" ? sizeOf(absPath) : readWindowBytes(input, absPath) ?? sizeOf(absPath);
  const estimated = estimateTokens(bytes, rel);
  recordRow(paths.ledger, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    tool: input.tool_name ?? "",
    path: rel,
    tier: 0,
    rule: "repeat-read",
    value: 1,
    confidence: 1,
    decision: "allow",
    mode: "enforce",
    reason: "Unchanged since this agent last read it, so the full text is already in context.",
    bytes,
    tokensAvoidedEst: Math.max(0, estimated - 20),
    tokensReadEst: 20,
    jevInputTokens: 0,
    latencyMs: elapsedMs(),
    model: null,
    reversedByUser: false,
    trimmed: true,
    range: "1:1",
    ...readShape(input, absPath),
    ...agentOf2(input)
  });
  const t = input.tool_input ?? {};
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...t, offset: Number(t.offset) || 1, limit: 1 },
      additionalContext: withOverride(
        `snout: ${safePath(rel)} is unchanged since you read ${describeWindow(prior.window)} earlier in this conversation${prior.turn ? ` (turn ${prior.turn})` : ""}${window === prior.window ? "" : `, which includes ${describeWindow(window)}`}, so only its first line was returned. Use that earlier copy; it is still accurate.`,
        rel
      )
    }
  });
}
function classifyForGate(input, paths, cfg, state, absPath, windowBytes) {
  const rel = toRel(absPath, paths.projectDir);
  const bytes = windowBytes ?? sizeOf(absPath);
  const estimated = estimateTokens(bytes, rel);
  let d = decide({ absPath, projectDir: paths.projectDir, cfg });
  if (d.rule === "oversized" && windowBytes !== void 0 && windowBytes <= cfg.sizeCapBytes) {
    d = { ...d, verdict: "allow", suppressedByMode: true };
  }
  if (d.verdict !== "allow" && !worthGating(d, isRegularFile(absPath), estimated)) {
    d = { ...d, verdict: "allow", suppressedByMode: true };
  }
  const flagged = d.value <= 1;
  const row = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    tool: input.tool_name ?? "",
    path: rel,
    tier: d.tier,
    rule: d.rule,
    value: d.value,
    confidence: d.confidence,
    decision: d.verdict,
    mode: cfg.mode,
    reason: d.reason,
    bytes,
    tokensAvoidedEst: flagged ? estimated : 0,
    tokensReadEst: d.verdict === "allow" ? estimated : 0,
    jevInputTokens: 0,
    latencyMs: elapsedMs(),
    model: null,
    reversedByUser: false,
    ...readShape(input, absPath),
    ...agentOf2(input)
  };
  return { absPath, rel, d, estimated, row };
}
function gateResponse(input, paths, state, g, lead) {
  const { absPath, rel, d, estimated } = g;
  const contents = contentsOf(absPath, rel, d.rule);
  rememberPending(paths, state, input.tool_use_id, rel, d.verdict);
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: d.verdict,
      permissionDecisionReason: withOverride(
        `${d.reason} (~${fmtTokens(estimated)} tokens, confidence ${d.confidence.toFixed(2)})${lead ? " " + lead : ""}${contents.outline}${searchHint(d.rule, rel, { oneLine: contents.oneLine })}`,
        rel
      )
    },
    // `rel` is attacker-controlled in any repository the user did not write, and this
    // string is shown to the user while the reason above is read by the model. Both go
    // through safePath.
    systemMessage: `snout ${d.verdict}: ${safePath(rel)} \xB7 ${d.rule} \xB7 ~${fmtTokens(estimated)} tokens`
  });
}
function onPostTool(input, paths, cfg) {
  maybeAutoSync(paths);
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const pending = state;
  const id = input.tool_use_id;
  const filePath = stringField(input.tool_input, "file_path") ?? stringField(input.tool_input, "notebook_path");
  const alreadyGated = Boolean(id && pending.pending?.[id]);
  if (input.tool_name === "Read" && filePath) {
    const window = returnedWindow(input.tool_response);
    if (window) {
      const abs = isAbsolute11(filePath) ? filePath : join21(paths.projectDir, filePath);
      rememberRead(paths.snoutDir, state.session, agentOf2(input).agentId, abs, toRel(abs, paths.projectDir), window, state.turn);
    }
  } else if (input.tool_name === "Bash") {
    const resp = input.tool_response;
    const command = stringField(input.tool_input, "command");
    if (command && resp && typeof resp.stdout === "string" && resp.interrupted !== true) {
      for (const abs of dumpTargets(command, paths.projectDir)) {
        rememberRead(paths.snoutDir, state.session, agentOf2(input).agentId, abs, toRel(abs, paths.projectDir), "full", state.turn);
      }
    }
  }
  if (filePath && !alreadyGated && !hasPreToolRow(paths, state, filePath, agentOf2(input).agentId)) {
    recordObservation(input, paths, cfg, filePath, state);
  } else if (!filePath && input.tool_name === "Bash") {
    recordBashReads(input, paths, cfg, state, alreadyGated ? pending.pending[id].path : void 0);
  } else if (!filePath && input.tool_name === "Grep") {
    recordGrep(input, paths, cfg, state);
  } else if (!filePath && isToolOutput(input.tool_name)) {
    if (!(cfg.mode === "enforce" && (input.tool_name ?? "").startsWith("mcp__"))) recordToolOutput(input, paths, state, responseBytes(input.tool_response));
  }
  if (id && pending.pending?.[id]) {
    const { path, decision: decision2 } = pending.pending[id];
    recordRow(paths.ledger, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: state.session,
      turn: state.turn,
      tool: input.tool_name ?? "",
      path,
      tier: 0,
      rule: "reversal",
      value: 3,
      confidence: 1,
      decision: "allow",
      mode: "observe",
      reason: `You overrode a ${decision2} decision for this file.`,
      bytes: 0,
      tokensAvoidedEst: 0,
      tokensReadEst: 0,
      jevInputTokens: 0,
      latencyMs: 0,
      model: null,
      reversedByUser: true,
      ...agentOf2(input)
    });
    debug("reversal", path, decision2);
    delete pending.pending[id];
    saveState(paths.state, pending);
  }
  emit({});
}
function onPreCompact(input, paths) {
  const state = loadState(paths.state, input.session_id ?? "unknown");
  forgetReads(paths.snoutDir, state.session);
  appendRow(paths.turns, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    goalHash: state.goalHash,
    decisions: { allow: 0, ask: 0, deny: 0 },
    tokensReadEst: 0,
    tokensAvoidedEst: 0,
    jevRequests: 0,
    jevInputTokens: 0,
    jevCostUsd: 0,
    latency: { p50: 0, p95: 0, max: 0 },
    compacted: true
  });
  emit({});
}
function onStop(input, paths, cfg) {
  maybeAutoSync(paths);
  const state = loadState(paths.state, input.session_id ?? "unknown");
  const rows = readDecisions(paths.ledger, 2e3).filter(
    (r) => r.session === state.session && r.turn === state.turn && r.rule !== "reversal"
  );
  if (rows.length === 0) {
    emit({});
    return;
  }
  const t = totalsOf(rows);
  rotateIfLarge(paths.ledger);
  rotateIfLarge(paths.turns);
  appendRow(paths.turns, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    goalHash: state.goalHash,
    decisions: { allow: t.allow, ask: t.ask, deny: t.deny },
    tokensReadEst: t.tokensReadEst,
    tokensAvoidedEst: t.tokensAvoidedEst,
    jevRequests: 0,
    jevInputTokens: t.jevInputTokens,
    jevCostUsd: t.jevInputTokens / 1e6 * JEV_USD_PER_MTOK,
    latency: {
      p50: percentile(t.latencies, 50),
      p95: percentile(t.latencies, 95),
      max: Math.max(0, ...t.latencies)
    },
    compacted: false
  });
  debug("turn", state.turn, "flagged", t.tokensAvoidedEst, "mode", cfg.mode);
  emit({});
}
function recordBashReads(input, paths, cfg, state, gatedRel) {
  const command = stringField(input.tool_input, "command");
  if (!command) return;
  const targets = readTargets(command, paths.projectDir).filter((p) => toRel(p, paths.projectDir) !== gatedRel);
  if (targets.length === 0) return;
  const returned = responseBytes(input.tool_response);
  const sizes = targets.map((p) => sizeOf(p));
  const total = sizes.reduce((a, b) => a + b, 0);
  targets.forEach((abs, i) => {
    const share = returned <= 0 ? sizes[i] : total > 0 ? Math.round(returned * (sizes[i] / total)) : Math.round(returned / targets.length);
    recordObservation(input, paths, cfg, abs, state, share);
  });
}
function recordGrep(input, paths, cfg, state) {
  const text = responseText(input.tool_response);
  if (!text) return;
  if (stringField(input.tool_input, "output_mode") !== "content") {
    recordToolOutput(input, paths, state, Buffer.byteLength(text));
    return;
  }
  const { files, rest } = splitGrepOutput(text, input.cwd ?? paths.projectDir, stringField(input.tool_input, "path") ?? void 0);
  for (const [abs, bytes] of files) recordObservation(input, paths, cfg, abs, state, bytes);
  if (rest > 0) recordToolOutput(input, paths, state, rest);
}
function isToolOutput(tool) {
  return tool === "Glob" || tool === "Grep" || tool === "WebFetch" || tool === "WebSearch" || (tool ?? "").startsWith("mcp__");
}
function recordToolOutput(input, paths, state, bytes) {
  if (bytes <= 0) return;
  const tool = input.tool_name ?? "";
  const t = input.tool_input ?? {};
  const label = tool === "WebFetch" ? stringField(t, "url") ?? "web" : tool === "WebSearch" ? `search: ${stringField(t, "query") ?? ""}` : tool === "Glob" || tool === "Grep" ? `${tool.toLowerCase()}: ${stringField(t, "pattern") ?? ""}` : tool;
  const shape = tool === "WebFetch" || tool === "WebSearch" ? "x.md" : tool.startsWith("mcp__") ? "x.json" : "x";
  const tokens2 = estimateTokens(bytes, shape);
  recordRow(paths.ledger, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    tool,
    path: label.slice(0, 300),
    tier: 0,
    rule: "tool-output",
    value: 2,
    confidence: 0,
    decision: "allow",
    mode: "observe",
    reason: "Tool output with no file to classify; measured, not judged.",
    bytes,
    tokensAvoidedEst: 0,
    tokensReadEst: tokens2,
    jevInputTokens: 0,
    latencyMs: elapsedMs(),
    model: null,
    reversedByUser: false,
    observedOnly: true,
    ...agentOf2(input)
  });
}
function recordObservation(input, paths, cfg, filePath, state, bytesHint) {
  const absPath = isAbsolute11(filePath) ? filePath : join21(paths.projectDir, filePath);
  const rel = toRel(absPath, paths.projectDir);
  const d = decide({ absPath, projectDir: paths.projectDir, cfg });
  const returned = bytesHint ?? responseBytes(input.tool_response);
  const bytes = returned > 0 ? returned : sizeOf(absPath);
  const estimated = estimateTokens(bytes, rel);
  const flagged = d.value <= 1;
  recordRow(paths.ledger, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    session: state.session,
    turn: state.turn,
    tool: input.tool_name ?? "",
    path: rel,
    tier: d.tier,
    rule: d.rule,
    value: d.value,
    confidence: d.confidence,
    // Nothing was gated: the read already happened. `decision` records what we would have
    // done, and `observedOnly` marks that we did not do it.
    decision: "allow",
    mode: cfg.mode,
    reason: d.reason,
    bytes,
    tokensAvoidedEst: flagged ? estimated : 0,
    tokensReadEst: estimated,
    jevInputTokens: 0,
    latencyMs: elapsedMs(),
    model: null,
    reversedByUser: false,
    observedOnly: true,
    ...readShape(input, absPath, bytesHint),
    ...agentOf2(input)
  });
}
function hasPreToolRow(paths, state, filePath, agentId) {
  const rel = toRel(isAbsolute11(filePath) ? filePath : join21(paths.projectDir, filePath), paths.projectDir);
  return readDecisions(paths.ledger, 12).some(
    (r) => r.path === rel && r.turn === state.turn && r.session === state.session && r.agentId === agentId && !r.observedOnly
  );
}
function cmdReport(paths, cfg, args) {
  const all = readDecisions(paths.ledger, 5e3);
  const allTurns = readTurns(paths.turns, 500);
  const session = currentSession(paths);
  const scoped = !args.includes("--all") && session !== null;
  const rows = scoped ? all.filter((r) => r.session === session) : all;
  const turns = scoped ? allTurns.filter((t) => t.session === session) : allTurns;
  let out = renderReport(rows, turns.filter((t) => !t.compacted), cfg.mode, {
    scope: scoped ? "this session" : "all sessions",
    gateInstalled: gateInstalled(paths),
    byAgent: args.includes("--by-agent")
  });
  const earlier = all.length - rows.length;
  if (scoped && earlier > 0) {
    out += `

  ${earlier} more row(s) from earlier sessions: snout report --all`;
  }
  try {
    const since = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const sp = summarizeSpend([...readSpend(paths.projectDir, spendCache(paths), configDir()).values()].flat(), since);
    if (sp.requests) {
      const held = dailyAggregates(rows, since).reduce((a, d) => a + d.heldBack, 0);
      out += `

  SPEND (last 30 days, API list prices, from the agents' own logs)
    $${sp.costUsd.toFixed(2)} across ${sp.requests.toLocaleString()} requests \xB7 top model ${sp.byModel[0]?.key ?? "?"}`;
      if (held) out += `
    Snout kept ~${fmtTokens(held)} tokens out: about $${(held * sp.inputRate / 1e6).toFixed(2)} at your blended input rate`;
      out += "\n    Every project on this machine: snout spend --all";
    }
  } catch (err) {
    recordError("report spend", err);
  }
  const tips = currentTips(paths, cfg);
  if (tips.length > 0) {
    out += `

  ${tips.length} suggested change(s), each with a preview and undo: snout apply`;
  }
  const compactions = turns.filter((t) => t.compacted).length;
  if (compactions > 0) {
    out += `

  Compacted ${compactions} time(s) \u2014 the outcome this plugin exists to postpone.`;
  }
  say(out);
}
function currentSession(paths) {
  try {
    const s = JSON.parse(readFileSync19(paths.state, "utf8"));
    return typeof s.session === "string" ? s.session : null;
  } catch {
    return null;
  }
}
function cmdStatusline(paths, cfg) {
  say(renderStatusline(readDecisions(paths.ledger, 500), cfg.mode));
}
function cmdMode(paths, cfg, next) {
  if (!next || !isValidMode(next)) {
    say(`mode is "${cfg.mode}". Usage: /snout:mode observe|advise|enforce

  observe  classify and report, block nothing (default)
  advise   ask before a read that would crowd context
  enforce  gate context: trim bulky reads and results, long docs by section, skip repeats`);
    return;
  }
  say(setMode(paths, next));
  if (next !== "observe") say("If Snout trims a file you need, `snout allow <file>` (or the button on the dashboard) keeps it whole.");
}
function cmdAllow(paths, cfg, target) {
  if (!target) {
    say("Usage: /snout:allow <path-or-glob>");
    return;
  }
  if (cfg.alwaysAllow.includes(target)) {
    say(`${target} is already on the always-allow list.`);
    return;
  }
  setConfigKey(paths.config, "alwaysAllow", [...cfg.alwaysAllow, target]);
  say(`Added ${target} to always-allow. It will never be flagged again.`);
}
var appliedPath = (paths) => join21(paths.snoutDir, "applied.jsonl");
function currentTips(paths, cfg) {
  let claudeMd = "";
  try {
    claudeMd = readFileSync19(join21(paths.projectDir, "CLAUDE.md"), "utf8");
  } catch {
  }
  return tipsOf(readDecisions(paths.ledger, 5e3), {
    mode: cfg.mode,
    alwaysAllow: cfg.alwaysAllow,
    claudeMd,
    gateInstalled: gateInstalled(paths)
  });
}
function cmdApply(paths, cfg, args) {
  if (args.includes("--undo")) return undoApply(paths);
  const n = Number(args.find((a) => /^\d+$/.test(a)));
  const tips = currentTips(paths, cfg);
  if (!n) {
    const out = ["snout apply \u2014 changes worth making, from your own history. Nothing changes until you confirm.", ""];
    if (tips.length === 0) out.push("  No tips yet. They appear once the same bulky file is read a few times.");
    tips.forEach((t, i) => {
      out.push(`  ${i + 1}. ${safeText(t.title, 90)}`);
      out.push(`     seen      ${safeText(t.evidence, 110)}`);
      out.push(`     effect    ${safeText(t.effect, 110)}`);
    });
    if (tips.length > 0) out.push("", "  Preview one: snout apply <n>");
    const results = appliedResults(paths);
    if (results.length > 0) out.push("", "  APPLIED", ...results);
    return say(out.join("\n"));
  }
  const tip = tips[n - 1];
  if (!tip) return say(`No tip ${n}. Run snout apply to list them.`);
  const toUser = args.includes("--user") && tip.kind !== "claude-md";
  const file2 = tip.kind === "claude-md" ? join21(paths.projectDir, "CLAUDE.md") : toUser ? userConfigPath() : paths.config;
  if (!args.includes("--yes")) {
    const lines = [
      `${n}. ${safeText(tip.title, 90)}`,
      `  seen      ${safeText(tip.evidence, 110)}`,
      // Shown exactly as it will be written: tipsOf only offers paths that need no escaping.
      `  change    ${tip.change}`,
      `  file      ${safeText(file2, 140)}`,
      `  effect    ${safeText(tip.effect, 110)}`,
      `  undo      snout apply --undo`,
      "",
      `  To apply: snout apply ${n} --yes${tip.kind === "claude-md" ? "" : "   (add --user to make it a default for every project)"}`
    ];
    return say(lines.join("\n"));
  }
  const row = { ts: (/* @__PURE__ */ new Date()).toISOString(), id: tip.id, kind: tip.kind, target: tip.target, file: file2 };
  if (tip.kind === "claude-md") {
    const line = claudeMdLine(tip.target, tip.rule ?? "");
    const existed = existsSync16(file2);
    const prev = existed ? readFileSync19(file2, "utf8") : "";
    writeAtomic(file2, prev + (prev === "" || prev.endsWith("\n") ? "" : "\n") + line + "\n");
    Object.assign(row, { line, created: !existed });
  } else {
    const key = tip.kind === "mode" ? "mode" : "alwaysAllow";
    const before = readLayer(file2)[key];
    const value = key === "mode" ? tip.target : [...cfg.alwaysAllow, tip.target];
    setConfigKey(file2, key, value);
    Object.assign(row, { key, before });
  }
  appendRow(appliedPath(paths), row);
  say(`Applied: ${safeText(tip.title, 90)}
  ${safeText(tip.change, 140)}
  Undo any time: snout apply --undo. Results show under snout apply once new sessions run.`);
}
function undoApply(paths) {
  const rows = readRows(appliedPath(paths), 500);
  const undone = new Set(rows.filter((r) => r.undone).map((r) => r.undone));
  const last = [...rows].reverse().find((r) => !r.undone && !undone.has(r.ts));
  if (!last) return say("Nothing to undo.");
  if (last.kind === "claude-md" && last.line) {
    const text = existsSync16(last.file) ? readFileSync19(last.file, "utf8") : "";
    const i = text.lastIndexOf(last.line + "\n");
    if (i < 0) return say(`The line snout added to ${safeText(last.file, 120)} is no longer there; nothing changed.`);
    const next = text.slice(0, i) + text.slice(i + last.line.length + 1);
    if (last.created && next.trim() === "") rmSync3(last.file, { force: true });
    else writeAtomic(last.file, next);
  } else if (last.key) {
    setConfigKey(last.file, last.key, last.before);
  }
  appendRow(appliedPath(paths), { ts: (/* @__PURE__ */ new Date()).toISOString(), undone: last.ts, id: last.id });
  say(`Undone: ${safeText(last.id, 120)}`);
}
function appliedResults(paths) {
  const rows = readRows(appliedPath(paths), 500);
  const undone = new Set(rows.filter((r) => r.undone).map((r) => r.undone));
  const live = rows.filter((r) => !r.undone && !undone.has(r.ts));
  if (live.length === 0) return [];
  const ledger = readDecisions(paths.ledger, 5e3);
  return live.map((a) => {
    const relevant = a.kind === "mode" ? ledger : ledger.filter((r) => r.path === a.target);
    const split = (after) => {
      const inScope = ledger.filter((r) => r.ts >= a.ts === after);
      const sessions = new Set(inScope.map((r) => r.session)).size;
      const tokens2 = relevant.filter((r) => r.ts >= a.ts === after && r.value <= 1 && r.rule !== "unclassified").reduce((x, r) => x + (r.tokensAvoidedEst || 0), 0);
      return { sessions, per: sessions > 0 ? Math.round(tokens2 / sessions) : 0 };
    };
    const b = split(false);
    const f = split(true);
    const result = f.sessions === 0 ? "no sessions since \u2014 results appear after the next one" : `~${fmtTokens(b.per)} \u2192 ~${fmtTokens(f.per)} bulky tokens per session (${f.sessions} session(s) since)`;
    return `    ${safeText(a.id, 70)}  \xB7  ${a.ts.slice(0, 10)}  \xB7  ${result}`;
  });
}
function cmdExplain(paths, cfg, args) {
  const json = args.includes("--json");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    say("Usage: /snout:explain <path> [--json]");
    return;
  }
  const absPath = isAbsolute11(target) ? target : join21(paths.projectDir, target);
  const rel = toRel(absPath, paths.projectDir);
  const bytes = sizeOf(absPath);
  const tokens2 = estimateTokens(bytes, rel);
  const input = { absPath, projectDir: paths.projectDir, cfg };
  const d = decide(input);
  const raw = tier0(input);
  const scores = scoreFile(input);
  const band = bandOf(raw);
  const label = labelOf(raw);
  const enforce = raw ? applyMode(raw, "enforce").verdict : "allow";
  const history = readDecisions(paths.ledger, 5e3).filter((r) => r.path === rel);
  if (json) {
    say(JSON.stringify({
      path: rel,
      bytes,
      tokensEst: tokens2,
      label,
      rule: d.rule,
      tier: d.tier,
      value: d.value,
      confidence: d.confidence,
      band,
      thresholds: THRESHOLDS,
      mode: cfg.mode,
      verdict: d.verdict,
      enforceVerdict: enforce,
      reason: d.reason,
      scores,
      seen: history.length
    }, null, 2));
    return;
  }
  const lines = [
    `${safePath(rel)}`,
    `  size            ${bytes} bytes (~${fmtTokens(tokens2)} tokens estimated)`,
    `  label           ${label}  \xB7  confidence ${d.confidence.toFixed(2)}  \xB7  rule ${d.rule} (tier ${d.tier})`,
    `  band            ${band.padEnd(5)} ${BAND_TEXT[band]}`,
    `  thresholds      act \u2265 ${THRESHOLDS.denyMinConfidence.toFixed(2)}  \xB7  ask \u2265 ${THRESHOLDS.askMinConfidence.toFixed(2)}  \xB7  below that, always read`,
    `  context value   ${d.value}/3`,
    `  verdict         ${d.verdict}${d.suppressedByMode ? ` in ${cfg.mode} mode (enforce would ${enforce})` : ""}`,
    `  why             ${d.reason}`
  ];
  if (history.length > 0) {
    lines.push(`  seen            ${history.length} time(s); last ${history[history.length - 1].ts}`);
  }
  lines.push("", "  SCORES          independent per label; read = 1 \u2212 the strongest flag");
  for (const x of scores) {
    const note = x.hint ? `near miss (${x.rule}), below the ask threshold: never acted on` : x.label === "read" ? "" : x.rule;
    lines.push(`    ${x.label.padEnd(13)} ${x.score.toFixed(2)}  ${bar(x.score, 20)}  ${note}`.trimEnd());
  }
  if (d.value <= 1) {
    lines.push("", `  Disagree? /snout:allow ${rel}`);
  }
  say(lines.join("\n"));
}
var BAND_TEXT = {
  act: "enforce withholds it; advise asks; observe records it",
  ask: "enforce and advise ask first; observe records it",
  read: "every mode reads it"
};
function bar(frac, width) {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return "\u2588".repeat(n) + "\xB7".repeat(width - n);
}
var SCAN_SKIP = /* @__PURE__ */ new Set([".git", ".hg", ".svn"]);
function gitListed(root) {
  try {
    const r = spawnSync4("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", timeout: 1e4, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}
var SCAN_MAX_FILES = 1e5;
function cmdScan(paths, cfg, args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : void 0;
  };
  const json = args.includes("--json");
  const t = { ...THRESHOLDS };
  for (const [name, key] of [["--deny", "denyMinConfidence"], ["--ask", "askMinConfidence"]]) {
    const v = flag(name);
    if (v === void 0) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) return say(`${name} takes a number from 0 to 1.`);
    t[key] = n;
  }
  if (t.askMinConfidence > t.denyMinConfidence) return say("--ask must not be above --deny.");
  const modeArg = flag("--mode");
  if (modeArg !== void 0 && !isValidMode(modeArg)) return say("--mode takes observe, advise or enforce.");
  const mode = modeArg ?? "enforce";
  const topN = Math.max(0, Math.min(100, Number(flag("--top") ?? 10) || 10));
  const valued = /* @__PURE__ */ new Set(["--deny", "--ask", "--mode", "--top"]);
  const target = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  const root = target ? isAbsolute11(target) ? target : join21(paths.projectDir, target) : paths.projectDir;
  const started = Date.now();
  const files = [];
  let truncated = false;
  const add = (abs) => {
    const input = { absPath: abs, projectDir: paths.projectDir, cfg };
    files.push({ rel: toRel(abs, paths.projectDir), bytes: sizeOf(abs), raw: tier0(input) });
  };
  const listed = args.includes("--all") ? null : gitListed(root);
  if (listed) {
    for (const rel of listed) {
      if (files.length >= SCAN_MAX_FILES) {
        truncated = true;
        break;
      }
      const abs = join21(root, rel);
      if (isRegularFile(abs)) add(abs);
    }
  }
  const walk2 = (dir) => {
    let entries;
    try {
      entries = readdirSync5(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      const abs = join21(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP.has(e.name)) walk2(abs);
      } else if (e.isFile()) {
        add(abs);
      }
    }
  };
  if (!listed) walk2(root);
  const ms = Date.now() - started;
  const sum = summarize(files, mode, t, topN);
  if (json) {
    say(JSON.stringify({ root: toRel(root, paths.projectDir) || ".", truncated, ms, ...sum }, null, 2));
    return;
  }
  say(renderScan(sum, toRel(root, paths.projectDir) || ".", truncated, ms));
}
function renderScan(sum, root, truncated, ms) {
  const pct2 = (n) => sum.tokens > 0 ? `${Math.round(n / sum.tokens * 100)}%` : "0%";
  const t = sum.thresholds;
  const lines = [
    `snout scan \u2014 ${safePath(root)} \xB7 ${sum.files} file(s) \xB7 ~${fmtTokens(sum.tokens)} tokens if every file were read whole \xB7 ${ms} ms`,
    `  thresholds: act \u2265 ${t.denyMinConfidence.toFixed(2)} \xB7 ask \u2265 ${t.askMinConfidence.toFixed(2)} \xB7 below that, always read`,
    "",
    "  BY LABEL          files      ~tokens   share"
  ];
  for (const r of sum.labels) {
    const share = sum.tokens > 0 ? r.tokens / sum.tokens : 0;
    lines.push(`    ${r.label.padEnd(13)} ${String(r.files).padStart(7)}  ${("~" + fmtTokens(r.tokens)).padStart(10)}  ${pct2(r.tokens).padStart(5)}  ${bar(share, 20)}`);
  }
  lines.push(
    "",
    "  BY BAND           files      ~tokens   share",
    `    act             ${String(sum.bands.act.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.act.tokens)).padStart(10)}  ${pct2(sum.bands.act.tokens).padStart(5)}   enforce withholds`,
    `    ask             ${String(sum.bands.ask.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.ask.tokens)).padStart(10)}  ${pct2(sum.bands.ask.tokens).padStart(5)}   asks first`,
    `    read            ${String(sum.bands.read.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.read.tokens)).padStart(10)}  ${pct2(sum.bands.read.tokens).padStart(5)}   always read`
  );
  if (sum.top.length > 0) {
    lines.push("", "  LARGEST FLAGGED");
    for (const f of sum.top) {
      lines.push(`    ${("~" + fmtTokens(f.tokens)).padStart(8)}  ${f.label.padEnd(11)} ${f.confidence.toFixed(2)}  ${f.band.padEnd(4)}  ${safePath(f.rel)}`);
    }
  }
  lines.push(
    "",
    `  An agent pays only for what it reads, so this is the exposure, not a session's cost \u2014`,
    `  /snout:report shows what was actually read. What-if: --deny 0.95 --ask 0.6 \xB7 --json for scripts.`
  );
  if (truncated) lines.push(`  Stopped at ${SCAN_MAX_FILES} files; pass a subdirectory to scan the rest.`);
  return lines.join("\n");
}
function cmdReset(paths) {
  for (const p of [paths.ledger, paths.turns, paths.errors, paths.hooks, paths.state]) {
    try {
      if (existsSync16(p)) writeAtomic(p, "");
    } catch (err) {
      recordError("reset", err);
    }
  }
  say("Cleared .snout/ledger.jsonl, turns.jsonl, errors.jsonl, hooks.jsonl and state.json.");
}
function cmdDoctor(paths, cfg) {
  const rows = readDecisions(paths.ledger, 5e3);
  const t = totalsOf(rows.filter((r) => r.rule !== "reversal"));
  const errors = existsSync16(paths.errors) ? readFileSync19(paths.errors, "utf8").trim().split("\n").filter(Boolean) : [];
  const lines = [
    `snout ${VERSION2}`,
    `  node            ${process.version}`,
    `  bundle          ${runningBundle()}`,
    `  project         ${paths.projectDir}`,
    `  .snout            ${existsSync16(paths.snoutDir) ? "present" : "MISSING"}`,
    `  config          ${existsSync16(paths.config) ? paths.config : "no project file"}`,
    `  user defaults   ${existsSync16(userConfigPath()) ? userConfigPath() : "none (~/.snout/config.json)"}`,
    `  mode from       ${configSource(paths, "mode")}`,
    `  mode            ${cfg.mode}`,
    `  decisions       ${rows.length}`,
    `  p95 latency     ${percentile(t.latencies, 95)} ms`,
    `  errors logged   ${errors.length}`,
    `  blocking hook   ${blockingHookLine(gateMatcher(paths))}`
  ];
  const seen = lastSeenByEvent(paths);
  lines.push("", "  HOOKS SEEN");
  if (seen.size === 0) {
    lines.push(
      "    none \u2014 no hook has ever run in this project.",
      "",
      "    That is an installation problem, not a quiet session. Check that /plugin lists",
      "    snout as enabled, then restart Claude Code: hooks are registered when",
      "    the session starts, so a plugin enabled mid-session does nothing until then."
    );
  } else {
    for (const event of RECORDING_HOOKS) {
      const ts = seen.get(event);
      lines.push(`    ${event.padEnd(14)} ${ts ? ago(ts) : "never"}`);
    }
    if (!seen.has("post-tool")) {
      const started = seen.get("session-start") ?? "";
      const stopped = seen.get("stop");
      const turnFinished = stopped !== void 0 && stopped > started;
      lines.push(
        "",
        "    Hooks are firing, but post-tool has never run \u2014 that is the one that classifies",
        ...turnFinished ? [
          "    reads. It matches Read, Bash, Grep, Glob, web and MCP tools. A turn has finished without one",
          "    firing, so either this session read nothing, or the running plugin predates the",
          "    Bash matcher \u2014 check the bundle line above, reinstall, and restart."
        ] : [
          "    reads. No turn has finished since the session started, so the likeliest reason",
          "    is that nothing has used the Read tool yet. Read one file and run doctor again;",
          "    if post-tool is still never, the installed copy may be stale: check its version",
          "    with /plugin and restart Claude Code after updating."
        ]
      );
    }
  }
  if (cfg.mode !== "observe" && !gateInstalled(paths)) {
    lines.push(
      "",
      `  Mode is "${cfg.mode}" but the blocking hook is not installed, so nothing can be`,
      "  blocked. Run /snout:mode " + cfg.mode + " again to install it."
    );
  }
  if (cfg.mode === "observe" && gateInstalled(paths)) {
    lines.push(
      "",
      '  The blocking hook is installed but mode is "observe", so it allows every read',
      "  and still costs a process per read. Run /snout:mode observe to remove it."
    );
  }
  if (errors.length > 0) lines.push("", "  Most recent error:", `  ${errors[errors.length - 1]}`);
  const tp = process.env.SNOUT_TRANSCRIPT;
  if (tp && existsSync16(tp)) {
    const u = readTranscriptUsage(readFileSync19(tp, "utf8"));
    lines.push(
      "",
      "  MEASURED FROM TRANSCRIPT",
      `    requests      ${u.requests}`,
      `    input (new)   ${fmtTokens(u.inputUncached)}`,
      `    cache create  ${fmtTokens(u.cacheCreate)}`,
      `    cache read    ${fmtTokens(u.cacheRead)}`,
      `    output        ${fmtTokens(u.output)}`
    );
  }
  say(lines.join("\n"));
}
var HELP = `snout ${VERSION2} \xB7 the context gate for coding agents

  snout                      status: mode, what's been kept out, what it saved
  snout init [agent]         set up claude, codex, cursor or gemini in this project
  snout scan                 how much of this repo is low-value context
  snout report               what was read, kept out and saved, with spend (--all for every session)
  snout replay [files]       what Snout would have saved on past sessions, offline (--last N, --compact-at 300k, --json)
  snout dashboard            live savings in the browser
  snout mode observe|enforce record only, or trim low-value reads
  snout explain <file>       why a file was trimmed        snout allow <file>   never trim it
  snout login                team dashboard (syncs daily totals, never code)

  Docs and advanced commands: https://github.com/biffbuster/snout-context#cli`;
function readStdin(timeoutMs = 1e3) {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  const buf = Buffer.allocUnsafe(65536);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let n;
    try {
      n = readSync4(0, buf, 0, buf.length, null);
    } catch (err) {
      const code = err.code;
      if (code === "EAGAIN") {
        sleepSync(2);
        continue;
      }
      if (code === "EOF" || code === "EBADF" || code === "ENXIO") break;
      throw err;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function readHookInput() {
  try {
    const raw = readStdin();
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    recordError("readHookInput", err);
    return {};
  }
}
var capturing = false;
var captured = null;
var client;
function recordRow(path, row) {
  if (duplicateCall) return;
  const r = row;
  let model = r.model;
  if (!model) {
    try {
      const st = JSON.parse(readFileSync19(join21(dirname10(path), "state.json"), "utf8"));
      if (st.model && st.session === r.session) model = st.model;
    } catch {
    }
  }
  appendRow(path, { ...row, ...model ? { model } : {}, ...client ? { client } : {} });
}
var replayDir = null;
function rebase(p, dir) {
  return { ...p, snoutDir: dir, config: join21(dir, "config.json"), thresholds: join21(dir, "thresholds.json"), ledger: join21(dir, "ledger.jsonl"), turns: join21(dir, "turns.jsonl"), errors: join21(dir, "errors.jsonl"), hooks: join21(dir, "hooks.jsonl"), state: join21(dir, "state.json"), map: join21(dir, "map.json") };
}
function runHook(command, input) {
  captured = null;
  capturing = true;
  client = void 0;
  try {
    dispatch(command, input);
  } catch (err) {
    recordError(`replay ${command}`, err);
  } finally {
    capturing = false;
  }
  debug("replay", command, String(input.tool_name), JSON.stringify(captured)?.slice(0, 160));
  return captured;
}
function cmdReplay(paths, args) {
  const json = args.includes("--json");
  const lastAt = args.indexOf("--last");
  const last = lastAt >= 0 ? Math.max(1, Number(args[lastAt + 1]) || 20) : 20;
  let files = args.filter((a, i) => a.endsWith(".jsonl") && args[i - 1] !== "--last");
  if (!files.length) {
    const dir = join21(process.env.CLAUDE_CONFIG_DIR || join21(homedir6(), ".claude"), "projects", resolve10(paths.projectDir).replace(/[^A-Za-z0-9]/g, "-"));
    files = existsSync16(dir) ? readdirSync5(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join21(dir, f)).sort((a, b) => statSync16(b).mtimeMs - statSync16(a).mtimeMs).slice(0, last) : [];
  }
  if (!files.length) return say("snout replay: no Claude Code sessions found for this project. Pass transcript files (.jsonl) to replay others.");
  const rows = [];
  const run = {
    pre: (input) => runHook("pre-tool", input),
    squeeze: (input) => runHook("squeeze", input),
    post: (input) => void runHook("post-tool", input)
  };
  for (const file2 of files) {
    const dir = mkdtempSync2(join21(tmpdir2(), "snout-replay-"));
    for (const name of ["config.json", "thresholds.json"]) {
      const from = join21(paths.snoutDir, name);
      if (existsSync16(from)) copyFileSync(from, join21(dir, name));
    }
    replayDir = dir;
    try {
      rows.push(replaySession(file2, run));
    } catch (err) {
      recordError("replay", err);
    } finally {
      replayDir = null;
      rmSync3(dir, { recursive: true, force: true });
    }
  }
  const capAt = args.indexOf("--compact-at");
  const caps = capAt >= 0 ? String(args[capAt + 1] ?? "").split(",").map((c) => Math.round(parseFloat(c) * (/k$/i.test(c) ? 1e3 : 1))).filter((c) => c > 0) : [];
  const whatIf = caps.map((cap2) => {
    const sum = (k) => files.reduce((a, f) => {
      const w = compactionWhatIf(f, cap2, COMPACTION_COSTS[k]);
      return { base: a.base + w.baseCost, cap: a.cap + w.capCost };
    }, { base: 0, cap: 0 });
    const u = sum("usual"), h = sum("harsh");
    return { cap: cap2, usual: u.base ? u.cap / u.base - 1 : 0, harsh: h.base ? h.cap / h.base - 1 : 0 };
  });
  if (json) return say(JSON.stringify({ totals: totals2(rows), sessions: rows, compactAt: whatIf }, null, 2));
  const lines = whatIf.map((w) => `  compacting at ${Math.round(w.cap / 1e3)}k tokens        ${(w.usual * 100).toFixed(1)}% cost (calibrated) \xB7 ${(w.harsh * 100).toFixed(1)}% if each compaction loses a lot`);
  say(renderReplay(rows) + (lines.length ? `

${lines.join("\n")}
  From the sessions' own token counts, flat prices; calibrated on two runs measured both ways, where live savings were larger.` : ""));
}
function emit(payload) {
  if (Object.keys(payload).length === 0) return;
  if (capturing) {
    captured = payload;
    return;
  }
  writeOut(JSON.stringify(payload));
}
function say(text) {
  writeOut(text + "\n");
}
function writeOut(text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (err) {
      const code = err.code;
      if (code === "EAGAIN") continue;
      if (code === "EPIPE") return;
      throw err;
    }
  }
}
function stringField(obj, key) {
  const v = obj?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function rememberPending(paths, state, id, path, decision2) {
  if (!id) return;
  const s = state;
  s.pending ??= {};
  s.pending[id] = { path, decision: decision2 };
  const keys = Object.keys(s.pending);
  if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete s.pending[k];
  saveState(paths.state, s);
}
function runningBundle() {
  const self = process.argv[1] ?? "unknown";
  const kind = self.includes("/.claude/plugins/cache/") ? "plugin" : /node_modules|\/bin\/snout$/.test(self) ? "npm" : "local checkout";
  return `${self}  (${kind})`;
}
function fastGateInstalled(paths) {
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      const pre = JSON.parse(readFileSync19(join21(paths.projectDir, ".claude", f), "utf8")).hooks?.PreToolUse ?? [];
      if (pre.some((e) => (e.hooks ?? []).some((h) => isSnoutUrl(h.url)))) return true;
    } catch {
    }
  }
  return false;
}
function gateInstalled(paths) {
  return gateMatcher(paths) !== null;
}
function blockingHookLine(matcher) {
  if (matcher === null) return "not installed \u2014 recording only";
  if (!matcher.split("|").includes("Bash")) {
    return `installed (PreToolUse: ${matcher}) \u2014 Bash is not gated, so a denied file can still be cat'd; run /snout:mode again to update`;
  }
  return "installed (PreToolUse)";
}
function gateMatcher(paths) {
  const tools = /* @__PURE__ */ new Set();
  let found = false;
  for (const f of ["settings.json", "settings.local.json"]) {
    const p = join21(paths.projectDir, ".claude", f);
    if (!existsSync16(p)) continue;
    try {
      const settings = JSON.parse(readFileSync19(p, "utf8"));
      const entries = settings.hooks?.PreToolUse ?? [];
      for (const entry of entries) {
        if (!(entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("snout.mjs") || isSnoutUrl(h.url))) continue;
        found = true;
        for (const t of (entry.matcher ?? "").split("|")) if (t) tools.add(t);
      }
    } catch (err) {
      recordError("gateInstalled", err);
    }
  }
  return found ? [...tools].join("|") : null;
}
function setConfigKey(file2, key, value) {
  try {
    const layer = readLayer(file2);
    if (value === void 0) delete layer[key];
    else layer[key] = value;
    mkdirSync10(dirname10(file2), { recursive: true });
    writeAtomic(file2, JSON.stringify(layer, null, 2) + "\n");
  } catch (err) {
    recordError("writeConfig", err);
  }
}
try {
  main();
} catch (err) {
  recordError("main", err);
}
if (!["mcp", "dashboard", "login", "logout", "sync", "audit", "serve"].includes(process.argv[2] ?? "")) process.exit(0);
