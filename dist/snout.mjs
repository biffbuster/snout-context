#!/usr/bin/env node

// src/cli.ts
import { existsSync as existsSync13, mkdirSync as mkdirSync8, readdirSync as readdirSync3, readFileSync as readFileSync13, readSync as readSync3, rmSync as rmSync2, statSync as statSync12, writeFileSync as writeFileSync4, writeSync } from "node:fs";
import { createHash as createHash3 } from "node:crypto";
import { spawn as spawn2, spawnSync as spawnSync3 } from "node:child_process";
import { basename as basename4, dirname as dirname7, isAbsolute as isAbsolute5, join as join16, resolve as resolve7 } from "node:path";
import { homedir as homedir5 } from "node:os";

// src/config.ts
import { existsSync as existsSync2, readFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
    map: join(snoutDir, "map.json")
  };
}
function attach(paths) {
  setErrorLog(paths.errors);
}
function userConfigPath() {
  if (!process.env.SNOUT_HOME) adoptLegacyDir(join(homedir(), ".jev"), join(homedir(), ".snout"));
  return join(process.env.SNOUT_HOME || join(homedir(), ".snout"), "config.json");
}
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
  return cfg;
}
function isValidMode(v) {
  return v === "observe" || v === "advise" || v === "enforce";
}

// src/gate/tier0.ts
import { openSync, readSync, closeSync, statSync as statSync2, readFileSync as readFileSync2 } from "node:fs";
import { relative, isAbsolute, join as join2 } from "node:path";

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
    const tail = out.slice(-Math.floor(max * 0.3));
    out = `${head}\u2026${tail}`;
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
  "deps",
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
      const vendorDir = firstSegmentMatch(s.rel, VENDOR_DIRS) ?? s.ignoredOutputDir(s.rel);
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
    run: (s, name) => /(^|\/)(__snapshots__|__fixtures__|cassettes|fixtures)(\/|$)/.test(s.rel) || name.endsWith(".snap") ? marginal("snapshot", `${safePath(s.rel)} is a recorded snapshot or fixture; useful only when the task is specifically about it.`) : null
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
  const banner = head.split("\n", BANNER_LINES).join("\n");
  for (const marker of WEAK_MARKERS) {
    if (banner.includes(marker) && GENERATOR_HINT.test(banner)) return marker;
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
  const abs = isAbsolute(absPath) ? absPath : join2(projectDir, absPath);
  const rel = relative(projectDir, abs);
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
  let tokens = 0;
  for (const f of files) {
    const tok2 = estimateTokens(f.bytes, f.rel);
    tokens += tok2;
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
    tokens,
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
import { isAbsolute as isAbsolute2, join as join3, resolve as resolve2 } from "node:path";
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
  const tokens = tokenize(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "&" && tokens[i + 1]?.startsWith(">")) {
      seg = [];
      continue;
    }
    if (SEPARATORS.has(t)) flush(t);
    else seg.push(t);
  }
  flush(void 0);
  return out;
}
function isDump(tokens) {
  const i = commandIndex(tokens);
  const raw = tokens[i];
  if (raw === void 0 || !DUMP_COMMANDS.has(raw.slice(raw.lastIndexOf("/") + 1))) return false;
  return !tokens.slice(i + 1).some((t) => /^(1|&)?>/.test(t));
}
function commandIndex(tokens) {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === "sudo" || tokens[i] === "command" || tokens[i] === "time")) i++;
  return i;
}
function tokenize(command) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let had = false;
  const push = () => {
    if (cur !== "" || had) tokens.push(cur);
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
        tokens.push(c + next);
        i++;
      } else {
        tokens.push(c === "\n" ? "\n" : c);
      }
      continue;
    }
    cur += c;
  }
  if (quote) return [];
  push();
  return tokens;
}
function splitSegments(tokens) {
  const segments = [];
  let cur = [];
  for (const t of tokens) {
    if (SEPARATORS.has(t)) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) segments.push(cur);
  return segments;
}
function segmentTargets(tokens, cwd) {
  let i = commandIndex(tokens);
  const raw = tokens[i];
  if (raw === void 0) return [];
  const cmd = raw.slice(raw.lastIndexOf("/") + 1);
  if (!READ_COMMANDS.has(cmd)) return [];
  const valueFlags = VALUE_FLAGS[cmd] ?? /* @__PURE__ */ new Set();
  const out = [];
  let scriptSeen = !SCRIPT_FIRST.has(cmd);
  let sawOperand = false;
  for (i++; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "<") {
      const target = tokens[++i];
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
    const abs = isAbsolute2(token) ? resolve2(token) : resolve2(join3(cwd, token));
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
import { isAbsolute as isAbsolute3, join as join4 } from "node:path";
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
  const resolve8 = (p) => isAbsolute3(p) ? p : join4(cwd, p);
  const single = searchPath && isFile(resolve8(searchPath)) ? resolve8(searchPath) : null;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const bytes = Buffer.byteLength(line) + 1;
    if (i >= MAX_LINES || line === "" || line === "--") {
      rest += bytes;
      return;
    }
    const owner = ownerOf(line, resolve8, isFile) ?? single;
    if (owner) files.set(owner, (files.get(owner) ?? 0) + bytes);
    else rest += bytes;
  });
  return { files, rest };
}
function ownerOf(line, resolve8, isFile) {
  for (let i = 1; i < line.length && i < 1024; i++) {
    const c = line[i];
    if (c !== ":" && c !== "-") continue;
    const abs = resolve8(line.slice(0, i));
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
import { dirname as dirname2 } from "node:path";

// src/util/atomic.ts
import { renameSync as renameSync2, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join as join5 } from "node:path";
function writeAtomic(path, contents) {
  const tmp = join5(dirname(path), `.tmp-${process.pid}-${Date.now().toString(36)}`);
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
  const dir = dirname2(path);
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
  let tokens = 0;
  for (const r of reads) {
    const reachedContext = r.decision === "allow" || r.observedOnly;
    if (!reachedContext || !r.fp) continue;
    comparable += 1;
    const key = `${r.session}\0${r.path}\0${r.fp}\0${r.range ?? ""}`;
    const who = r.agentId ?? "";
    const readers = seen.get(key) ?? /* @__PURE__ */ new Set();
    if (readers.size > 0 && !readers.has(who)) {
      repeats.add(r);
      tokens += offeredOf(r);
      const p = byPath.get(r.path) ?? { times: 0, tokens: 0 };
      p.times += 1;
      p.tokens += offeredOf(r);
      byPath.set(r.path, p);
    }
    readers.add(who);
    seen.set(key, readers);
  }
  const top = [...byPath.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.tokens - a.tokens || b.times - a.times);
  return { repeats, comparable, tokens, top };
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
  const pct = t.tokensOfferedEst > 0 ? Math.round(t.tokensAvoidedEst / t.tokensOfferedEst * 100) : 0;
  const tag = mode === "observe" ? "flagged" : "saved";
  const cost = t.jevCostUsd > 0 ? ` \xB7 $${t.jevCostUsd.toFixed(4)}` : "";
  return `snout ${pct}% ${tag} \xB7 ~${fmtTokens(t.tokensAvoidedEst)} tok${cost}`;
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
import { dirname as dirname3, join as join6 } from "node:path";
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
function load(file2) {
  if (!existsSync5(file2)) return {};
  const parsed = JSON.parse(readFileSync4(file2, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file2} is not a JSON object`);
  return parsed;
}
function save(file2, cfg) {
  mkdirSync3(dirname3(file2), { recursive: true });
  writeAtomic(file2, JSON.stringify(cfg, null, 2) + "\n");
}

// src/mcp.ts
import { existsSync as existsSync6, readFileSync as readFileSync5, statSync as statSync7 } from "node:fs";
import { isAbsolute as isAbsolute4, join as join7, relative as relative2, resolve as resolve3 } from "node:path";
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
  const abs = inProject(String(args.path ?? ""), projectDir);
  const rel = toRel(abs, projectDir);
  if (!existsSync6(abs) || !statSync7(abs).isFile()) throw new Error(`No such file: ${rel}`);
  const bytes = statSync7(abs).size;
  const d = tier0({ absPath: abs, projectDir, cfg });
  const band = bandOf(d);
  const tokens = estimateTokens(bytes, rel);
  if (name === "snout_classify") {
    if (!d) return `${rel}: source \xB7 band read \xB7 ~${fmtTokens(tokens)} tokens if read whole. No rule flags it, so it is read in full.`;
    return `${rel}: ${d.rule} \xB7 confidence ${d.confidence.toFixed(2)} \xB7 band ${band} \xB7 ~${fmtTokens(tokens)} tokens if read whole.
${d.reason}`;
  }
  if (name !== "snout_read") throw new Error(`Unknown tool: ${name}`);
  if (d?.rule === "secret") throw new Error(`${rel} looks like a secret or credential. Ask the user before reading it.`);
  if (d?.rule === "binary" || d?.rule === "binary-content") throw new Error(`${rel} is binary; reading it yields nothing usable.`);
  const text = readFileSync5(abs, "utf8");
  const lines = text.split("\n");
  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 0;
  if (offset || limit) {
    const from = Math.max(1, offset || 1);
    const to = Math.min(lines.length, limit ? from + limit - 1 : lines.length);
    return cap(`${rel} (lines ${from}\u2013${to} of ${lines.length})

${lines.slice(from - 1, to).join("\n")}`);
  }
  if (d && band === "act" && worthGating(d, true, tokens)) {
    const oneLine = bytes / Math.max(1, lines.length) > 1e3;
    const map = outline(rel, d.rule, text);
    const hint = searchHint(d.rule, rel, { oneLine });
    const note = `${rel}: ${d.reason} (~${fmtTokens(tokens)} tokens).`;
    if (oneLine) return `${note} It is one very long line, so no head is shown.${map}${hint}`;
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
  const abs = resolve3(isAbsolute4(p) ? p : join7(projectDir, p));
  const r = relative2(projectDir, abs);
  if (r.startsWith("..") || isAbsolute4(r)) throw new Error("snout_read only reads files inside the project.");
  return abs;
}
function cap(s) {
  return Buffer.byteLength(s) > MAX_BYTES ? s.slice(0, MAX_BYTES) + `

[truncated at ${MAX_BYTES / 1024} KB; pass offset and limit to read further]` : s;
}

// src/dashboard/server.ts
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { statSync as statSync9, unwatchFile, watchFile } from "node:fs";
import { basename as basename3, join as join11 } from "node:path";

// src/dashboard/summary.ts
var TIMELINE_POINTS = 240;
var FEED = 60;
var CHART_FILES = 8;
var HISTORY = 6;
var DAILY_DAYS = 14;
var isFlagged2 = (r) => r.value <= 1 && r.rule !== "unclassified";
var clientOf = (r) => r.client ?? "claude";
var agentOf = (r) => agentLabel({ agentId: r.agentId, agentType: r.agentType });
var RULE_LABEL = { "binary-content": "binary", unclassified: "source" };
var labelOfRule = (rule) => RULE_LABEL[rule] ?? rule;
function bump(m, key, inContext, heldBack) {
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
    bump(m, server, r.tokensReadEst || 0, held);
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
    bump(labels, labelOfRule(r.rule), read3, held2);
    bump(clients, clientOf(r), read3, held2);
    bump(files, r.path, read3, held2);
    bump(agents, agentOf(r), read3, held2);
    bump(models, r.model || "unknown", read3, held2);
    const s = sessions.get(r.session) ?? { key: r.session, reads: 0, inContext: 0, heldBack: 0, first: r.ts, last: r.ts, clients: [] };
    sessions.set(r.session, s);
    bump(sessions, r.session, read3, held2);
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%23D63F97'/%3E%3C/svg%3E">
<style>
/* An app dashboard: white cards on a warm off-white, one accent (Snout pink) that always means
   "kept out of context", and provider colors only where they encode a model.
   Shape scale: cards 14px, tiles and inputs 10px, buttons 8px, badges 6px. */
:root {
  --bg: #f6f5f1; --card: #ffffff; --tile: #f8f7f4; --ink: #121212; --ink-2: #3d3d3a; --muted: #6b6a66; --faint: #a3a29d;
  --line: #ebeae5; --seg: #ebeae5; --bar-in: #d6d4ce; --accent: #d63f97; --accent-ink: #b52f7e; --accent-soft: #fbe9f3;
  --ok: #15803d; --ok-soft: #e8f6ed; --info: #1d4ed8; --info-soft: #eaf0fe; --warn: #b45309; --warn-soft: #fdf1e1; --up: #15803d; --down: #b91c1c;
  --shadow: 0 1px 2px rgba(40, 36, 20, 0.04);
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
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
.mcol .k { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mcol .v { font-size: 19px; font-weight: 650; letter-spacing: -0.02em; margin-top: 2px; }
.mcol .s { font-size: 12px; color: var(--muted); white-space: nowrap; }
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

@media (max-width: 1100px) {
  .g-row2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .g-row2 > :last-child { grid-column: 1 / -1; }
  .models { --n: 2 !important; row-gap: 22px; }
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
    <div class="brand"><i></i>snout</div>
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

    <div class="grid g-row3">
      <div class="card">
        <div class="card-h"><div><h2>Cost breakdown</h2><p id="cost-p">API-equivalent, from your agents' own usage logs</p></div><button class="link r" type="button" data-go="spend">View spend</button></div>
        <div id="cost"><div class="sk" style="height:200px"></div></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>What's entering context</h2><p>Tokens your agents asked for, by what Snout classified them as</p></div></div>
        <div id="mix"><div class="sk" style="height:264px"></div></div>
      </div>
    </div>
  </section>

  <!-- Context -->
  <section data-view="context" hidden>
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
    <div class="grid">
      <div class="card"><div class="card-h"><div><h2>MCP servers</h2><p id="mcp-p">Results from each connected MCP server: what reached context, and what Snout trimmed or skipped as a repeat</p></div></div><div class="scroll"><table id="mcp"></table></div></div>
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
  function logo(kind, small, fallback) {
    var box = h("span", { cls: "logo" + (small ? " sm" : ""), "aria-hidden": "true" });
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
  var modelLogo = function (model, small) { return logo(providerOf(model), small, model); };
  var clientLogo = function (client, small) { return logo(CLIENT_LOGO[client], small, client); };

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
        h("div", { cls: "m-id" }, modelLogo(m.key), h("div", { style: "min-width:0" }, h("div", { cls: "m-name", text: m.label }), h("div", { cls: "m-sub", text: m.client ? CLIENT[m.client] || m.client : "Model" }))),
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

  function renderMix(v) {
    var box = $("mix"); box.replaceChildren();
    var labels = (v.d.byLabel || []).slice().sort(function (a, b) { return (b.inContext + b.heldBack) - (a.inContext + a.heldBack); });
    var all = 0; labels.forEach(function (l) { all += l.inContext + l.heldBack; });
    if (!all) { box.appendChild(h("div", { cls: "none", text: "Fills in as your agents read files." })); return; }
    var cols = labels.slice(0, 4);
    if (labels.length > 4) {
      var rest = { key: "other", inContext: 0, heldBack: 0, reads: 0 };
      labels.slice(4).forEach(function (l) { rest.inContext += l.inContext; rest.heldBack += l.heldBack; rest.reads += l.reads; });
      cols.push(rest);
    }
    var maxShare = 0; cols.forEach(function (c) { maxShare = Math.max(maxShare, (c.inContext + c.heldBack) / all); });
    var grid = h("div", { cls: "mix", style: "--n:" + cols.length });
    var BAR = 150;
    cols.forEach(function (c) {
      var tot = c.inContext + c.heldBack, share = tot / all;
      var hgt = Math.max(3, (share / maxShare) * BAR);
      var outH = tot ? (c.heldBack / tot) * hgt : 0;
      var cut = c.heldBack > 0;
      grid.appendChild(h("div", { cls: "mcol", title: labelOf(c.key) + ": " + c.reads + " reads, " + fmt(c.inContext) + " into context, ~" + fmt(c.heldBack) + " kept out" },
        h("div", { cls: "top" },
          h("div", { cls: "k", text: c.key === "other" ? "Other" : labelOf(c.key) }),
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
    var servers = d.byMcpServer || [];
    var mcpAll = 0, mcpHeld = 0; servers.forEach(function (m) { mcpAll += m.inContext + m.heldBack; mcpHeld += m.heldBack; });
    if (servers.length) $("mcp-p").textContent = servers.length + (servers.length === 1 ? " server" : " servers") + " \xB7 ~" + fmt(mcpHeld) + " tokens saved, " + pct(mcpHeld, mcpAll) + "% of what they returned";
    tableOf($("mcp"), [["Server"], ["Calls", "n"], ["In context", "n"], ["Saved", "n"], ["Saved %", "n"]], servers.map(function (m) {
      return h("tr", null, h("td", { cls: "path", text: m.key }),
        h("td", { cls: "n", text: m.reads.toLocaleString() }), h("td", { cls: "n", text: fmt(m.inContext) }),
        h("td", { cls: "n", style: m.heldBack ? "color:var(--accent-ink);font-weight:600" : "", text: m.heldBack ? "~" + fmt(m.heldBack) : "\u2014" }),
        h("td", { cls: "n", text: pct(m.heldBack, m.inContext + m.heldBack) + "%" }));
    }), "No MCP calls yet. Results from every MCP server your agents use show up here.");
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
    renderModels(v);
    renderToday(v);
    renderFeed(v);
    renderTrend(v);
    renderCost(v);
    renderMix(v);
    renderContext(v);
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
    if (state.data) { var v = view(state.data); if (tab === "spend") renderSpend(v); if (tab === "overview") renderTrend(v); }
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
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { if (state.data) { var v = view(state.data); renderTrend(v); if (state.tab === "spend") renderSpend(v); } }, 120); });
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
import { existsSync as existsSync7, readdirSync, readFileSync as readFileSync7, statSync as statSync8, writeFileSync as writeFileSync2, mkdirSync as mkdirSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname4, join as join9, resolve as resolve4, sep } from "node:path";

// src/spend/prices.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";
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
    overrides = JSON.parse(readFileSync6(join8(configDir2, "prices.json"), "utf8"));
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
var claudeRoot = () => join9(process.env.CLAUDE_CONFIG_DIR || join9(homedir2(), ".claude"), "projects");
var codexRoot = () => join9(process.env.CODEX_HOME || join9(homedir2(), ".codex"), "sessions");
var claudeSlug = (projectDir) => resolve4(projectDir).replace(/[^A-Za-z0-9]/g, "-");
function jsonlFiles(dir, depth = 4) {
  if (depth < 0 || !existsSync7(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join9(dir, e.name);
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
    return JSON.parse(readFileSync7(path, "utf8"));
  } catch {
    return {};
  }
}
function fileRows(file2, client2, cache2, configDir2) {
  let st;
  try {
    st = statSync8(file2);
  } catch {
    return null;
  }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache2[file2];
  if (hit && hit.stamp === stamp) return hit;
  const text = readFileSync7(file2, "utf8");
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
var inside = (child, parent) => !!child && (child === parent || child.startsWith(parent + sep));
function readSpend(projectDir, cachePath, configDir2) {
  const cache2 = cachePath ? loadCache(cachePath) : {};
  const out = /* @__PURE__ */ new Map();
  const push = (cwd, rows) => out.set(cwd, [...out.get(cwd) ?? [], ...rows]);
  const root = projectDir ? resolve4(projectDir) : null;
  const claudeDirs = root ? [join9(claudeRoot(), claudeSlug(root))] : existsSync7(claudeRoot()) ? readdirSync(claudeRoot()).map((d) => join9(claudeRoot(), d)) : [];
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
  for (const k of Object.keys(cache2)) if (!existsSync7(k)) delete cache2[k];
  if (cachePath) try {
    mkdirSync4(dirname4(cachePath), { recursive: true });
    writeFileSync2(cachePath, JSON.stringify(cache2));
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
  const bump2 = (m, key, r) => {
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
    bump2(models, modelKey(r.model), r);
    bump2(clients, r.client, r);
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
import { createHash } from "node:crypto";
import { chmodSync, existsSync as existsSync8, mkdirSync as mkdirSync5, readFileSync as readFileSync8, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename as basename2, dirname as dirname5, join as join10 } from "node:path";
import { spawnSync } from "node:child_process";
var DEFAULT_CLOUD_URL = "https://app.usesnout.xyz";
var SYNC_DAYS = 35;
var AUTO_SYNC_MS = 60 * 1e3;
var RECENT_DAYS = 2;
var FULL_SYNC_MS = 60 * 60 * 1e3;
var AGENT_SYNC_MS = 60 * 1e3;
function configDir() {
  if (process.env.SNOUT_CONFIG_DIR) return process.env.SNOUT_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join10(process.env.APPDATA, "snout");
  return join10(process.env.XDG_CONFIG_HOME || join10(homedir3(), ".config"), "snout");
}
var credsPath = () => join10(configDir(), "cloud.json");
function loadCredentials() {
  const env = process.env.SNOUT_TOKEN;
  if (env && env.startsWith("snt_")) return { url: cloudUrl(), token: env, user: "agent", team: "workspace" };
  try {
    const c = JSON.parse(readFileSync8(credsPath(), "utf8"));
    return c.url && c.token ? c : null;
  } catch {
    return null;
  }
}
function saveCredentials(c) {
  const p = credsPath();
  mkdirSync5(dirname5(p), { recursive: true });
  writeFileSync3(p, JSON.stringify(c, null, 2) + "\n", { mode: 384 });
  try {
    chmodSync(p, 384);
  } catch {
  }
}
function forgetCredentials() {
  if (!existsSync8(credsPath())) return false;
  rmSync(credsPath());
  return true;
}
function cloudUrl(flag) {
  return (flag || process.env.SNOUT_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/+$/, "");
}
function sessionOf(paths) {
  try {
    const s = JSON.parse(readFileSync8(join10(paths.snoutDir, "state.json"), "utf8"));
    return typeof s.session === "string" && s.session ? s.session : null;
  } catch {
    return null;
  }
}
function projectKey(projectDir) {
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: projectDir, encoding: "utf8", timeout: 3e3 });
  const remote = r.status === 0 ? r.stdout.trim() : "";
  const norm = remote ? remote.replace(/^[a-z+]+:\/\/([^@/]*@)?/i, "").replace(/^[^@/]*@/, "").replace(":", "/").replace(/\.git$/, "").toLowerCase() : projectDir;
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}
function buildPayload(paths, version, now = /* @__PURE__ */ new Date(), days = SYNC_DAYS) {
  const since = new Date(now.getTime() - (days - 1) * 864e5).toISOString().slice(0, 10);
  return {
    v: 1,
    snout: version,
    project: { key: projectKey(paths.projectDir), name: basename2(paths.projectDir).slice(0, 80) },
    days: dailyAggregates(readDecisions(paths.ledger, 2e4), since),
    ...sessionOf(paths) ? { run: createHash("sha256").update(sessionOf(paths)).digest("hex").slice(0, 32) } : {},
    spend: [...readSpend(paths.projectDir, join10(paths.snoutDir, "spend-cache.json"), configDir()).values()].flat().filter((r) => r.day >= since).map((r) => ({ ...r, model: modelKey(r.model).slice(0, 64), costUsd: r.costUsd === null ? null : Math.round(r.costUsd * 1e6) / 1e6 }))
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
var syncState = (paths) => join10(paths.snoutDir, "cloud-sync.json");
function lastSync(paths) {
  try {
    return JSON.parse(readFileSync8(syncState(paths), "utf8"));
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
    mkdirSync5(paths.snoutDir, { recursive: true });
    const fullAt = full && result.ok ? (/* @__PURE__ */ new Date()).toISOString() : last?.fullAt;
    writeFileSync3(syncState(paths), JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ok: result.ok, ...fullAt ? { fullAt } : {}, ...result.ok ? {} : { error: result.message } }) + "\n");
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
  try {
    start = await post(`${url}/api/device/start`, { client: "snout-cli" });
  } catch (err) {
    say2(`Could not reach ${url}: ${err.message}`);
    return false;
  }
  if (start.status !== 200 || !start.json?.device_code) {
    say2(`${url} did not start a login (${start.status}).`);
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

// src/dashboard/server.ts
var ROWS = 2e4;
var POLL_MS = 500;
var HEARTBEAT_MS = 15e3;
var SPEND_MS = 4e3;
var SPEND_DAYS = 30;
function startDashboard(paths, opts) {
  const streams = /* @__PURE__ */ new Set();
  const key = randomBytes(24).toString("base64url");
  const page = PAGE.replace("__SNOUT_KEY__", key);
  let version = "";
  let cache2 = /* @__PURE__ */ new Map();
  const stamp = () => {
    try {
      const s = statSync9(paths.ledger);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "none";
    }
  };
  let spend = null;
  const readSpendNow = () => {
    try {
      const since = new Date(Date.now() - (SPEND_DAYS - 1) * 864e5).toISOString().slice(0, 10);
      const rows = [...readSpend(paths.projectDir, join11(paths.snoutDir, "spend-cache.json"), configDir()).values()].flat();
      const next = summarizeSpend(rows, since);
      const changed = !spend || next.requests !== spend.requests || next.costUsd !== spend.costUsd;
      spend = next;
      return changed;
    } catch {
      return false;
    }
  };
  readSpendNow();
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
    return {
      ...s,
      sessions,
      meta: {
        project: basename3(paths.projectDir),
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
import { existsSync as existsSync9, mkdirSync as mkdirSync6, readFileSync as readFileSync9 } from "node:fs";
import { dirname as dirname6, join as join12, resolve as resolve5 } from "node:path";
var file = (configDir2) => join12(configDir2, "dashboards.json");
function read(configDir2) {
  try {
    return JSON.parse(readFileSync9(file(configDir2), "utf8"));
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
  const e = read(configDir2)[resolve5(projectDir)];
  return e && alive(e.pid) ? e : null;
}
function registerDashboard(configDir2, projectDir, entry) {
  try {
    const all = read(configDir2);
    for (const [k, v] of Object.entries(all)) if (!alive(v.pid)) delete all[k];
    all[resolve5(projectDir)] = entry;
    const f = file(configDir2);
    if (!existsSync9(dirname6(f))) mkdirSync6(dirname6(f), { recursive: true });
    writeAtomic(f, JSON.stringify(all, null, 2) + "\n");
  } catch {
  }
}

// src/gate/install.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync7, readFileSync as readFileSync10 } from "node:fs";
import { join as join13 } from "node:path";

// src/squeeze/squeeze.ts
var KINDS = [
  ["test", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(jest|vitest|mocha|playwright\s+test)\b|(jest|vitest|mocha|pytest|rspec|phpunit)\b|python3?\s+-m\s+pytest\b|go\s+test\b|cargo\s+test\b|node\s+--test\b|deno\s+test\b)/],
  ["install", /(^|[\s;&|(])((npm|pnpm)\s+(i|install|ci|add)\b|yarn(\s+(install|add))?\s*($|[;&|])|bun\s+(i|install|add)\b|pip3?\s+install\b|poetry\s+install\b|bundle(\s+install)?\s*($|[;&|])|go\s+mod\s+(download|tidy)\b|cargo\s+fetch\b|brew\s+install\b)/],
  ["build", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?build\b|npx\s+(tsc|vite|next|webpack)\b|\btsc\b|vite\s+build\b|next\s+build\b|webpack\b|cargo\s+build\b|go\s+build\b|make\b|mvn\b|\.?\/?gradlew?\b|docker\s+build\b)/],
  // Searches that walk a tree: recursive grep, ripgrep and friends, git grep, find, ls -R.
  ["search", /(^|[\s;&|(])(grep\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]|rg\s|ag\s|ack\s|git\s+grep\b|find\s+(\.|\/|~|\S+\s+-)|ls\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*R)/]
];
function kindOf(command) {
  for (const [k, re] of KINDS) if (re.test(command)) return k;
  return null;
}
var MIN_BYTES = 4e3;
var agentOutputLimit = () => Number(process.env.BASH_MAX_OUTPUT_LENGTH) || 3e4;
var MIN_CUT = 0.3;
var KEEP_HEAD = 5;
var KEEP_TAIL = 15;
var ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
var TROUBLE = /\b(error|errors|err!|fail(ed|ure|ing)?|fatal|panic|exception|traceback|warn(ing)?s?|deprecated|vulnerab|critical|denied|cannot|can't|unable|not found|missing|undefined|timeout|timed out|segmentation)\b|✗|✕|×|❌|⚠|^\s*\(!\)/i;
var PASSING = /^\s*(✓|✔|√|ok\s+\d+\b|PASS\b|\.{3,}$|test\s+\S+.*\.\.\.\s+ok$|--- PASS:|=== RUN\b|RUN\s|\[\s*PASSED\s*\]|\s*passed\s*$)/;
var SUMMARY = /\b(tests?:|suites?:|passed|passing|failed|failing|skipped|pending|todo|duration|time:|elapsed|total|ran \d+|\d+ (tests?|specs?|examples?)|added \d+ packages?|removed \d+|changed \d+|audited \d+|up to date|found \d+ vulnerabilit|built in|compiled|done in|successfully|finished)\b|^#\s*(tests|pass|fail|suites|duration)/i;
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
    if (SUMMARY.test(l)) keep[i] = true;
    else if (kind === "test" && PASSING.test(l)) keep[i] = false;
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
var LIST_LINES = 60;
var MATCH_LINE = /^([^\s:][^:]{0,300}?):(\d+[:-])?(.*)$/;
function squeezeSearch(output, savedTo) {
  const lines = clean(output).filter((l) => l.trim());
  const n = lines.length;
  const matched = lines.map((l) => MATCH_LINE.exec(l));
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
    for (const [file2, hits] of files) {
      if (shown >= FILES_LISTED) {
        hiddenFiles++;
        hiddenMatches += hits.length;
        continue;
      }
      shown++;
      out.push(...hits.slice(0, MATCHES_PER_FILE));
      if (hits.length > MATCHES_PER_FILE) out.push(`  (+${hits.length - MATCHES_PER_FILE} more in ${file2})`);
    }
    if (hiddenFiles) out.push(`  \u2026 ${hiddenFiles} more file${hiddenFiles === 1 ? "" : "s"} with ${hiddenMatches} match${hiddenMatches === 1 ? "" : "es"}`);
    summary = `${n} matches in ${files.size} files; first ${MATCHES_PER_FILE} per file shown`;
  } else {
    out.push(...lines.slice(0, LIST_LINES));
    const rest = lines.slice(LIST_LINES);
    if (rest.length) {
      const dirs = /* @__PURE__ */ new Map();
      for (const l of rest) {
        const parts = l.replace(/^\.\//, "").split("/");
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
function squeezeEntries(bin) {
  const command = `node "${bin}" squeeze`;
  return [
    { matcher: "Bash", hooks: SQUEEZE_IFS.map((c) => ({ type: "command", if: `Bash(${c})`, command, timeout: 5 })) },
    // Every MCP tool: large results (browser snapshots, diffs, query rows) are trimmed the same way.
    { matcher: "mcp__.*", hooks: [{ type: "command", command, timeout: 5 }] }
  ];
}
function gateEntries(bin) {
  const command = `node "${bin}" pre-tool`;
  return [
    { matcher: "Read|NotebookRead", hooks: [{ type: "command", command, timeout: 5 }] },
    { matcher: "Bash", hooks: PRINTING_COMMANDS.map((c) => ({ type: "command", if: `Bash(${c} *)`, command, timeout: 5 })) }
  ];
}
var isGate = (e) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes("pre-tool"));
var isSqueeze = (e) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes("squeeze"));
function read2(file2) {
  try {
    return JSON.parse(readFileSync10(file2, "utf8"));
  } catch {
    return {};
  }
}
function write(file2, settings) {
  mkdirSync7(join13(file2, ".."), { recursive: true });
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
function installGate(projectDir, bin) {
  removeGate(projectDir);
  const file2 = join13(projectDir, ".claude", "settings.local.json");
  const settings = read2(file2);
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...settings.hooks.PreToolUse ?? [], ...gateEntries(bin)];
  settings.hooks.PostToolUse = [...settings.hooks.PostToolUse ?? [], ...squeezeEntries(bin)];
  write(file2, settings);
  return file2;
}
function removeGate(projectDir) {
  let removed = false;
  for (const name of SETTINGS) {
    const file2 = join13(projectDir, ".claude", name);
    if (!existsSync10(file2)) continue;
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
    const file2 = join13(projectDir, ".claude", name);
    if (!existsSync10(file2)) continue;
    const pre = read2(file2).hooks?.PreToolUse ?? [];
    const stale = pre.some((e) => isGate(e) && (e.hooks ?? []).some((h) => h.command.includes(MARK) && !h.command.includes(`"${bin}"`)));
    if (stale) {
      installGate(projectDir, bin);
      return true;
    }
  }
  return false;
}

// src/coach/coach.ts
import { spawnSync as spawnSync2 } from "node:child_process";
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
  const r = spawnSync2(process.execPath, ["-e", script, url], { input: body, encoding: "utf8", timeout: timeoutMs });
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
    const tail = s.slice(s.length - Math.floor(TEXT_BUDGET * 0.3));
    s = `${head}
\u2026 ${s.length - head.length - tail.length} characters omitted \u2026
${tail}`;
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

// src/audit/mcp-servers.ts
import { existsSync as existsSync11, readdirSync as readdirSync2, readFileSync as readFileSync11, statSync as statSync10 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join14, resolve as resolve6 } from "node:path";
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
function configuredServers(projectDir, home = homedir4()) {
  const dir = resolve6(projectDir);
  const servers = [];
  servers.push(...fromMap(readJson(join14(dir, ".mcp.json"))?.mcpServers, "project .mcp.json", "claude"));
  const claude2 = readJson(join14(process.env.CLAUDE_CONFIG_DIR ? join14(process.env.CLAUDE_CONFIG_DIR, "..") : home, ".claude.json"));
  if (claude2) {
    servers.push(...fromMap(claude2.mcpServers, "Claude Code (user)", "claude"));
    servers.push(...fromMap(claude2.projects?.[dir]?.mcpServers, "Claude Code (this project)", "claude"));
    const disabled = claude2.projects?.[dir]?.disabledMcpjsonServers ?? [];
    for (let i = servers.length - 1; i >= 0; i--) if (servers[i].source === "project .mcp.json" && disabled.includes(servers[i].name)) servers.splice(i, 1);
  }
  servers.push(...fromMap(readJson(join14(dir, ".cursor", "mcp.json"))?.mcpServers, "Cursor (project)", "cursor"));
  servers.push(...fromMap(readJson(join14(home, ".cursor", "mcp.json"))?.mcpServers, "Cursor (user)", "cursor"));
  servers.push(...fromMap(readJson(join14(dir, ".gemini", "settings.json"))?.mcpServers, "Gemini CLI (project)", "gemini"));
  servers.push(...fromMap(readJson(join14(home, ".gemini", "settings.json"))?.mcpServers, "Gemini CLI (user)", "gemini"));
  servers.push(...codexServers(join14(process.env.CODEX_HOME || join14(home, ".codex"), "config.toml")));
  return servers;
}
function mcpUsage(projectDir, days = 30, home = homedir4()) {
  const root = join14(process.env.CLAUDE_CONFIG_DIR || join14(home, ".claude"), "projects", resolve6(projectDir).replace(/[^A-Za-z0-9]/g, "-"));
  const counts = /* @__PURE__ */ new Map();
  if (!existsSync11(root)) return counts;
  const since = Date.now() - days * 864e5;
  for (const f of readdirSync2(root)) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join14(root, f);
    try {
      if (statSync10(path).mtimeMs < since) continue;
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
function measureServer(s, timeoutMs = 1e4) {
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
    const child = spawn(s.command, s.args ?? [], { env: { ...process.env, ...s.env ?? {} }, stdio: ["pipe", "pipe", "ignore"] });
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

// src/gate/longdoc.ts
var LONG_DOC_BYTES = 32 * 1024;
var HEAD_LINES2 = 60;
var HEAD_BYTES2 = 6 * 1024;
var TAIL_LINES = 120;
var TAIL_BYTES = 8 * 1024;
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
  if (all.length < HEAD_LINES2 * 2) return null;
  return kind === "doc" ? docHead(all) : logTail(all);
}
function docHead(all) {
  let bytes = 0, lines = 0;
  for (const line of all.slice(0, HEAD_LINES2)) {
    const b = byteLen(line) + 1;
    if (bytes + b > HEAD_BYTES2) break;
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
    if (bytes + b > TAIL_BYTES) break;
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
import { existsSync as existsSync12, readFileSync as readFileSync12, statSync as statSync11 } from "node:fs";
import { join as join15 } from "node:path";
import { createHash as createHash2 } from "node:crypto";
var MAX_ENTRIES = 2e3;
var MAX_WINDOWS = 20;
var storePath = (snoutDir) => join15(snoutDir, "reads.json");
function load2(snoutDir, session) {
  try {
    const s = JSON.parse(readFileSync12(storePath(snoutDir), "utf8"));
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
    const s = statSync11(absPath);
    return s.isFile() ? { size: s.size, mtimeMs: Math.round(s.mtimeMs) } : null;
  } catch {
    return null;
  }
}
function rememberRead(snoutDir, session, agentId, absPath, rel, window, turn) {
  const st = statOf(absPath);
  if (!st || !existsSync12(snoutDir)) return;
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
var outputKey = (agentId, tool, text) => `${agentId || "main"}\0${tool}\0${createHash2("sha256").update(text).digest("hex").slice(0, 32)}`;
function repeatOutput(snoutDir, session, agentId, tool, text, turn, call) {
  if (text.length < MIN_REPEAT_CHARS || !existsSync12(snoutDir)) return null;
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
  if (!existsSync12(snoutDir)) return;
  save2(snoutDir, { session, reads: {}, outputs: {} });
}

// src/cli.ts
var VERSION2 = "0.2.2";
var BIN = resolve7(process.argv[1] ?? "dist/snout.mjs");
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
var spendCache = (paths) => existsSync13(paths.snoutDir) ? join16(paths.snoutDir, "spend-cache.json") : null;
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
  const usd = (tokens) => rate ? ` (~$${(tokens * rate / 1e6).toFixed(2)})` : "";
  const lines = [`snout ${VERSION2} \xB7 ${basename4(paths.projectDir)} \xB7 mode ${cfg.mode}`, ""];
  if (!s.reads) {
    lines.push("  No reads recorded yet in this project.", "", `  Next: ${gateInstalled(paths) || existsSync13(paths.hooks) ? "start your agent here and work as usual" : "snout init claude (or codex, cursor, gemini)"}`);
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
  const spend = readSpend(all ? null : paths.projectDir, all ? join16(configDir(), "spend-cache.json") : join16(paths.snoutDir, "spend-cache.json"), configDir());
  const s = summarizeSpend([...spend.values()].flat(), since);
  const held = all ? 0 : dailyAggregates(readDecisions(paths.ledger, 2e4), since).reduce((a, d) => a + d.heldBack, 0);
  const projects = [...spend.entries()].map(([dir, r]) => ({ dir, s: summarizeSpend(r, since) })).filter((p) => p.s.requests > 0).sort((a, b) => b.s.costUsd - a.s.costUsd);
  if (args.includes("--json")) {
    return say(JSON.stringify({ days, pricesAsOf: PRICES_AS_OF, ...s, heldBack: held, projects: all ? projects.map((p) => ({ dir: p.dir, costUsd: p.s.costUsd, requests: p.s.requests, tokens: p.s.tokens })) : void 0 }, null, 2));
  }
  const usd = (n) => `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
  const pad = (v, n, left = false) => left ? v.padEnd(n) : v.padStart(n);
  const lines = [`snout spend \u2014 ${all ? "all projects on this machine" : basename4(paths.projectDir)} \xB7 last ${days} days \xB7 API list prices of ${PRICES_AS_OF}`, ""];
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
    for (const p of projects.slice(0, 10)) lines.push(`    ${pad(safeText(p.dir.replace(homedir5(), "~"), 60).slice(-42), 42, true)}${pad(usd(p.s.costUsd), 11)}`);
    const rest = projects.slice(10);
    if (rest.length) lines.push(`    ${pad(`${rest.length} more`, 42, true)}${pad(usd(rest.reduce((a, p) => a + p.s.costUsd, 0)), 11)}`);
  }
  if (s.unpriced.length) lines.push("", `  No list price for ${s.unpriced.map((m) => safeText(m, 40)).join(", ")}: tokens counted, cost left out. Add it to ${join16(configDir(), "prices.json")}.`);
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
function dispatch(command, input) {
  if (HOOK_EVENTS.has(command) && Object.keys(input).length === 0) {
    debug("empty hook payload for", command, "- doing nothing");
    return;
  }
  const paths = resolvePaths(input.cwd);
  attach(paths);
  const cfg = loadConfig(paths);
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
  const flag = join16(paths.snoutDir, "first-run.json");
  if (cfg.mode !== "observe" || existsSync13(flag) || s.reads < FIRST_RUN_MIN_READS || s.couldHoldBack <= 0) return null;
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
  installGate(paths.projectDir, BIN);
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
  const dir = join16(paths.snoutDir, "calls");
  try {
    mkdirSync8(dir, { recursive: true });
    writeFileSync4(join16(dir, createHash3("sha256").update(id).digest("hex").slice(0, 24)), "", { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") return false;
    return true;
  }
  try {
    const all = readdirSync3(dir);
    if (all.length > 400) for (const f of all.map((f2) => ({ f: f2, t: statSync12(join16(dir, f2)).mtimeMs })).sort((a, b) => a.t - b.t).slice(0, all.length - 200)) rmSync2(join16(dir, f.f), { force: true });
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
  const dir = join16(paths.snoutDir, "squeeze");
  const logName = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${createHash3("sha256").update(command).digest("hex").slice(0, 8)}.log`;
  const s = squeeze(kind, full, `.snout/squeeze/${logName}`);
  if (!s) {
    emit({});
    return;
  }
  try {
    mkdirSync8(dir, { recursive: true });
    writeAtomic(join16(dir, logName), `$ ${command}

${full}`);
    const logs = readdirSync3(dir).filter((f) => f.endsWith(".log")).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - SQUEEZE_LOGS_KEPT))) rmSync2(join16(dir, old), { force: true });
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
  const dir = join16(paths.snoutDir, "squeeze");
  const logName = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${createHash3("sha256").update(tool).digest("hex").slice(0, 8)}.json`;
  const t = trimMcp(input.tool_response, `.snout/squeeze/${logName}`);
  if (!t) {
    recordToolOutput(input, paths, loadState(paths.state, input.session_id ?? "unknown"), responseBytes(input.tool_response));
    return emit({});
  }
  try {
    mkdirSync8(dir, { recursive: true });
    writeAtomic(join16(dir, logName), JSON.stringify({ tool, input: input.tool_input ?? null, output: input.tool_response }, null, 1));
    const logs = readdirSync3(dir).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - SQUEEZE_LOGS_KEPT))) rmSync2(join16(dir, old), { force: true });
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
  state.goalHash = createHash3("sha256").update(input.prompt ?? "").digest("hex").slice(0, 12);
  const tip = coachPrompt(input.prompt ?? "", paths, cfg, state);
  saveState(paths.state, state);
  emit(tip ? { systemMessage: tip } : {});
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
      appendRow(join16(paths.snoutDir, "prompts.jsonl"), {
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
  const first = args[0];
  if (first === "off" || first === "tip" || first === "jev") {
    setConfigKey(paths.config, "coach", first);
    const note = first === "jev" ? process.env.TYPESAFE_API_KEY ? " Prompts that look like tasks are now checked by TypeSafe's Jev; their text is sent to api.typesafe.ai." : " Set TYPESAFE_API_KEY first; until then the local rules are used." : first === "tip" ? " Local rules only; nothing leaves the machine." : "";
    return say(`Prompt coach: ${first}.${note}`);
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
  const absPath = isAbsolute5(filePath) ? filePath : join16(paths.projectDir, filePath);
  const state = loadState(paths.state, input.session_id ?? "unknown");
  if (tool === "Read" && cfg.repeatReads !== false) {
    const rel = toRel(absPath, paths.projectDir);
    const window = requestedWindow(input.tool_input);
    const prior = repeatOf(paths.snoutDir, state.session, agentOf2(input).agentId, absPath, rel, window, !client);
    if (prior) return repeatResponse(input, paths, state, absPath, rel, window, prior);
  }
  const windowBytes = readWindowBytes(input, absPath);
  const g = classifyForGate(input, paths, cfg, state, absPath, windowBytes);
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
function isRegularFile(absPath) {
  try {
    return statSync12(absPath).isFile();
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
    const lines = readFileSync13(absPath, "utf8").split("\n").slice(offset - 1, offset - 1 + limit);
    return Buffer.byteLength(lines.join("\n"));
  } catch {
    return void 0;
  }
}
function contentsOf(absPath, rel, rule) {
  try {
    const size = sizeOf(absPath);
    if (size > 4 * 1024 * 1024) return { outline: "", oneLine: false };
    const text = readFileSync13(absPath, "utf8");
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
    const all = readFileSync13(absPath, "utf8").split("\n");
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
    return docWindow(rel, size >= 32 * 1024 ? readFileSync13(absPath, "utf8") : "", size);
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
      latencyMs: Math.round(process.uptime() * 1e3),
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
    latencyMs: Math.round(process.uptime() * 1e3),
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
    latencyMs: Math.round(process.uptime() * 1e3),
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
      const abs = isAbsolute5(filePath) ? filePath : join16(paths.projectDir, filePath);
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
  const tokens = estimateTokens(bytes, shape);
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
    tokensReadEst: tokens,
    jevInputTokens: 0,
    latencyMs: Math.round(process.uptime() * 1e3),
    model: null,
    reversedByUser: false,
    observedOnly: true,
    ...agentOf2(input)
  });
}
function recordObservation(input, paths, cfg, filePath, state, bytesHint) {
  const absPath = isAbsolute5(filePath) ? filePath : join16(paths.projectDir, filePath);
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
    latencyMs: Math.round(process.uptime() * 1e3),
    model: null,
    reversedByUser: false,
    observedOnly: true,
    ...readShape(input, absPath, bytesHint),
    ...agentOf2(input)
  });
}
function hasPreToolRow(paths, state, filePath, agentId) {
  const rel = toRel(isAbsolute5(filePath) ? filePath : join16(paths.projectDir, filePath), paths.projectDir);
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
    const s = JSON.parse(readFileSync13(paths.state, "utf8"));
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
var appliedPath = (paths) => join16(paths.snoutDir, "applied.jsonl");
function currentTips(paths, cfg) {
  let claudeMd = "";
  try {
    claudeMd = readFileSync13(join16(paths.projectDir, "CLAUDE.md"), "utf8");
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
  const file2 = tip.kind === "claude-md" ? join16(paths.projectDir, "CLAUDE.md") : toUser ? userConfigPath() : paths.config;
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
    const existed = existsSync13(file2);
    const prev = existed ? readFileSync13(file2, "utf8") : "";
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
    const text = existsSync13(last.file) ? readFileSync13(last.file, "utf8") : "";
    const i = text.lastIndexOf(last.line + "\n");
    if (i < 0) return say(`The line snout added to ${safeText(last.file, 120)} is no longer there; nothing changed.`);
    const next = text.slice(0, i) + text.slice(i + last.line.length + 1);
    if (last.created && next.trim() === "") rmSync2(last.file, { force: true });
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
      const tokens = relevant.filter((r) => r.ts >= a.ts === after && r.value <= 1 && r.rule !== "unclassified").reduce((x, r) => x + (r.tokensAvoidedEst || 0), 0);
      return { sessions, per: sessions > 0 ? Math.round(tokens / sessions) : 0 };
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
  const absPath = isAbsolute5(target) ? target : join16(paths.projectDir, target);
  const rel = toRel(absPath, paths.projectDir);
  const bytes = sizeOf(absPath);
  const tokens = estimateTokens(bytes, rel);
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
      tokensEst: tokens,
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
    `  size            ${bytes} bytes (~${fmtTokens(tokens)} tokens estimated)`,
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
    const r = spawnSync3("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", timeout: 1e4, maxBuffer: 256 * 1024 * 1024 });
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
  const root = target ? isAbsolute5(target) ? target : join16(paths.projectDir, target) : paths.projectDir;
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
      const abs = join16(root, rel);
      if (isRegularFile(abs)) add(abs);
    }
  }
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync3(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      const abs = join16(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        add(abs);
      }
    }
  };
  if (!listed) walk(root);
  const ms = Date.now() - started;
  const sum = summarize(files, mode, t, topN);
  if (json) {
    say(JSON.stringify({ root: toRel(root, paths.projectDir) || ".", truncated, ms, ...sum }, null, 2));
    return;
  }
  say(renderScan(sum, toRel(root, paths.projectDir) || ".", truncated, ms));
}
function renderScan(sum, root, truncated, ms) {
  const pct = (n) => sum.tokens > 0 ? `${Math.round(n / sum.tokens * 100)}%` : "0%";
  const t = sum.thresholds;
  const lines = [
    `snout scan \u2014 ${safePath(root)} \xB7 ${sum.files} file(s) \xB7 ~${fmtTokens(sum.tokens)} tokens if every file were read whole \xB7 ${ms} ms`,
    `  thresholds: act \u2265 ${t.denyMinConfidence.toFixed(2)} \xB7 ask \u2265 ${t.askMinConfidence.toFixed(2)} \xB7 below that, always read`,
    "",
    "  BY LABEL          files      ~tokens   share"
  ];
  for (const r of sum.labels) {
    const share = sum.tokens > 0 ? r.tokens / sum.tokens : 0;
    lines.push(`    ${r.label.padEnd(13)} ${String(r.files).padStart(7)}  ${("~" + fmtTokens(r.tokens)).padStart(10)}  ${pct(r.tokens).padStart(5)}  ${bar(share, 20)}`);
  }
  lines.push(
    "",
    "  BY BAND           files      ~tokens   share",
    `    act             ${String(sum.bands.act.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.act.tokens)).padStart(10)}  ${pct(sum.bands.act.tokens).padStart(5)}   enforce withholds`,
    `    ask             ${String(sum.bands.ask.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.ask.tokens)).padStart(10)}  ${pct(sum.bands.ask.tokens).padStart(5)}   asks first`,
    `    read            ${String(sum.bands.read.files).padStart(7)}  ${("~" + fmtTokens(sum.bands.read.tokens)).padStart(10)}  ${pct(sum.bands.read.tokens).padStart(5)}   always read`
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
      if (existsSync13(p)) writeAtomic(p, "");
    } catch (err) {
      recordError("reset", err);
    }
  }
  say("Cleared .snout/ledger.jsonl, turns.jsonl, errors.jsonl, hooks.jsonl and state.json.");
}
function cmdDoctor(paths, cfg) {
  const rows = readDecisions(paths.ledger, 5e3);
  const t = totalsOf(rows.filter((r) => r.rule !== "reversal"));
  const errors = existsSync13(paths.errors) ? readFileSync13(paths.errors, "utf8").trim().split("\n").filter(Boolean) : [];
  const lines = [
    `snout ${VERSION2}`,
    `  node            ${process.version}`,
    `  bundle          ${runningBundle()}`,
    `  project         ${paths.projectDir}`,
    `  .snout            ${existsSync13(paths.snoutDir) ? "present" : "MISSING"}`,
    `  config          ${existsSync13(paths.config) ? paths.config : "no project file"}`,
    `  user defaults   ${existsSync13(userConfigPath()) ? userConfigPath() : "none (~/.snout/config.json)"}`,
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
  if (tp && existsSync13(tp)) {
    const u = readTranscriptUsage(readFileSync13(tp, "utf8"));
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
      n = readSync3(0, buf, 0, buf.length, null);
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
      const st = JSON.parse(readFileSync13(join16(dirname7(path), "state.json"), "utf8"));
      if (st.model && st.session === r.session) model = st.model;
    } catch {
    }
  }
  appendRow(path, { ...row, ...model ? { model } : {}, ...client ? { client } : {} });
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
    const p = join16(paths.projectDir, ".claude", f);
    if (!existsSync13(p)) continue;
    try {
      const settings = JSON.parse(readFileSync13(p, "utf8"));
      const entries = settings.hooks?.PreToolUse ?? [];
      for (const entry of entries) {
        if (!(entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("snout.mjs"))) continue;
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
    mkdirSync8(dirname7(file2), { recursive: true });
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
if (!["mcp", "dashboard", "login", "logout", "sync", "audit"].includes(process.argv[2] ?? "")) process.exit(0);
