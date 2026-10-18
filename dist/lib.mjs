// src/gate/tier0.ts
import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { relative, isAbsolute, join } from "node:path";

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
var MIGRATION_SNAPSHOT = /(^|\/)(migrations?|drizzle)\/meta\/\d{4}_snapshot\.json$/i;
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
      if (ext === "json" && MIGRATION_SNAPSHOT.test(s.rel)) {
        return low("generated", `${safePath(s.rel)} is a schema snapshot the migration tool writes for every migration; the .sql migrations hold the changes.`);
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
    const line = bannerLines.find((l) => l.toLowerCase().includes(marker.toLowerCase()));
    if (!line) continue;
    const at = line.toLowerCase().indexOf(marker.toLowerCase());
    const seen = line.slice(at, at + marker.length);
    if (!insideDoubleQuotes(line, seen) && GENERATOR_HINT.test(banner)) return seen;
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
  const abs = isAbsolute(absPath) ? absPath : join(projectDir, absPath);
  const rel = relative(projectDir, abs);
  return rel.startsWith("..") ? abs.replace(/\\/g, "/") : rel.replace(/\\/g, "/");
}
var gitignoreCache = /* @__PURE__ */ new Map();
function gitignoreRules(projectDir) {
  const hit = gitignoreCache.get(projectDir);
  if (hit) return hit;
  let rules = [];
  try {
    rules = parseGitignore(readFileSync(join(projectDir, ".gitignore"), "utf8"));
  } catch {
  }
  gitignoreCache.set(projectDir, rules);
  return rules;
}
function fingerprintOf(absPath) {
  try {
    const st = statSync(absPath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return void 0;
  }
}
function sizeOf(absPath) {
  try {
    return statSync(absPath).size;
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
    const raw = readFileSync(join(projectDir, ".snoutignore"), "utf8");
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
import { existsSync, statSync as statSync2 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join2, resolve } from "node:path";
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
    const abs = isAbsolute2(token) ? resolve(token) : resolve(join2(cwd, token));
    try {
      if (!existsSync(abs) || !statSync2(abs).isFile()) return;
    } catch {
      return;
    }
    if (!out.includes(abs)) out.push(abs);
  }
}

// src/gate/powershell.ts
import { existsSync as existsSync2, statSync as statSync3 } from "node:fs";
import { isAbsolute as isAbsolute3, resolve as resolve2 } from "node:path";
var WHOLE_READ = /^\s*(?:Get-Content|gc|type)\s+(?:-Raw\s+)?(?:(-LiteralPath|-Path)\s+)?(?:"([^"]+)"|'([^']+)'|([^\s"'`;&|<>$(){}\[\]*?]+))\s*(?:-Raw)?\s*$/i;
var PWSH_COMMAND = /^\s*(?:"([^"]+)"|([^\s"'`;&|<>]+))\s+(?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*-Command\s+(?:"([\s\S]*)"|'([\s\S]*)')\s*$/i;
function powerShellDumpTargets(command, cwd) {
  const wrapped = PWSH_COMMAND.exec(command);
  const exe = wrapped?.[1] ?? wrapped?.[2];
  const script = exe && /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(exe) ? wrapped?.[3] ?? wrapped?.[4] ?? command : command;
  const targets = /* @__PURE__ */ new Set();
  let activeCwd = cwd;
  for (const part of splitCommands(script)) {
    if (/^\s*(?:Set-Location|cd|sl|Push-Location|pushd|Pop-Location|popd)\b/i.test(part)) {
      const location = /^\s*(?:Set-Location|cd|sl)\s+(?:(?:-LiteralPath|-Path)\s+)?(?:"([^"`$]+)"|'([^'`$]+)'|([^\s"'`;&|<>$(){}\[\]*?]+))\s*$/i.exec(part);
      const path2 = location?.[1] ?? location?.[2] ?? location?.[3];
      const previousCwd = activeCwd;
      activeCwd = null;
      if (path2 && !/[`$*?\[\]]/.test(path2) && (previousCwd || isAbsolute3(path2))) {
        const directory = resolve2(previousCwd ?? cwd, path2);
        try {
          if (existsSync2(directory) && statSync3(directory).isDirectory()) activeCwd = directory;
        } catch {
        }
      }
      continue;
    }
    const match = WHOLE_READ.exec(part);
    if (!match) continue;
    const path = match[2] ?? match[3] ?? match[4];
    if (!path || path.startsWith("-")) continue;
    if (/[`$*?\[\]]/.test(path) || !activeCwd && !isAbsolute3(path)) continue;
    const abs = resolve2(isAbsolute3(path) ? path : resolve2(activeCwd, path));
    try {
      if (existsSync2(abs) && statSync3(abs).isFile()) targets.add(abs);
    } catch {
    }
  }
  return [...targets];
}
function boundedPowerShellRead(command, cwd, target, lines) {
  if (!Number.isInteger(lines) || lines < 1 || lines > 60) return null;
  const match = /^\s*Get-Content\s+-LiteralPath\s+(?:"([^"`$]+)"|'([^'`$]+)'|([^\s"'`;&|<>$(){}\[\]*?]+))\s*$/i.exec(command);
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!path || /[\r\n]/.test(path) || resolve2(cwd, path) !== resolve2(target)) return null;
  return `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -TotalCount ${lines}`;
}
function splitCommands(script) {
  const parts2 = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === "`") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && script[i + 1] === "'") i++;
        else quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&" && script[i + 1] === "&") {
      parts2.push(script.slice(start, i));
      if (ch === "&") i++;
      start = i + 1;
    }
  }
  parts2.push(script.slice(start));
  return parts2;
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

// src/gate/grep.ts
import { statSync as statSync4 } from "node:fs";
import { isAbsolute as isAbsolute4, join as join3 } from "node:path";
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
  const resolve9 = (p) => isAbsolute4(p) ? p : join3(cwd, p);
  const single = searchPath && isFile(resolve9(searchPath)) ? resolve9(searchPath) : null;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const bytes = Buffer.byteLength(line) + 1;
    if (i >= MAX_LINES || line === "" || line === "--") {
      rest += bytes;
      return;
    }
    const owner = ownerOf(line, resolve9, isFile) ?? single;
    if (owner) files.set(owner, (files.get(owner) ?? 0) + bytes);
    else rest += bytes;
  });
  return { files, rest };
}
function ownerOf(line, resolve9, isFile) {
  for (let i = 1; i < line.length && i < 1024; i++) {
    const c = line[i];
    if (c !== ":" && c !== "-") continue;
    const abs = resolve9(line.slice(0, i));
    if (isFile(abs)) return abs;
  }
  return null;
}

// src/config.ts
import { existsSync as existsSync4, readFileSync as readFileSync2, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as join4, relative as relative2, resolve as resolve3, isAbsolute as isAbsolute5 } from "node:path";

// src/util/log.ts
import { appendFileSync, existsSync as existsSync3, statSync as statSync5, truncateSync } from "node:fs";
var errorLogPath = null;
function setErrorLog(p) {
  errorLogPath = p;
}
function debug(...parts2) {
  if (!process.env.SNOUT_DEBUG) return;
  process.stderr.write(`[snout] ${parts2.map(fmt).join(" ")}
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
    if (existsSync3(errorLogPath) && statSync5(errorLogPath).size > 1048576) {
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
var PINNED_MODEL = "jev-1.13.0";
function resolvePaths(hookCwd) {
  const projectDir = projectRootOf(resolve3(hookCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  const snoutDir = process.env.SNOUT_DIR ? resolve3(process.env.SNOUT_DIR) : join4(projectDir, ".snout");
  if (!process.env.SNOUT_DIR) adoptLegacyDir(join4(projectDir, ".jev"), snoutDir);
  return {
    projectDir,
    snoutDir,
    config: join4(snoutDir, "config.json"),
    thresholds: join4(snoutDir, "thresholds.json"),
    ledger: join4(snoutDir, "ledger.jsonl"),
    turns: join4(snoutDir, "turns.jsonl"),
    errors: join4(snoutDir, "errors.jsonl"),
    hooks: join4(snoutDir, "hooks.jsonl"),
    state: join4(snoutDir, "state.json"),
    map: join4(snoutDir, "map.json")
  };
}
function attach(paths) {
  setErrorLog(paths.errors);
}
function ensureDir(snoutDir) {
  try {
    if (!existsSync4(snoutDir)) mkdirSync(snoutDir, { recursive: true });
  } catch (err) {
    recordError("ensureDir", err);
  }
}
function userConfigPath() {
  if (!process.env.SNOUT_HOME) adoptLegacyDir(join4(homedir(), ".jev"), join4(homedir(), ".snout"));
  return join4(process.env.SNOUT_HOME || join4(homedir(), ".snout"), "config.json");
}
function projectRootOf(dir) {
  const declared = process.env.CLAUDE_PROJECT_DIR ? resolve3(process.env.CLAUDE_PROJECT_DIR) : null;
  if (declared && isInside(dir, declared)) return declared;
  const home = resolve3(homedir());
  for (let d = dir; ; d = dirname(d)) {
    if (d === home || dirname(d) === d) return dir;
    if (existsSync4(join4(d, ".snout"))) return d;
  }
}
var isInside = (dir, root) => {
  const rel = relative2(root, dir);
  return rel === "" || !rel.startsWith("..") && !isAbsolute5(rel);
};
function adoptLegacyDir(legacy, current) {
  try {
    if (!existsSync4(current) && existsSync4(legacy)) renameSync(legacy, current);
  } catch (err) {
    recordError("adoptLegacyDir", err);
  }
}
function readLayer(file2) {
  if (!existsSync4(file2)) return {};
  try {
    const raw = JSON.parse(readFileSync2(file2, "utf8"));
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
function loadConfig(paths) {
  const cfg = { ...DEFAULTS, ...readLayer(userConfigPath()), ...readLayer(paths.config) };
  const envMode = process.env.SNOUT_MODE;
  if (envMode === "observe" || envMode === "advise" || envMode === "enforce") cfg.mode = envMode;
  if (process.env.SNOUT_DISABLE) cfg.mode = "observe";
  if (process.env.SNOUT_MEMORY === "1" || process.env.SNOUT_MEMORY === "0") cfg.memory = process.env.SNOUT_MEMORY === "1";
  if (process.env.SNOUT_REPO_MAP === "1" || process.env.SNOUT_REPO_MAP === "0") cfg.repoMap = process.env.SNOUT_REPO_MAP === "1";
  return cfg;
}
function isValidMode(v) {
  return v === "observe" || v === "advise" || v === "enforce";
}
function configDir() {
  if (process.env.SNOUT_CONFIG_DIR) return process.env.SNOUT_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join4(process.env.APPDATA, "snout");
  return join4(process.env.XDG_CONFIG_HOME || join4(homedir(), ".config"), "snout");
}

// src/ledger/store.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync3, statSync as statSync7 } from "node:fs";
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
import { closeSync as closeSync2, openSync as openSync2, readSync as readSync2, statSync as statSync6 } from "node:fs";
var BLOCK = 64 * 1024;
function tailLines(path, maxLines, maxBytes = 8 * 1024 * 1024) {
  let fd = null;
  try {
    const size = statSync6(path).size;
    if (size === 0) return [];
    fd = openSync2(path, "r");
    const chunks = [];
    let pos = size;
    let newlines = 0;
    let read2 = 0;
    while (pos > 0 && newlines <= maxLines && read2 < maxBytes) {
      const len = Math.min(BLOCK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      readSync2(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      read2 += len;
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
  if (!existsSync5(dir)) mkdirSync2(dir, { recursive: true });
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
  if (!existsSync5(path)) return [];
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
    if (!existsSync5(path) || statSync7(path).size < ROTATE_BYTES) return;
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
  if (existsSync5(path)) {
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
    out.push(`  ~${tok(withheld)} tokens were withheld, estimated from file sizes (not a billed saving); the rest you allowed or overrode.`);
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

// src/ledger/statusline.ts
function renderStatusline(rows, mode) {
  if (rows.length === 0) return "snout \xB7 watching";
  const t = totalsOf(rows);
  const pct2 = t.tokensOfferedEst > 0 ? Math.round(t.tokensAvoidedEst / t.tokensOfferedEst * 100) : 0;
  const tag = mode === "observe" ? "flagged" : "saved";
  const cost = t.jevCostUsd > 0 ? ` \xB7 $${t.jevCostUsd.toFixed(4)}` : "";
  return `snout ${pct2}% ${tag} \xB7 ~${fmtTokens(t.tokensAvoidedEst)} tok${cost}`;
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
    const read2 = reached ? r.tokensReadEst || 0 : 0;
    if (acted) gated += 1;
    if (r.observedOnly && isFlagged2(r)) couldHoldBack += r.tokensAvoidedEst || 0;
    inContext += read2;
    heldBack += held2;
    const dd = daily.get(r.ts.slice(0, 10));
    if (dd) {
      dd.reads += 1;
      dd.inContext += read2;
      dd.heldBack += held2;
    }
    if (r.ts.startsWith(day)) {
      today.reads += 1;
      today.inContext += read2;
      today.heldBack += held2;
    }
    bump(labels, labelOfRule(r.rule), read2, held2);
    bump(clients, clientOf(r), read2, held2);
    bump(files, r.path, read2, held2);
    bump(agents, agentOf(r), read2, held2);
    bump(models, r.model || "unknown", read2, held2);
    const s = sessions.get(r.session) ?? { key: r.session, reads: 0, inContext: 0, heldBack: 0, first: r.ts, last: r.ts, clients: [] };
    sessions.set(r.session, s);
    bump(sessions, r.session, read2, held2);
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
      inContext: read2,
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
    const client = clientOf(r);
    const server = mcpServerOf(r.tool);
    const label = server ? mcpLabel(server) : labelOfRule(r.rule);
    const model = (r.model || "").slice(0, 64);
    const key = `${day}\0${client}\0${model}\0${label}`;
    const d = m.get(key) ?? { day, client, model, label, reads: 0, gated: 0, inContext: 0, heldBack: 0, couldHoldBack: 0 };
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
    const client = clientOf(r);
    const model = (r.model || "").slice(0, 64);
    const label = mcpLabel(server);
    const key = `${day}\0${client}\0${model}\0${label}`;
    const d = m.get(key) ?? { day, client, model, label, reads: 0, gated: 0, inContext: 0, heldBack: 0, couldHoldBack: 0 };
    d.reads += 1;
    d.inContext += r.tokensReadEst || 0;
    m.set(key, d);
  }
  return [...m.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
}
var mcpLabel = (server) => `mcp-${server.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "server"}`;

// src/spend/usage.ts
import { existsSync as existsSync6, readdirSync, readFileSync as readFileSync5, statSync as statSync8, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname4, join as join7, resolve as resolve4, sep } from "node:path";

// src/spend/prices.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join6 } from "node:path";
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
    overrides = JSON.parse(readFileSync4(join6(configDir2, "prices.json"), "utf8"));
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
var claudeRoot = () => join7(process.env.CLAUDE_CONFIG_DIR || join7(homedir2(), ".claude"), "projects");
var codexRoot = () => join7(process.env.CODEX_HOME || join7(homedir2(), ".codex"), "sessions");
var claudeSlug = (projectDir) => resolve4(projectDir).replace(/[^A-Za-z0-9]/g, "-");
function jsonlFiles(dir, depth = 4) {
  if (depth < 0 || !existsSync6(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join7(dir, e.name);
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
function rollup(reqs, client, configDir2) {
  const m = /* @__PURE__ */ new Map();
  for (const r of reqs) {
    const key = `${r.day}\0${r.model}`;
    const s = m.get(key) ?? { day: r.day, client, model: r.model, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0 };
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
    return JSON.parse(readFileSync5(path, "utf8"));
  } catch {
    return {};
  }
}
function fileRows(file2, client, cache2, configDir2) {
  let st;
  try {
    st = statSync8(file2);
  } catch {
    return null;
  }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache2[file2];
  if (hit && hit.stamp === stamp) return hit;
  const text = readFileSync5(file2, "utf8");
  let entry;
  if (client === "claude") {
    const reqs = claudeRequests(text);
    entry = { stamp, client, cwd: reqs.find((r) => r.cwd)?.cwd ?? null, rows: rollup(reqs, client, configDir2) };
  } else {
    const { cwd, reqs } = codexRequests(text);
    entry = { stamp, client, cwd, rows: rollup(reqs, client, configDir2) };
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
  const claudeDirs = root ? [join7(claudeRoot(), claudeSlug(root))] : existsSync6(claudeRoot()) ? readdirSync(claudeRoot()).map((d) => join7(claudeRoot(), d)) : [];
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
  for (const k of Object.keys(cache2)) if (!existsSync6(k)) delete cache2[k];
  if (cachePath) try {
    mkdirSync3(dirname4(cachePath), { recursive: true });
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

// src/coach/coach.ts
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

// src/squeeze/squeeze.ts
var KINDS = [
  ["test", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(jest|vitest|mocha|playwright\s+test)\b|(jest|vitest|mocha|pytest|rspec|phpunit)\b|python3?\s+-m\s+(pytest|unittest)\b|python3?\s+(\S*\/)?runtests\.py\b|python3?\s+(\S*\/)?manage\.py\s+test\b|go\s+test\b|cargo\s+test\b|node\s+--test\b|deno\s+test\b)/],
  ["install", /(^|[\s;&|(])((npm|pnpm)\s+(i|install|ci|add)\b|yarn(\s+(install|add))?\s*($|[;&|])|bun\s+(i|install|add)\b|pip3?\s+install\b|poetry\s+install\b|bundle(\s+install)?\s*($|[;&|])|go\s+mod\s+(download|tidy)\b|cargo\s+fetch\b|brew\s+install\b)/],
  ["build", /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?build\b|npx\s+(tsc|vite|next|webpack)\b|\btsc\b|vite\s+build\b|next\s+build\b|webpack\b|cargo\s+build\b|go\s+build\b|make\b|mvn\b|\.?\/?gradlew?\b|docker\s+build\b)/],
  // Searches that walk a tree: recursive grep, ripgrep and friends, git grep, find, ls -R.
  ["search", /(^|[\s;&|(])(grep\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]|rg\s|ag\s|ack\s|git\s+grep\b|find\s+(\.|\/|~|\S+\s+-)|ls\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*R)/]
];
var unquoted = (command) => command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "").replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
function kindOf(command) {
  const bare = unquoted(command);
  for (const [k, re] of KINDS) if (re.test(bare)) return k;
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
        const parts2 = l.replace(/^\.\//, "").slice(prefix.length).split("/");
        const top = parts2.length > 2 ? parts2.slice(0, 2).join("/") + "/" : parts2.length === 2 ? parts2[0] + "/" : "(top level)";
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
import { existsSync as existsSync7, mkdirSync as mkdirSync4, readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";
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
var ENSURE = "serve --ensure";
function starterEntries(bin) {
  return [{ hooks: [{ type: "command", command: `node "${starterPath()}" "${bin}" ${ENSURE}`, timeout: 5 }] }];
}
var starterPath = () => join8(configDir(), "snout-starter.mjs");
var STARTER = `// Written by Snout (snout fast on). Starts the local Snout server for the fast gate.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const [bin, ...args] = process.argv.slice(2);
function plugin() {
  try {
    const j = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plugins", "installed_plugins.json"), "utf8"));
    for (const e of (j.plugins ?? j)["snout@snout-context"] ?? []) {
      const p = e?.installPath && join(e.installPath, "dist", "snout.mjs");
      if (p && existsSync(p)) return p;
    }
  } catch {}
  return null;
}
const inPlugin = /[\\\\/]\\.claude[\\\\/]plugins[\\\\/]/.test(bin ?? "");
const run = (inPlugin ? plugin() : null) ?? (bin && existsSync(bin) ? bin : null) ?? plugin();
if (run) spawnSync(process.execPath, [run, ...args], { stdio: "ignore", timeout: 4000, windowsHide: true });
`;
function writeStarter() {
  const file2 = starterPath();
  try {
    if (readFileSync6(file2, "utf8") === STARTER) return;
  } catch {
  }
  mkdirSync4(configDir(), { recursive: true });
  writeAtomic(file2, STARTER);
}
var STARTER_EVENTS = ["SessionStart", "UserPromptSubmit"];
var ours = (h, event) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes(event) || typeof h.url === "string" && h.url.includes(URL_MARK + event);
var isGate = (e) => (e.hooks ?? []).some((h) => ours(h, "pre-tool"));
var isSqueeze = (e) => (e.hooks ?? []).some((h) => ours(h, "squeeze"));
var isStarter = (e) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && h.command.includes(ENSURE));
function read(file2) {
  try {
    return JSON.parse(readFileSync6(file2, "utf8"));
  } catch {
    return {};
  }
}
function write(file2, settings) {
  mkdirSync4(join8(file2, ".."), { recursive: true });
  writeAtomic(file2, JSON.stringify(settings, null, 2) + "\n");
}
function strip(settings) {
  let changed = false;
  for (const [event, mine] of [["PreToolUse", isGate], ["PostToolUse", isSqueeze], ...STARTER_EVENTS.map((ev) => [ev, isStarter])]) {
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
  const file2 = join8(projectDir, ".claude", "settings.local.json");
  const settings = read(file2);
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...settings.hooks.PreToolUse ?? [], ...gateEntries(bin, fast)];
  settings.hooks.PostToolUse = [...settings.hooks.PostToolUse ?? [], ...squeezeEntries(bin, fast)];
  if (fast) writeStarter();
  if (fast) for (const ev of STARTER_EVENTS) settings.hooks[ev] = [...settings.hooks[ev] ?? [], ...starterEntries(bin)];
  write(file2, settings);
  return file2;
}
function removeGate(projectDir) {
  let removed = false;
  for (const name of SETTINGS) {
    const file2 = join8(projectDir, ".claude", name);
    if (!existsSync7(file2)) continue;
    const settings = read(file2);
    if (strip(settings)) {
      write(file2, settings);
      removed = true;
    }
  }
  return removed;
}
function refreshGate(projectDir, bin) {
  for (const name of SETTINGS) {
    const file2 = join8(projectDir, ".claude", name);
    if (!existsSync7(file2)) continue;
    const hooks = read(file2).hooks ?? {};
    const gate = (hooks.PreToolUse ?? []).filter(isGate);
    if (!gate.length) continue;
    const fast = gate.some((e) => (e.hooks ?? []).some((h) => isSnoutUrl(h.url)));
    const elsewhere = (e) => (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARK) && !h.command.includes(`"${bin}"`));
    const starters = STARTER_EVENTS.map((ev) => (hooks[ev] ?? []).filter(isStarter));
    const stale = gate.some(elsewhere) || starters.some((l) => l.some(elsewhere)) || fast && starters.some((l) => !l.length);
    if (stale) {
      installGate(projectDir, bin, fast);
      return true;
    }
  }
  return false;
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

// src/audit/context.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync as existsSync8, lstatSync, mkdirSync as mkdirSync5, readdirSync as readdirSync2, readFileSync as readFileSync7, realpathSync, renameSync as renameSync3, rmdirSync, statSync as statSync9, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename as basename2, dirname as dirname5, extname, isAbsolute as isAbsolute6, join as join9, relative as relative3, resolve as resolve5, sep as sep2 } from "node:path";
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
    entries = readdirSync2(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join9(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1);
    } else if (e.isFile()) out.push(p);
    else if (e.isSymbolicLink()) {
      try {
        if (statSync9(p).isFile()) out.push(p);
      } catch {
      }
    }
  }
}
function projectFiles(projectDir) {
  const set = /* @__PURE__ */ new Set();
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: projectDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    for (const f of out.split("\0")) if (f && !f.split("/").some((s) => SKIP_DIRS.has(s))) set.add(join9(projectDir, f));
  } catch {
    const all = [];
    walk(projectDir, all);
    for (const f of all) set.add(f);
  }
  for (const d of [".claude", ".cursor", ".windsurf", ".clinerules", ".github", ".gemini", ".codex"]) {
    const p = join9(projectDir, d);
    if (existsSync8(p) && statSync9(p).isDirectory()) {
      const all = [];
      walk(p, all);
      for (const f of all) set.add(f);
    }
  }
  for (const f of [".cursorrules", ".windsurfrules", ".clinerules", "CLAUDE.local.md"]) {
    const p = join9(projectDir, f);
    if (existsSync8(p) && statSync9(p).isFile()) set.add(p);
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
  const p = rel.split(sep2).join("/");
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
  if (/^\.claude\/rules\/.+\.md$/i.test(p)) return { kind: "always", role: "rules", agents: ["claude"] };
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
function claudeImports(text, fileAbs, home) {
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
  const out = /* @__PURE__ */ new Set();
  for (const m of prose.matchAll(/(?:^|\s)@((?:~\/)?[^\s`'"()<>[\]]+)/g)) {
    const p = m[1].replace(/[.,;:!?]+$/, "");
    const abs = p.startsWith("~/") ? join9(home, p.slice(2)) : isAbsolute6(p) ? p : resolve5(dirname5(fileAbs), p);
    try {
      if (statSync9(abs).isFile()) out.add(abs);
    } catch {
    }
  }
  return [...out];
}
function addImports(found, projectDir, home) {
  const byAbs = new Map(found.map((f) => [resolve5(f.abs), f]));
  const name = (abs) => (abs.startsWith(projectDir + sep2) ? relative3(projectDir, abs) : "~/" + relative3(home, abs)).split(sep2).join("/");
  let level = found.filter((f) => f.kind === "always" && f.role === "instructions" && f.agents.includes("claude")).map((f) => resolve5(f.abs));
  const seen = new Set(level);
  for (let hop = 0; hop < 5 && level.length; hop++) {
    const next = [];
    for (const from of level) {
      let text;
      try {
        text = readFileSync7(from, "utf8");
      } catch {
        continue;
      }
      for (const abs of claudeImports(text, from, home)) {
        if (seen.has(abs)) continue;
        seen.add(abs);
        next.push(abs);
        const f = byAbs.get(abs);
        if (f) {
          if (f.kind === "always" && f.agents.includes("claude")) continue;
          f.kind = "always";
          f.agents = [.../* @__PURE__ */ new Set([...f.agents.filter((a) => a !== "any"), "claude"])];
          f.importedBy ??= name(from);
        } else {
          const nf = { abs, scope: abs.startsWith(projectDir + sep2) ? "project" : "user", kind: "always", role: "import", agents: ["claude"], importedBy: name(from) };
          found.push(nf);
          byAbs.set(abs, nf);
        }
      }
    }
    level = next;
  }
}
function userFiles(projectDir, home) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join9(home, ".claude");
  const out = [];
  const add = (abs, f) => {
    if (existsSync8(abs)) out.push({ abs, scope: "user", ...f });
  };
  add(join9(claudeDir, "CLAUDE.md"), { kind: "always", role: "instructions", agents: ["claude"] });
  add(join9(claudeDir, "projects", resolve5(projectDir).replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md"), { kind: "always", role: "memory", agents: ["claude"] });
  add(join9(process.env.CODEX_HOME || join9(home, ".codex"), "AGENTS.md"), { kind: "always", role: "instructions", agents: ["codex"] });
  add(join9(home, ".gemini", "GEMINI.md"), { kind: "always", role: "instructions", agents: ["gemini"] });
  const list = (dir, re, role, kind = "described") => {
    if (!existsSync8(dir)) return;
    const all = [];
    walk(dir, all, 9);
    for (const f of all) if (re.test(relative3(dir, f).split(sep2).join("/"))) out.push({ abs: f, scope: "user", kind, role, agents: ["claude"] });
  };
  list(join9(claudeDir, "rules"), /\.md$/i, "rules", "always");
  list(join9(claudeDir, "skills"), /^[^/]+\/SKILL\.md$/i, "skill");
  list(join9(claudeDir, "commands"), /\.md$/i, "command");
  list(join9(claudeDir, "agents"), /\.md$/i, "agent");
  out.push(...pluginFiles(projectDir, claudeDir));
  return out;
}
function pluginFiles(projectDir, claudeDir) {
  const json = (p) => {
    try {
      return JSON.parse(readFileSync7(p, "utf8"));
    } catch {
      return null;
    }
  };
  const enabled = {};
  for (const p of [join9(claudeDir, "settings.json"), join9(projectDir, ".claude", "settings.json"), join9(projectDir, ".claude", "settings.local.json")])
    Object.assign(enabled, json(p)?.enabledPlugins ?? {});
  const installed = json(join9(claudeDir, "plugins", "installed_plugins.json"))?.plugins ?? {};
  const here = resolve5(projectDir).toLowerCase();
  const out = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true || !Array.isArray(installed[id])) continue;
    const entries = installed[id];
    const entry = entries.find((e) => e.projectPath && resolve5(e.projectPath).toLowerCase() === here) ?? entries.find((e) => e.scope === "user") ?? entries[0];
    const root = entry?.installPath;
    if (!root || !existsSync8(root)) continue;
    const plugin = id.split("@")[0];
    for (const [sub, re, role] of [["skills", /^[^/]+\/SKILL\.md$/i, "skill"], ["commands", /\.md$/i, "command"], ["agents", /\.md$/i, "agent"]]) {
      const dir = join9(root, sub);
      if (!existsSync8(dir)) continue;
      const all = [];
      walk(dir, all, 9);
      for (const f of all) if (re.test(relative3(dir, f).split(sep2).join("/"))) out.push({ abs: f, scope: "user", kind: "described", role, agents: ["claude"], plugin });
    }
  }
  return out;
}
var bump2 = (m, key, ts) => {
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
      while (m = re.exec(text2)) if (ts >= since) bump2(u.commands, m[1].toLowerCase(), ts);
    }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== "tool_use" || typeof c.name !== "string") continue;
      const input = c.input ?? {};
      const file2 = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name) && file2) u.writes.add(resolve5(file2));
      if (ts < since) continue;
      if (c.name === "Read" && file2) bump2(u.reads, resolve5(file2), ts);
      else if (c.name === "Skill" && typeof input.skill === "string") bump2(u.skills, input.skill.toLowerCase().split(":").pop(), ts);
      else if ((c.name === "Agent" || c.name === "Task") && typeof input.subagent_type === "string") bump2(u.agents, input.subagent_type.toLowerCase().split(":").pop(), ts);
      else if (c.name === "SlashCommand" && typeof input.command === "string") bump2(u.commands, input.command.replace(/^\//, "").split(/\s/)[0].toLowerCase(), ts);
    }
  }
}
function collectUsage(projectDir, days, home, ledger) {
  const u = { reads: /* @__PURE__ */ new Map(), skills: /* @__PURE__ */ new Map(), commands: /* @__PURE__ */ new Map(), agents: /* @__PURE__ */ new Map(), writes: /* @__PURE__ */ new Set(), codex: [], sources: [] };
  const since = new Date(Date.now() - days * DAY).toISOString();
  const dir = resolve5(projectDir);
  const root = join9(process.env.CLAUDE_CONFIG_DIR || join9(home, ".claude"), "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
  if (existsSync8(root)) {
    let n = 0;
    for (const f of readdirSync2(root)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const path = join9(root, f);
        readClaudeTranscript(readFileSync7(path, "utf8"), u, since, statSync9(path).mtime.toISOString());
        n++;
      } catch {
      }
    }
    if (n) u.sources.push(`${n} Claude Code session${n === 1 ? "" : "s"}`);
  }
  const codexRoot2 = join9(process.env.CODEX_HOME || join9(home, ".codex"), "sessions");
  if (existsSync8(codexRoot2)) {
    const files = [];
    walk(codexRoot2, files, 8);
    let n = 0;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = statSync9(f);
        if (st.mtimeMs < Date.now() - days * DAY) continue;
        const text = readFileSync7(f, "utf8");
        const cwd = JSON.stringify(dir).slice(1, -1);
        if (!text.includes(`"cwd":"${cwd}`) && !text.includes(`"cwd": "${cwd}`)) continue;
        n++;
        const ts = st.mtime.toISOString();
        const patch = /\*\*\* (?:Add|Update) File: ([^\\\n"]+)/g;
        let m;
        while (m = patch.exec(text)) u.writes.add(resolve5(dir, m[1].trim()));
        u.codex.push([text, ts]);
      } catch {
      }
    }
    if (n) u.sources.push(`${n} Codex session${n === 1 ? "" : "s"}`);
  }
  if (ledger?.length) {
    let n = 0;
    for (const r of ledger) if (r.ts >= since && r.path) {
      bump2(u.reads, resolve5(dir, r.path), r.ts);
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
function authorOf(git2, agentWrote) {
  const ai = (git2?.ai ?? 0) + (agentWrote ? 1 : 0);
  const human = git2?.human ?? 0;
  if (!ai && !human) return "unknown";
  if (ai && human) return "mixed";
  return ai ? "ai" : "human";
}
var normalize = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function shingles(norm2, k = 5) {
  const w = norm2.split(" ").filter(Boolean);
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
function topTerms(norm2, n = 40) {
  const counts = /* @__PURE__ */ new Map();
  for (const w of norm2.split(" ")) if (w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
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
    if (!(c.includes("/") || /\.[a-z0-9]{1,6}$/i.test(c)) || isAbsolute6(c) || /^\.+$/.test(c) || c.endsWith("/")) continue;
    if (/^\d+(\.\d+)+$/.test(c)) continue;
    const fromFile = resolve5(dirname5(fileAbs), c), fromRoot = resolve5(projectDir, c);
    if (!fromFile.startsWith(projectDir) && !fromRoot.startsWith(projectDir)) continue;
    if (existsSync8(fromFile) || existsSync8(fromRoot)) continue;
    if (everExisted) {
      const rels = [relative3(projectDir, fromFile), relative3(projectDir, fromRoot)].map((r) => r.split(sep2).join("/"));
      if (rels.some((r) => everExisted.has(r))) missing.add(c);
      continue;
    }
    const parentExists = (p) => {
      const d = dirname5(p);
      return d !== projectDir && existsSync8(d);
    };
    if (c.includes("/") ? parentExists(fromFile) || parentExists(fromRoot) : false) missing.add(c);
  }
  let scripts = null;
  const relDir = relative3(projectDir, dirname5(fileAbs)).split(sep2);
  const pkgDir = existsSync8(join9(dirname5(fileAbs), "package.json")) ? dirname5(fileAbs) : relDir[0] === "" || /^\.(claude|cursor|github|windsurf|clinerules|gemini|codex)$/.test(relDir[0] ?? "") ? projectDir : null;
  if (pkgDir && existsSync8(join9(pkgDir, "package.json"))) {
    try {
      scripts = JSON.parse(readFileSync7(join9(pkgDir, "package.json"), "utf8")).scripts ?? {};
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
  const dir = resolve5(projectDir);
  const home = opts.home ?? homedir3();
  const days = opts.days ?? 30;
  const maxTok = opts.oversizedTokens ?? OVERSIZED_TOKENS;
  const found = [];
  for (const abs of projectFiles(dir)) {
    const c = classifyContextPath(relative3(dir, abs));
    if (c) found.push({ abs, scope: "project", ...c });
  }
  found.push(...userFiles(dir, home));
  addImports(found, dir, home);
  const workspaceScripts = /* @__PURE__ */ new Set();
  for (const abs of projectFiles(dir)) {
    if (basename2(abs) !== "package.json") continue;
    try {
      for (const k of Object.keys(JSON.parse(readFileSync7(abs, "utf8")).scripts ?? {})) workspaceScripts.add(k);
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
  const git2 = history.files;
  const now = Date.now();
  const files = [];
  const texts = /* @__PURE__ */ new Map();
  for (const f of found) {
    let text = "";
    let st;
    try {
      st = statSync9(f.abs);
      if (st.size > 2 * 1024 * 1024) continue;
      text = readFileSync7(f.abs, "utf8");
    } catch {
      continue;
    }
    const rel = f.scope === "project" ? relative3(dir, f.abs).split(sep2).join("/") : f.plugin ? `plugin:${f.plugin}/${f.abs.split(sep2).join("/").split("/").slice(f.role === "skill" ? -3 : -2).join("/")}` : "~/" + relative3(home, f.abs).split(sep2).join("/");
    const tokens2 = estimateTokens(st.size, f.abs);
    const fm = frontmatter(text);
    let kind = f.kind;
    if (f.role === "rules" && extname(f.abs) === ".mdc" && fm.alwaysapply !== "true") kind = "described";
    if (f.role === "rules" && f.agents.includes("claude") && "paths" in fm && !f.importedBy) kind = "on-demand";
    const desc = (fm.name ?? "") + " " + (fm.description ?? text.replace(/^---[\s\S]*?---/, "").trim().split("\n")[0] ?? "");
    const perSession = kind === "always" ? tokens2 : kind === "described" ? estimateTokens(Buffer.byteLength(desc), "x.md") : 0;
    let use;
    const id = (fm.name || (f.role === "skill" ? basename2(dirname5(f.abs)) : basename2(f.abs).replace(MD, ""))).toLowerCase();
    if (f.role === "skill") use = usage.skills.get(id) ?? usage.skills.get(basename2(dirname5(f.abs)).toLowerCase());
    else if (f.role === "command") use = usage.commands.get(relative3(join9(dirname5(f.abs).split(`${sep2}commands`)[0], "commands"), f.abs).replace(MD, "").split(sep2).join(":").toLowerCase()) ?? usage.commands.get(id);
    else if (f.role === "agent") use = usage.agents.get(id);
    if (f.plugin && !use && f.role !== "agent") use = usage.commands.get(`${f.plugin.toLowerCase()}:${id}`) ?? (f.role === "skill" ? usage.commands.get(id) : void 0);
    const read2 = usage.reads.get(f.abs);
    if (read2) use = use ? [use[0] + read2[0], read2[1] > use[1] ? read2[1] : use[1]] : read2;
    if (f.scope === "project" && usage.codex.length) {
      for (const [t, ts] of usage.codex) if (t.includes(rel)) use = use ? [use[0] + 1, ts > use[1] ? ts : use[1]] : [1, ts];
    }
    const g = f.scope === "project" ? git2.get(rel) : void 0;
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
      savePerSession: 0,
      ...f.importedBy ? { importedBy: f.importedBy } : {}
    });
    texts.set(f.abs, text);
  }
  const byReal = /* @__PURE__ */ new Map();
  for (const f of files) {
    try {
      if (!lstatSync(f.abs).isSymbolicLink()) byReal.set(realpathSync(f.abs), f);
    } catch {
    }
  }
  for (const f of files) {
    try {
      if (lstatSync(f.abs).isSymbolicLink()) {
        const t = byReal.get(realpathSync(f.abs));
        if (t) f.linkTo = t.path;
      }
    } catch {
    }
  }
  const flag = (f, code, reason, save = 0, action = ACTION[code]) => {
    f.flags.push({ code, reason, action });
    f.savePerSession = Math.max(f.savePerSession, save);
  };
  const old = (f) => now - Date.parse(f.created) > days * DAY;
  for (const f of files) {
    const name = basename2(f.path);
    if (f.kind === "always" && f.tokens > maxTok && !f.linkTo)
      flag(f, "oversized", `loaded into every session at ~${fmtTokens(f.tokens)} tokens${f.importedBy ? ` (imported by ${f.importedBy})` : ""}; over ${fmtTokens(maxTok)}, move detail into skills or docs read on demand`, f.tokens - maxTok);
    if (f.kind === "described" && old(f) && f.uses === 0)
      flag(f, "unused", `not invoked in ${days} days; its description still costs ~${fmtTokens(f.perSession)} tokens every session${f.path.startsWith("plugin:") ? `; disable the ${f.path.slice(7).split("/")[0]} plugin if you don't use it` : ""}`, f.perSession);
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
  const comparable = files.filter((f) => !f.linkTo && !f.path.startsWith("plugin:") && (texts.get(f.abs) ?? "").length > 80).sort((a, b) => b.tokens - a.tokens).slice(0, 1500);
  const shared = (a, b) => a.agents.some((x) => b.agents.includes(x));
  const agentContext = (f) => f.kind !== "on-demand" || f.role !== "doc" || f.agents[0] !== "any" || REPORT_NAME.test(basename2(f.path).replace(MD, "")) || !f.path.includes("/");
  const tail2 = (p) => p.replace(/^\.[a-z]+\//i, "");
  const mirror = (a, b) => a.path !== b.path && tail2(a.path) === tail2(b.path) && !shared(a, b);
  const norm2 = new Map(comparable.map((f) => [f.abs, normalize(texts.get(f.abs))]));
  const sh = new Map(comparable.map((f) => [f.abs, shingles(norm2.get(f.abs))]));
  const hash = /* @__PURE__ */ new Map();
  for (const f of comparable) {
    const h = createHash("sha256").update(norm2.get(f.abs)).digest("hex");
    const first = hash.get(h);
    if (!first) {
      hash.set(h, f);
      continue;
    }
    if (!agentContext(first) && !agentContext(f)) continue;
    if (first.kind === "always" && f.kind === "always" && basename2(first.path).toLowerCase() === basename2(f.path).toLowerCase()) continue;
    if (mirror(first, f)) {
      flag(f, "duplicate", `mirror of ${first.path} for another agent; a symlink keeps them in step`);
      continue;
    }
    const [keep, drop] = first.perSession > f.perSession ? [f, first] : [first, f];
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
  const terms2 = new Map(instr.map((f) => [f.abs, topTerms(normalize(texts.get(f.abs)))]));
  const conflictCandidates = [];
  for (let i = 0; i < instr.length; i++) {
    for (let j = i + 1; j < instr.length; j++) {
      const a = instr[i], b = instr[j];
      if (a.flags.some((x) => /duplicate/.test(x.code)) || b.flags.some((x) => /duplicate/.test(x.code))) continue;
      const ta = terms2.get(a.abs), tb = terms2.get(b.abs);
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
var AGENT_FOLDER = /^\.(claude|github|cursor|windsurf|clinerules|gemini|codex|agents)\//;
function perAgent(always) {
  const byPath = new Map(always.map((f) => [f.path, f]));
  const atRoot = (f, seen = /* @__PURE__ */ new Set()) => {
    if (f.scope === "user" || !f.path.includes("/") || AGENT_FOLDER.test(f.path)) return true;
    const from = f.importedBy && byPath.get(f.importedBy);
    if (!from || seen.has(f.path)) return false;
    seen.add(f.path);
    return atRoot(from, seen);
  };
  const by = {};
  for (const f of always) if (atRoot(f)) {
    for (const ag of f.agents) if (ag !== "any") by[ag] = (by[ag] ?? 0) + f.tokens;
  }
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
    lines.push([f.linkTo ? `${f.path} -> ${f.linkTo}` : f.importedBy ? `${f.path} <- @${f.importedBy}` : f.path, f.kind, f.role, f.tokens, f.perSession, f.uses === null ? "-" : f.uses, f.kind === "always" ? "-" : when(f.lastUsed), f.author, f.flags.map((x) => `${x.code}\u2192${x.action}(${x.reason})`).join("; ") || "-"].join(" | "));
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
var archiveRoot = (projectDir) => join9(resolve5(projectDir), ".snout", "archive");
function archiveFiles(projectDir, paths, now = /* @__PURE__ */ new Date()) {
  const dir = resolve5(projectDir);
  const id = now.toISOString().replace(/[:.]/g, "-");
  const base = join9(archiveRoot(dir), id);
  const files = [];
  const todo = [];
  for (const p of paths) {
    const abs = resolve5(dir, p);
    const rel = relative3(dir, abs);
    if (!rel || rel.startsWith("..") || isAbsolute6(rel)) throw new Error(`${p} is outside the project`);
    if (rel.split(sep2)[0] === ".snout" || rel.split(sep2)[0] === ".git") throw new Error(`${p} can't be archived`);
    if (!existsSync8(abs) || !statSync9(abs).isFile()) throw new Error(`${p} is not a file`);
    const buf = readFileSync7(abs);
    files.push({ path: rel.split(sep2).join("/"), bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
    todo.push([abs, join9(base, rel)]);
  }
  if (!todo.length) throw new Error("no files given");
  mkdirSync5(base, { recursive: true });
  const manifest = { id, created: now.toISOString(), files };
  writeFileSync3(join9(base, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const [from, to] of todo) {
    mkdirSync5(dirname5(to), { recursive: true });
    renameSync3(from, to);
  }
  return manifest;
}
function listArchives(projectDir) {
  const root = archiveRoot(projectDir);
  if (!existsSync8(root)) return [];
  const out = [];
  for (const id of readdirSync2(root).sort()) {
    try {
      out.push(JSON.parse(readFileSync7(join9(root, id, "manifest.json"), "utf8")));
    } catch {
    }
  }
  return out;
}
function restoreArchive(projectDir, id) {
  const dir = resolve5(projectDir);
  if (!/^[0-9TZ-]+$/.test(id)) throw new Error(`no archive ${id}`);
  const base = join9(archiveRoot(dir), id);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync7(join9(base, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`no archive ${id}`);
  }
  const restored = [], skipped = [];
  for (const f of manifest.files) {
    const from = join9(base, f.path), to = resolve5(dir, f.path);
    if (relative3(dir, to).startsWith("..")) {
      skipped.push(f.path);
      continue;
    }
    if (!existsSync8(from)) {
      if (!existsSync8(to)) skipped.push(f.path);
      continue;
    }
    if (existsSync8(to)) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync5(dirname5(to), { recursive: true });
    renameSync3(from, to);
    restored.push(f.path);
  }
  if (!skipped.length) {
    const prune = (d) => {
      for (const e of readdirSync2(d, { withFileTypes: true })) if (e.isDirectory()) prune(join9(d, e.name));
      try {
        if (d !== base) rmdirSync(d);
      } catch {
      }
    };
    prune(base);
    try {
      renameSync3(join9(base, "manifest.json"), join9(archiveRoot(dir), `${id}.restored.json`));
      rmdirSync(base);
    } catch {
    }
  }
  return { restored, skipped };
}

// src/audit/ci.ts
import { existsSync as existsSync9, readdirSync as readdirSync3, readFileSync as readFileSync8 } from "node:fs";
import { join as join10, resolve as resolve6 } from "node:path";

// src/audit/yaml.ts
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q && !(q === '"' && s[i - 1] === "\\")) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}
function scalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\(["\\])/g, "$1");
  if (s.startsWith("[") || s.startsWith("{")) return flow(s, { i: 0 });
  return s;
}
function flow(s, p) {
  const ws = () => {
    while (p.i < s.length && /\s/.test(s[p.i])) p.i++;
  };
  ws();
  const open = s[p.i];
  if (open === "[" || open === "{") {
    p.i++;
    const close = open === "[" ? "]" : "}";
    const list = [];
    const map = {};
    for (; ; ) {
      ws();
      if (s[p.i] === close) {
        p.i++;
        break;
      }
      if (p.i >= s.length) break;
      if (open === "[") list.push(flow(s, p));
      else {
        const key = atom(s, p, ":}");
        if (s[p.i] === ":") {
          p.i++;
          map[String(key ?? "")] = flow(s, p);
        } else map[String(key ?? "")] = null;
      }
      ws();
      if (s[p.i] === ",") p.i++;
    }
    return open === "[" ? list : map;
  }
  return atom(s, p, ",]}");
}
function atom(s, p, stops) {
  while (p.i < s.length && /\s/.test(s[p.i])) p.i++;
  const q = s[p.i];
  if (q === '"' || q === "'") {
    let j2 = p.i + 1;
    while (j2 < s.length && !(s[j2] === q && s[j2 - 1] !== "\\")) j2++;
    const v2 = scalar(s.slice(p.i, j2 + 1));
    p.i = j2 + 1;
    return v2;
  }
  let j = p.i;
  while (j < s.length && !stops.includes(s[j]) && !(s[j] === ":" && /\s|$/.test(s[j + 1] ?? ""))) j++;
  if (stops.includes(":") && s[j] === ":") {
    const v2 = s.slice(p.i, j).trim();
    p.i = j;
    return v2;
  }
  const v = scalar(s.slice(p.i, j));
  p.i = j;
  return v;
}
function keySplit(t) {
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) {
      q = c;
      continue;
    }
    if (c === "[" || c === "{") return -1;
    if (c === ":" && (i === t.length - 1 || t[i + 1] === " " || t[i + 1] === "	")) return i;
  }
  return -1;
}
function parseYaml(text) {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const lines = [];
  raw.forEach((r, n) => {
    if (/^\s*(#|$)/.test(r) || /^(---|\.\.\.)\s*$/.test(r)) {
      lines.push({ indent: -1, text: "", n, raw: r });
      return;
    }
    lines.push({ indent: r.length - r.trimStart().length, text: stripComment(r.trim()), n, raw: r });
  });
  const p = { i: 0 };
  const skip = () => {
    while (p.i < lines.length && lines[p.i].indent < 0) p.i++;
  };
  function blockScalar(header, parent) {
    const folded = header.startsWith(">");
    const keep = header.includes("+"), strip2 = header.includes("-");
    const body = [];
    let ind = -1;
    while (p.i < lines.length) {
      const l = lines[p.i];
      if (l.indent >= 0 && l.indent <= parent) break;
      if (l.indent < 0) {
        body.push("");
        p.i++;
        continue;
      }
      if (ind < 0) ind = l.indent;
      body.push(l.raw.slice(Math.min(ind, l.indent)));
      p.i++;
    }
    while (!keep && body.length && body[body.length - 1] === "") body.pop();
    const out = folded ? body.join("\n").replace(/([^\n])\n(?=[^\n ])/g, "$1 ") : body.join("\n");
    return strip2 ? out : out + "\n";
  }
  function value(rest, indent) {
    const v = rest.trim();
    if (/^[|>][-+0-9]*$/.test(v)) return blockScalar(v, indent);
    if (v === "") {
      skip();
      const next = lines[p.i];
      if (!next) return null;
      if (next.indent > indent || next.indent === indent && (next.text.startsWith("- ") || next.text === "-")) return block(next.indent);
      return null;
    }
    return scalar(v);
  }
  function block(indent) {
    skip();
    const first = lines[p.i];
    if (!first) return null;
    if (first.text === "-" || first.text.startsWith("- ")) {
      const list = [];
      while (p.i < lines.length) {
        skip();
        const l = lines[p.i];
        if (!l || l.indent !== indent || !(l.text === "-" || l.text.startsWith("- "))) break;
        const inner = l.text === "-" ? "" : l.text.slice(2);
        const innerIndent = indent + (l.text.length - l.text.slice(1).trimStart().length);
        p.i++;
        if (inner === "") {
          list.push(value("", indent));
          continue;
        }
        const k = keySplit(inner);
        if (k >= 0 && !/^["'[{]/.test(inner)) {
          const map = {};
          map[unquote(inner.slice(0, k))] = value(inner.slice(k + 1), innerIndent);
          Object.assign(map, mapAt(innerIndent));
          list.push(map);
        } else list.push(value(inner, indent));
      }
      return list;
    }
    return mapAt(indent);
  }
  function mapAt(indent) {
    const map = {};
    while (p.i < lines.length) {
      skip();
      const l = lines[p.i];
      if (!l || l.indent !== indent || l.text.startsWith("- ") || l.text === "-") break;
      const k = keySplit(l.text);
      p.i++;
      if (k < 0) continue;
      map[unquote(l.text.slice(0, k))] = value(l.text.slice(k + 1), indent);
    }
    return map;
  }
  skip();
  return lines[p.i] ? block(lines[p.i].indent) : null;
}
var unquote = (k) => {
  const s = k.trim();
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
};
var asMap = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
var asList = (v) => Array.isArray(v) ? v : v == null ? [] : [v];
var asStr = (v) => typeof v === "string" ? v : "";

// src/audit/ci.ts
var PR_EVENTS = /* @__PURE__ */ new Set(["pull_request", "pull_request_target"]);
var COMMENT_EVENTS = /* @__PURE__ */ new Set(["issue_comment", "pull_request_review_comment", "pull_request_review", "discussion_comment"]);
var PR_DEFAULT_TYPES = ["opened", "synchronize", "reopened"];
function triggersOf(on) {
  const events = {};
  if (typeof on === "string") events[on] = {};
  else if (Array.isArray(on)) for (const e of on) events[asStr(e)] = {};
  else for (const [k, v] of Object.entries(asMap(on))) events[k] = k === "schedule" ? { cron: asList(v).map((c) => asStr(asMap(c).cron)) } : asMap(v);
  const triggers = Object.entries(events).map(([event, cfg]) => {
    const parts2 = [];
    if (cfg.types) parts2.push(`types: ${asList(cfg.types).map(asStr).join(", ")}`);
    else if (PR_EVENTS.has(event)) parts2.push("types: opened, synchronize, reopened (default)");
    if (cfg.branches) parts2.push(`branches: ${asList(cfg.branches).map(asStr).join(", ")}`);
    if (cfg.paths) parts2.push("paths filter");
    if (event === "schedule") parts2.push(asList(cfg.cron).map(asStr).join(", "));
    return { event, detail: parts2.join("; ") };
  });
  return { triggers, events };
}
function cronPerMonth(cron) {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const count = (field, size) => {
    let n = 0;
    for (const part of field.split(",")) {
      const [range, step] = part.split("/");
      const s = Number(step ?? 1) || 1;
      if (range === "*") n += Math.ceil(size / s);
      else if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        n += Math.floor(((b ?? 0) - (a ?? 0)) / s) + 1;
      } else n += 1;
    }
    return n;
  };
  const perDay = count(f[0], 60) * count(f[1], 24);
  const days = f[4] !== "*" ? 30 * count(f[4], 7) / 7 : f[2] !== "*" ? count(f[2], 31) : 30;
  const months = f[3] !== "*" ? count(f[3], 12) / 12 : 1;
  return Math.round(perDay * days * months);
}
function cliOptions(s) {
  const opt = (re) => re.exec(s)?.[1] ?? null;
  const turns = opt(/--max-turns[= ]+["']?(\d+)/);
  const budget = opt(/--max-budget-usd[= ]+["']?([\d.]+)/);
  return {
    model: opt(/(?:--model|(?:^|\s)-m)[= ]+["']?([\w.:\/-]+)/),
    maxTurns: turns ? Number(turns) : null,
    budgetUsd: budget ? Number(budget) : null,
    effort: opt(/model_reasoning_effort[= ]*["']?=?["']?(\w+)/) ?? opt(/--effort[= ]+["']?(\w+)/)
  };
}
var CLAUDE_CLI = /(^|[\s;&|(`$])(?:npx\s+(?:-y\s+)?@anthropic-ai\/claude-code|claude)\s+(?:[^\n|;&]*\s)?(?:-p|--print)\b/m;
var CODEX_CLI = /(^|[\s;&|(`$])(?:npx\s+(?:-y\s+)?@openai\/codex|codex)\s+exec\b/m;
function auditCi(projectDir, opts = {}) {
  const dir = resolve6(projectDir);
  const wfDir = join10(dir, ".github", "workflows");
  const steps = [];
  const unreadable = [];
  const files = existsSync9(wfDir) ? readdirSync3(wfDir).filter((f) => /\.ya?ml$/i.test(f)).sort() : [];
  for (const file2 of files) {
    let doc;
    try {
      doc = asMap(parseYaml(readFileSync8(join10(wfDir, file2), "utf8")));
    } catch (e) {
      unreadable.push({ file: file2, error: String(e.message ?? e) });
      continue;
    }
    const { triggers, events } = triggersOf(doc.on ?? doc.true ?? null);
    const wfConcurrency = doc.concurrency;
    const sched = asList(events.schedule?.cron).map((c) => cronPerMonth(asStr(c))).filter((n) => n !== null);
    for (const [jobId, jobY] of Object.entries(asMap(doc.jobs))) {
      const job = asMap(jobY);
      const jobIf = asStr(job.if);
      const concurrency = job.concurrency ?? wfConcurrency;
      asList(job.steps).forEach((stepY, i) => {
        const step = asMap(stepY);
        const uses = asStr(step.uses);
        const run = asStr(step.run);
        const w = asMap(step.with);
        const name = asStr(step.name) || asStr(step.id) || uses.split("@")[0] || `step ${i + 1}`;
        let found = null;
        if (/^anthropics\/claude-code(-base)?-action@/i.test(uses)) {
          const o = cliOptions(asStr(w.claude_args));
          const prompt = asStr(w.prompt) || asStr(w.direct_prompt) || asStr(w.override_prompt);
          found = {
            agent: "claude",
            via: "action",
            mode: /base-action/i.test(uses) || prompt ? "automation" : "tag",
            model: o.model ?? (asStr(w.model) || asStr(w.anthropic_model) || null),
            maxTurns: o.maxTurns ?? (Number(asStr(w.max_turns)) || null),
            budgetUsd: o.budgetUsd,
            effort: null,
            plugins: asStr(w.plugins).split(/[\s,]+/).filter(Boolean)
          };
        } else if (/^openai\/codex-action@/i.test(uses)) {
          const o = cliOptions(asStr(w["codex-args"]));
          found = { agent: "codex", via: "action", mode: "automation", model: asStr(w.model) || o.model, maxTurns: null, budgetUsd: null, effort: asStr(w.effort) || o.effort, plugins: [] };
        } else if (CLAUDE_CLI.test(run)) {
          const o = cliOptions(run);
          found = { agent: "claude", via: "cli", mode: "automation", model: o.model, maxTurns: o.maxTurns, budgetUsd: o.budgetUsd, effort: null, plugins: [] };
        } else if (CODEX_CLI.test(run)) {
          const o = cliOptions(run);
          found = { agent: "codex", via: "cli", mode: "automation", model: o.model, maxTurns: null, budgetUsd: null, effort: o.effort, plugins: [] };
        }
        if (!found) return;
        const conditions = [jobIf, asStr(step.if)].join(" ");
        const s = { workflow: file2, job: jobId, step: name, ...found, triggers, scheduledPerMonth: sched.length ? sched.reduce((a, b) => a + b, 0) : null, flags: [] };
        flagStep(s, events, conditions, concurrency, Number(asStr(job["timeout-minutes"])) || null);
        if (/\.lock\.ya?ml$/i.test(file2)) for (const f of s.flags) f.fix += ` (in ${file2.replace(/\.lock\.ya?ml$/i, ".md")}, then recompile)`;
        steps.push(s);
      });
    }
  }
  let loadedPerRun = { claude: 0, codex: 0 };
  if (steps.length) {
    const t = totals(auditContext(dir, { home: opts.home ?? join10(dir, ".snout", "no-home"), noUsage: true, noGit: true }));
    loadedPerRun = { claude: (t.always.byAgent.claude ?? 0) + t.described.perSession, codex: t.always.byAgent.codex ?? 0 };
  }
  return { projectDir: dir, workflows: files.length, steps, loadedPerRun, unreadable };
}
function flagStep(s, events, conditions, concurrency, timeoutMin) {
  const flag = (code, reason, fix) => s.flags.push({ code, reason, fix });
  const runsOnEverything = s.mode === "automation";
  const prEvents = Object.keys(events).filter((e) => PR_EVENTS.has(e));
  if (runsOnEverything && prEvents.length) {
    const types = prEvents.flatMap((e) => events[e].types ? asList(events[e].types).map(asStr) : PR_DEFAULT_TYPES);
    if (types.includes("synchronize"))
      flag("every-push", "runs again on every push to an open PR, so a PR pushed 6 times pays for 6 runs", "on: pull_request: types: [opened, ready_for_review]  (or trigger on a label or an @mention)");
    if (!/draft/.test(conditions) && !types.every((t) => t === "ready_for_review"))
      flag("drafts", "also runs on draft PRs, which usually change again before review", "if: github.event.pull_request.draft == false");
    if (!/github\.actor|user\.(login|type)|\bbots?\b|\[bot\]|dependabot|renovate/i.test(conditions))
      flag("bot-prs", "also runs on PRs opened by bots (Dependabot, Renovate), which rarely need an AI review", `if: "!endsWith(github.actor, '[bot]')"`);
    const conc = asMap(concurrency);
    if (!concurrency || !/true/.test(asStr(conc["cancel-in-progress"]) || ""))
      flag("no-concurrency", "a new push doesn't cancel the run still going for the previous one; both are billed", "concurrency: { group: ${{ github.workflow }}-${{ github.event.pull_request.number }}, cancel-in-progress: true }");
  }
  const commentEvents = Object.keys(events).filter((e) => COMMENT_EVENTS.has(e));
  if (runsOnEverything && commentEvents.length && !/comment\.body|review\.body|contains\(/.test(conditions))
    flag("every-comment", `runs on every ${commentEvents.join(" / ")}, not only the ones that ask for it`, "if: contains(github.event.comment.body, '@claude')");
  if (s.agent === "claude" && s.maxTurns === null && s.budgetUsd === null)
    flag("no-limit", `no turn or budget limit: one confused run can loop until the job times out (${timeoutMin ? `${timeoutMin} min here` : "6 hours by default"})`, s.via === "action" ? "claude_args: --max-turns 15" : "add --max-turns 15 (or --max-budget-usd 2)");
  if (s.scheduledPerMonth !== null && s.scheduledPerMonth > 31)
    flag("frequent-schedule", `scheduled about ${s.scheduledPerMonth} times a month`, "run it daily or weekly unless each run finds new work");
  if (s.model && /opus/i.test(s.model))
    flag("top-model", `uses ${s.model}, the most expensive tier; reviews and triage usually run as well on a Sonnet model`, "try --model with a Sonnet model on a few PRs and compare");
}
function renderCi(a) {
  if (!a.steps.length) return `No AI agents run in this repository's GitHub Actions (${a.workflows} workflow${a.workflows === 1 ? "" : "s"} checked).${a.unreadable.length ? `
Could not read: ${a.unreadable.map((u) => u.file).join(", ")}` : ""}`;
  const lines = [`AI agents in GitHub Actions for ${a.projectDir} \xB7 ${a.steps.length} step${a.steps.length === 1 ? "" : "s"} in ${new Set(a.steps.map((s) => s.workflow)).size} workflow${a.steps.length === 1 ? "" : "s"}`, ""];
  const agentName = { claude: "Claude Code", codex: "Codex" };
  for (const s of a.steps) {
    const limits = [s.maxTurns !== null ? `max ${s.maxTurns} turns` : "", s.budgetUsd !== null ? `$${s.budgetUsd} cap` : "", s.effort ? `effort ${s.effort}` : ""].filter(Boolean).join(", ");
    lines.push(`  ${s.workflow} \u203A ${s.job} \u203A ${s.step}`);
    lines.push(`    ${agentName[s.agent]} ${s.via === "action" ? "action" : "CLI"}${s.agent === "claude" && s.via === "action" ? ` (${s.mode} mode)` : ""} \xB7 model ${s.model ?? "default"}${limits ? ` \xB7 ${limits}` : ""}${s.plugins.length ? ` \xB7 plugins: ${s.plugins.join(", ")}` : ""}`);
    lines.push(`    runs on: ${s.triggers.map((t) => t.detail ? `${t.event} (${t.detail})` : t.event).join(", ")}`);
    for (const f of s.flags) lines.push(`    \u2717 ${f.reason}`, `      fix: ${f.fix}`);
    if (!s.flags.length) lines.push("    \u2713 nothing to change");
    lines.push("");
  }
  const per = [a.loadedPerRun.claude && a.steps.some((s) => s.agent === "claude") ? `Claude Code ~${Math.round(a.loadedPerRun.claude).toLocaleString("en-US")}` : "", a.loadedPerRun.codex && a.steps.some((s) => s.agent === "codex") ? `Codex ~${Math.round(a.loadedPerRun.codex).toLocaleString("en-US")}` : ""].filter(Boolean);
  if (per.length) lines.push(`Every run starts by loading the repository's instructions: ${per.join(", ")} tokens. \`snout audit context\` shows what to trim; each token saved there is saved on every CI run too.`);
  if (a.unreadable.length) lines.push(`Could not read: ${a.unreadable.map((u) => u.file).join(", ")}`);
  return lines.join("\n").trimEnd();
}

// src/compact/codex.ts
import { isAbsolute as isAbsolute7, resolve as resolve7 } from "node:path";
var SHELL_TOOLS = /* @__PURE__ */ new Set(["shell_command", "shell", "exec_command", "local_shell", "container.exec"]);
var SHELLS = /^(?:.*[\\/])?(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?$/i;
var STR = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60)`;
function codexRows(lines) {
  const rows = [];
  const push = (...entries) => {
    for (const e of entries) rows.push(JSON.stringify(e));
  };
  const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id, content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  let cwd;
  let synthetic = 0;
  const abs = (f) => cwd && !isAbsolute7(f) ? resolve7(cwd, f) : f;
  const edits = (patch) => patchFiles(patch).map((f) => use(`codex-edit-${synthetic++}`, "Edit", { file_path: abs(f) }));
  for (const line of lines) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const p = row?.payload;
    if (!p || typeof p !== "object") continue;
    if (row.type === "session_meta" || row.type === "turn_context") {
      if (typeof p.cwd === "string") cwd = p.cwd;
      continue;
    }
    if (row.type === "event_msg") {
      const item = p.item;
      if (p.type === "item_completed" && item?.type === "CommandExecution") {
        const cmd = commandText(item.command);
        const output = item.aggregated_output ?? item.formatted_output ?? [item.stdout, item.stderr].filter(Boolean).join("\n");
        if (cmd && typeof output === "string") {
          const id2 = `codex-command-${synthetic++}`;
          push(use(id2, "Bash", { command: cmd }), result(id2, output));
        }
      }
      continue;
    }
    if (row.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
      if (Array.isArray(kinds) && !kinds.includes("user.text")) continue;
      let text = Array.isArray(p.content) ? p.content.filter((c) => c?.type === "input_text").map((c) => c.text ?? "").join(" ") : "";
      const typed = /^\s*# Files mentioned by the user:[\s\S]*?\n## My request(?: for Codex)?:\s*\n([\s\S]*)$/.exec(text);
      if (typed) text = typed[1];
      if (text.trim() && !/^\s*(?:# AGENTS\.md instructions for |<[a-z_-]+[\s>])/.test(text)) push({ type: "user", message: { content: text } });
      continue;
    }
    if (p.type === "message" && p.role === "assistant") {
      const text = Array.isArray(p.content) ? p.content.filter((c) => c?.type === "output_text").map((c) => c.text ?? "").join(" ") : "";
      if (text.trim()) push({ type: "assistant", message: { content: [{ type: "text", text }] } });
      continue;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      push(result(p.call_id, outputText(p.output)));
      continue;
    }
    const id = String(p.call_id ?? p.id ?? `codex-call-${synthetic++}`);
    const name = String(p.name ?? "");
    if (p.type === "local_shell_call") {
      const command = commandText(p.action?.command);
      if (command) push(use(id, "Bash", { command }));
      continue;
    }
    if (p.type === "custom_tool_call") {
      const input = String(p.input ?? "");
      if (name === "apply_patch") push(...edits(input));
      if (name !== "exec") continue;
      if (/\bapply_patch\b/.test(input)) push(...edits(unescapeJs(input)));
      const plan = codeModePlan(input);
      if (plan) push(use(`codex-plan-${synthetic++}`, "TodoWrite", { todos: plan }));
      const command = codeModeCommands(input);
      if (command) push(use(id, "Bash", { command }));
      continue;
    }
    if (p.type !== "function_call") continue;
    let args = {};
    try {
      args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments ?? {};
    } catch {
    }
    if (name === "apply_patch") {
      const patch = typeof args === "string" ? args : args?.input ?? args?.patch;
      if (typeof patch === "string") push(...edits(patch));
    } else if (name === "update_plan" && Array.isArray(args?.plan)) {
      push(use(`codex-plan-${synthetic++}`, "TodoWrite", { todos: args.plan.map((s) => ({ content: String(s?.step ?? ""), status: s?.status })) }));
    } else if (SHELL_TOOLS.has(name)) {
      const command = commandText(args?.command ?? args?.cmd);
      if (command) push(use(id, "Bash", { command }));
    }
  }
  return rows;
}
function commandText(c) {
  if (typeof c === "string") return c || void 0;
  if (!Array.isArray(c) || !c.every((x) => typeof x === "string")) return void 0;
  if (c.length >= 3 && SHELLS.test(c[0]) && /^-(?:l?c|Command)$/i.test(c[c.length - 2])) return c[c.length - 1];
  return c.join(" ") || void 0;
}
function codeModeCommands(code) {
  if (!/\btools\.(exec_command|shell_command)\(/.test(code)) return void 0;
  const cmds = [];
  for (const m of code.matchAll(new RegExp(String.raw`["']?\b(?:cmd|command)["']?\s*:\s*${STR}`, "g"))) {
    const c = unescapeJs(m[1].slice(1, -1)).trim();
    if (c) cmds.push(c);
  }
  return cmds.length ? cmds.join("\n") : void 0;
}
function codeModePlan(code) {
  if (!/\btools\.update_plan\(/.test(code)) return void 0;
  const steps = [...code.matchAll(new RegExp(String.raw`["']?\bstep["']?\s*:\s*${STR}\s*,\s*["']?status["']?\s*:\s*${STR}`, "g"))];
  return steps.length ? steps.map((m) => ({ content: unescapeJs(m[1].slice(1, -1)), status: unescapeJs(m[2].slice(1, -1)) })) : void 0;
}
function unescapeJs(s) {
  return s.replace(/\\(.)/g, (_, c) => c === "n" ? "\n" : c === "t" ? "	" : c);
}
function patchFiles(patch) {
  const files = [];
  for (const m of patch.matchAll(/^\s*\*\*\* (?:(?:Add|Update) File|Move to): ([^\n"'`]+?)\s*$/gm)) if (!files.includes(m[1])) files.push(m[1]);
  return files;
}
function outputText(out) {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return parts(out);
  if (out && typeof out === "object") {
    const o = out;
    return typeof o.output === "string" ? o.output : typeof o.content === "string" ? o.content : Array.isArray(o.content) ? parts(o.content) : "";
  }
  return "";
}
function parts(content) {
  return content.map((x) => typeof x === "string" ? x : typeof x?.text === "string" ? x.text : "").join("");
}

// src/compact/memory.ts
import { closeSync as closeSync3, existsSync as existsSync10, openSync as openSync3, readFileSync as readFileSync9, readSync as readSync3, statSync as statSync10 } from "node:fs";
import { isAbsolute as isAbsolute8, join as join11, relative as relative4, resolve as resolve8, sep as sep3 } from "node:path";
var TAIL_BYTES = 16 * 1024 * 1024;
var HEAD_BYTES = 2 * 1024 * 1024;
var MAX_CHARS = 6e3;
var TEST = /\b(pytest|runtests\.py|bin\/test|jest|vitest|mocha|go test|cargo test|(?:npm|pnpm|yarn)(?:\.cmd)? (?:run )?test|node --test|rspec|phpunit|tox|unittest)\b/;
var RAN = /\b\d+ (passed|failed|errors?|skipped)\b|\bRan \d+ tests?\b|tests finished|^OK\b|\bOK \(|^FAILED\b|\bTests?:\s+\d+|^[#ℹ]?\s*pass\s+\d+\s*$/m;
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
      const abs = isAbsolute8(cd) ? cd : resolve8(projectDir, cd);
      const r = relative4(projectDir, abs).split(sep3).join("/");
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
  const buf = Buffer.alloc(Math.min(HEAD_BYTES, statSync10(file2).size));
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
  const size = statSync10(file2).size;
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
  return existsSync10(join11(projectDir, name)) || existsSync10(join11(projectDir, `${name}.py`));
}
function requestText(text) {
  const t = text.trim();
  if (!t || /^<(command-|local-command|system-reminder|task-notification)/.test(t)) return void 0;
  const own = t.replace(/<\\?pasted_content\b[^>]*>[\s\S]*?(<\\?\/pasted_content>|$)/g, " ").replace(/\[Image #\d+\]/g, " ").replace(/\s+/g, " ").trim();
  const letters = own.replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, "").length;
  return own.length >= 3 && letters / own.replace(/\s+/g, "").length >= 0.6 && !/(.)\1{5,}/.test(own) ? own : void 0;
}
var INSTRUCTION = /^(?:(?:please|also|and|but|so|ok(?:ay)?|now|then|again|remember|note)[,:]?\s+)*(always|never|don'?t|do not|must|only|make sure|ensure|avoid|keep|no new|ask (?:me )?(?:first|before)|use|run|stop|leave|strip|remove|commit|push)\b/i;
var MAX_RULES = 12;
var ERROR_LINE = /^(?:[\w.]+(?:Error|Exception)\b(?::.*)?|(?:FAILED|ERROR) [\w./:\[\]-]+.*|(?:FAIL|ERROR): \w+ \(.*|error\[\w+\]: .+|[^\s:]+:\d+(?::\d+)?: error: .+|(?:\S+:\s+)?error TS\d+: .+)$/;
var PASSED = (verdict) => RAN.test(verdict) && !/\b[1-9]\d* (failed|errors?)\b|FAILED|\b(failures|errors)=\d|\bfail [1-9]/i.test(verdict);
function errorLine(out) {
  const lines = out.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i])) return lines[i];
  return void 0;
}
var RULE_CHARS = 1600;
var OUTCOME_CHARS = 600;
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
  const first = statSync10(transcriptPath).size > TAIL_BYTES ? firstRequest(transcriptPath) : void 0;
  return factsFromClaudeRows(tail(transcriptPath).split("\n"), projectDir, first);
}
function factsFromClaudeRows(lines, projectDir, first) {
  const rel = (p) => {
    if (!isAbsolute8(p)) return p;
    const r = relative4(projectDir, p);
    return r && !r.startsWith("..") && !isAbsolute8(r) ? r.split(sep3).join("/") : p;
  };
  const facts = { rules: [], missing: [], slow: [], changed: [], todos: [] };
  const uses = /* @__PURE__ */ new Map();
  if (first) facts.goal = oneLine(first, 600);
  for (const line of lines) {
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
    if (o.type === "assistant") {
      const said = content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ").trim();
      if (said.length >= 20) facts.outcome = oneLine(said, OUTCOME_CHARS);
    }
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
        const lines2 = out.split("\n").map((l) => l.trim()).filter(Boolean);
        verdict = [...lines2].reverse().find((l) => RAN.test(l)) ?? "";
        const failed = out.match(/^\s*[#ℹ]?\s*fail\s+[1-9]\d*\s*$/m);
        if (failed && verdict && !verdict.includes(failed[0].trim())) verdict = `${verdict} \xB7 ${failed[0].trim()}`;
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
  const projectFirst = (list) => [...list.filter((p) => !isAbsolute8(p)), ...list.filter((p) => isAbsolute8(p))];
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
function codexSessionFacts(transcriptPath, projectDir) {
  return factsFromClaudeRows(codexRows(tail(transcriptPath).split(/\n/)), projectDir);
}
function readPins(projectDir, snoutDir) {
  const file2 = join11(snoutDir, "pins.md");
  if (!existsSync10(file2)) return [];
  const pins = [];
  for (const raw of readFileSync9(file2, "utf8").split("\n")) {
    const m = raw.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!m) continue;
    const text = m[1];
    const reread = Number(text.match(/\[re-?read (\d+)\]/i)?.[1] ?? 0) || void 0;
    const first = text.match(/^`([^`]+)`|^(\S+)/);
    const candidate = first?.[1] ?? first?.[2] ?? "";
    const looksLikePath = !/^https?:/.test(candidate) && (first?.[1] !== void 0 || /[/\\]|^\.\w|\.\w{1,10}$/.test(candidate));
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
    const abs = isAbsolute8(p.path) ? p.path : resolve8(projectDir, p.path);
    if (!existsSync10(abs)) {
      out.push(`  (not on disk now: ${p.path})`);
      continue;
    }
    const rel = relative4(projectDir, abs);
    const asPattern = rel && !rel.startsWith("..") ? rel : abs.replace(/^\/+/, "");
    if (secrets && matchesAny(asPattern, secrets.redact) && !matchesAny(asPattern, secrets.redactExempt)) {
      out.push("  (contents not restored: the file matches a credential pattern)");
      continue;
    }
    try {
      const lines = readFileSync9(abs, "utf8").split("\n").slice(0, p.reread);
      out.push("  ```", ...lines.map((l) => `  ${l.slice(0, 200)}`), "  ```");
    } catch {
      out.push(`  (could not read ${p.path})`);
    }
  }
  return out;
}
var PROGRESS_FILE = "progress.md";
var PROGRESS_MAX_CHARS = 1500;
var progressAsk = (file2) => `- Keep \`${file2}\` current while you work, at most 10 lines: the goal, your current approach, what failed and why, the next step. Snout restores it verbatim after the next compaction.`;
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
    return Number.isFinite(t) ? t : statSync10(transcriptPath).birthtimeMs || 0;
  } catch {
    return 0;
  }
}
function readProgress(snoutDir, sinceMs) {
  const file2 = join11(snoutDir, PROGRESS_FILE);
  try {
    if (statSync10(file2).mtimeMs < sinceMs) return void 0;
    const text = readFileSync9(file2, "utf8").trim();
    return text ? text.length > PROGRESS_MAX_CHARS ? `${text.slice(0, PROGRESS_MAX_CHARS - 1)}\u2026` : text : void 0;
  } catch {
    return void 0;
  }
}
function memoryText(facts, pins, projectDir, secrets, progress, progressFile = ".snout/progress.md") {
  const ask = progressAsk(progressFile);
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
  const room = MAX_CHARS - head.length - ask.length - 2;
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
  return [head, body, ask].join("\n");
}

// src/agents/adapt.ts
function fromInternal(agent, event, out) {
  if (agent === "codex") {
    const result = codexOut(event, out);
    return result ? JSON.stringify(result) : "";
  }
  if (agent === "gemini") return JSON.stringify(geminiOut(out));
  return JSON.stringify(cursorOut(event, out));
}
function codexOut(event, out) {
  if (!out) return null;
  const hook = hso(out);
  if (event === "PreToolUse") {
    const result = {};
    if (str(out.systemMessage)) result.systemMessage = out.systemMessage;
    if (!hook) return Object.keys(result).length ? result : null;
    const decision2 = str(hook.permissionDecision);
    const reason = str(hook.permissionDecisionReason);
    const specific = { hookEventName: "PreToolUse" };
    if (decision2 === "ask") {
      specific.permissionDecision = "deny";
      specific.permissionDecisionReason = reason ? `${reason} Codex cannot request approval from PreToolUse; use a bounded read or targeted search, or ask the user to add this file to Snout's allow-list if a full read is necessary.` : "Codex cannot request approval from PreToolUse; use a bounded read or targeted search, or ask the user to add this file to Snout's allow-list if a full read is necessary.";
    } else if (decision2 === "deny") {
      specific.permissionDecision = "deny";
      if (reason) specific.permissionDecisionReason = reason;
    } else if (decision2 === "allow") {
      const updated = hook.updatedInput;
      if (updated && typeof updated === "object" && !Array.isArray(updated)) {
        specific.permissionDecision = "allow";
        specific.updatedInput = updated;
      }
    }
    if (str(hook.additionalContext)) specific.additionalContext = hook.additionalContext;
    if (Object.keys(specific).length > 1) result.hookSpecificOutput = specific;
    return Object.keys(result).length ? result : null;
  }
  if (event === "PostToolUse") {
    const result = {};
    if (str(out.systemMessage)) result.systemMessage = out.systemMessage;
    if (str(hook?.additionalContext)) result.hookSpecificOutput = { hookEventName: "PostToolUse", additionalContext: hook.additionalContext };
    return Object.keys(result).length ? result : null;
  }
  return out;
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

// src/map/map.ts
import { spawnSync } from "node:child_process";
import { readdirSync as readdirSync4, readFileSync as readFileSync10, statSync as statSync11 } from "node:fs";
import { basename as basename3, extname as extname2, join as join12, relative as relative5, sep as sep4 } from "node:path";
var TEXT_EXT = /\.(m?js|cjs|jsx|ts|tsx|mts|cts|py|pyi|go|rs|java|kt|kts|cs|rb|php|swift|scala|c|cc|cpp|h|hpp|m|mm|ex|exs|erl|clj|lua|sh|bash|zsh|sql|graphql|proto|vue|svelte|astro|md|mdx|rst|txt|toml|ya?ml|json|ini|cfg|conf|env\.example|html|css|scss)$/i;
var SKIP_DIR = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", "third_party", "coverage", ".next", ".venv", "venv", "__pycache__", ".snout", ".claude", ".tox", ".mypy_cache", ".pytest_cache"]);
var MAX_FILE_BYTES = 512 * 1024;
var MAX_FILES = 2e4;
var MAX_WORDS = 3e3;
var WORD = /[A-Za-z_][A-Za-z0-9_]{3,63}/g;
var TESTS = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*$|_tests?\.[a-z]+$|\.(test|spec)\.[a-z]+$/i;
var URL = /\b(?:https?:\/\/|www\.)\S+/g;
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
  const git2 = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (git2.status === 0 && git2.stdout.trim()) {
    return git2.stdout.split("\n").filter((f) => f && TEXT_EXT.test(f) && !f.split("/").some((p) => SKIP_DIR.has(p))).slice(0, MAX_FILES);
  }
  const out = [];
  const walk2 = (dir) => {
    let entries;
    try {
      entries = readdirSync4(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk2(join12(dir, e.name));
      } else if (e.isFile() && TEXT_EXT.test(e.name)) out.push(relative5(projectDir, join12(dir, e.name)).split(sep4).join("/"));
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
  let read2 = 0, reused = 0;
  for (const rel of listFiles(projectDir)) {
    if (skip?.(rel)) continue;
    let st;
    try {
      st = statSync11(join12(projectDir, rel));
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
    read2++;
  }
  return { map: { version: 1, builtAt: (/* @__PURE__ */ new Date()).toISOString(), files }, read: read2, reused };
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
  const prompt = request.replace(URL, " ");
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
  const asked = requestNames(prompt.replace(URL, " "));
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
  const lower = prompt.replace(URL, " ").toLowerCase();
  for (const p of paths) {
    const stem = basename3(p, extname2(p)).toLowerCase();
    if (stem.length < 5) continue;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w.])${esc}\\.[a-z]{1,5}\\b|/${esc}\\b|\\b${esc} (module|file|package)\\b`).test(lower)) add(p, Math.log(1 + N), stem, true);
  }
  for (const [p, w] of locations(paths, prompt)) add(p, Math.log(1 + N) * w, basename3(p), true);
  return [...scored.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k);
}
function locations(paths, prompt) {
  const bySuffix = /* @__PURE__ */ new Map();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 0; i + 1 < segs.length; i++) {
      const s = segs.slice(i).join("/");
      bySuffix.set(s, bySuffix.has(s) && bySuffix.get(s) !== p ? null : p);
    }
  }
  const resolve9 = (raw) => {
    const segs = raw.split(/[\\/]+/).filter(Boolean);
    for (let i = 0; i + 1 < segs.length; i++) {
      const hit = bySuffix.get(segs.slice(i).join("/"));
      if (hit) return hit;
      if (hit === null) return null;
    }
    return null;
  };
  const out = /* @__PURE__ */ new Map();
  const put = (p, w) => out.set(p, Math.max(out.get(p) ?? 0, w));
  const frames = [...prompt.matchAll(/File "([^"\n]+)", line \d+/g)].map((m) => resolve9(m[1])).filter((p) => !!p);
  const seen = [];
  for (const p of frames.reverse()) if (!seen.includes(p)) seen.push(p);
  seen.forEach((p, i) => put(p, 1 / (i + 1)));
  const files = new Set(paths);
  for (const m of prompt.replace(URL, " ").matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,8}\b/g)) {
    const parts2 = m[0].split(".");
    for (let n = parts2.length; n >= 2; n--) {
      const base = parts2.slice(0, n).join("/");
      if (files.has(`${base}.py`)) {
        put(`${base}.py`, 1);
        break;
      }
    }
  }
  return out;
}
function renderCandidates(cs) {
  if (!cs.length) return "";
  const why = (c) => [c.defines.length ? `defines ${c.defines.slice(0, 3).join(", ")}` : "", c.uses.length ? `uses ${c.uses.slice(0, 3).join(", ")}` : ""].filter(Boolean).join("; ");
  return `snout map: files in this repo that define or use names in this request, most relevant first (candidates from a local index, not a plan): ${cs.map((c) => `${c.path} (${why(c)})`).join(" \xB7 ")}`;
}

// src/replay/replay.ts
import { existsSync as existsSync11, mkdirSync as mkdirSync6, mkdtempSync, readFileSync as readFileSync11, rmSync, writeFileSync as writeFileSync4 } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirname6, isAbsolute as isAbsolute9, join as join13, relative as relative6, sep as sep5 } from "node:path";
var tokens = (text) => estimateTokens(Buffer.byteLength(text), "output.txt");
var textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => typeof p?.text === "string" ? p.text : "").join("\n") : "";
var EDITS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var withoutCd = (c) => c.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "");
function readLines(file2) {
  const out = [];
  for (const raw of readFileSync11(file2, "utf8").split("\n")) {
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
  const root = mkdtempSync(join13(tmpdir(), "snout-replay-project-"));
  const best = /* @__PURE__ */ new Map();
  for (const { o } of lines) {
    const f = o.toolUseResult?.file;
    if (!f || typeof f.filePath !== "string" || typeof f.content !== "string") continue;
    const r = relative6(projectDir, f.filePath);
    if (!r || r.startsWith("..") || isAbsolute9(r)) continue;
    const prev = best.get(r);
    if (!prev || f.content.length > prev.content.length) best.set(r, { content: f.content, start: Number(f.startLine) || 1, total: Number(f.totalLines) || 0 });
  }
  for (const [r, f] of best) {
    const known = f.content.split("\n");
    const avg = Math.max(1, Math.round(f.content.length / Math.max(1, known.length)));
    const filler = "x".repeat(avg);
    const total = Math.max(f.total, f.start - 1 + known.length);
    const out = Array.from({ length: total }, (_, i) => i >= f.start - 1 && i < f.start - 1 + known.length ? known[i - f.start + 1] : filler);
    const dest = join13(root, r);
    mkdirSync6(dirname6(dest), { recursive: true });
    writeFileSync4(dest, out.join("\n"));
  }
  return { root, files: best.size };
}
function replaySession(file2, run) {
  const lines = readLines(file2).filter(({ o }) => !o.isSidechain);
  const projectDir = projectOf(lines);
  const shadow = existsSync11(projectDir) ? null : shadowProject(lines, projectDir);
  const onDisk = (v) => {
    if (!shadow) return v;
    if (typeof v === "string") return v.split(projectDir).join(shadow.root);
    if (Array.isArray(v)) return v.map(onDisk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, onDisk(x)]));
    return v;
  };
  const session = String(lines.find(({ o }) => o.sessionId)?.o.sessionId ?? file2);
  const rel = (p) => {
    if (!isAbsolute9(p)) return p;
    const r2 = relative6(projectDir, p);
    return r2 && !r2.startsWith("..") && !isAbsolute9(r2) ? r2.split(sep5).join("/") : p;
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
    const dir = mkdtempSync(join13(tmpdir(), "snout-replay-mem-"));
    try {
      for (const at of boundaries) {
        const prefix = join13(dir, "prefix.jsonl");
        writeFileSync4(prefix, lines.slice(0, at).map((l) => l.raw).join("\n") + "\n");
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
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (shadow) rmSync(shadow.root, { recursive: true, force: true });
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
function compactionWhatIf(file2, cap, costs) {
  const reqs = requestsOf(readLines(file2).filter(({ o }) => !o.isSidechain));
  const prefix = reqs.length ? reqs[0].written + reqs[0].cached : 0;
  let base = 0, sim = 0, ctx = 0, prev = 0, compactions = 0, peak = 0, rewrite = false;
  for (const q of reqs) {
    const size = q.written + q.cached;
    base += q.written * W + q.cached * R + q.output * O;
    if (prev && size < prev * 0.67) ctx = size;
    else ctx += size - prev;
    prev = size;
    if (ctx > cap) {
      compactions++;
      const summary = costs.summary * cap, reread = costs.reread * cap;
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
  return { cap, baseCost: base, capCost: sim, change: base ? sim / base - 1 : 0, compactions, peak };
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

// src/memory/memory.ts
import { existsSync as existsSync12, mkdirSync as mkdirSync7, readdirSync as readdirSync5, readFileSync as readFileSync12, unlinkSync as unlinkSync2 } from "node:fs";
import { isAbsolute as isAbsolute10, join as join14, relative as relative7, sep as sep6 } from "node:path";
import { spawnSync as spawnSync2 } from "node:child_process";
var MEMORY_DIR = "memory";
var MAX_AGE_DAYS = 90;
var MAX_CARDS = 3;
var MAX_BRIEF_CHARS = 2400;
var dirOf = (snoutDir) => join14(snoutDir, MEMORY_DIR);
var fileOf = (snoutDir, session) => join14(dirOf(snoutDir), `${session.replace(/[^\w.-]/g, "_").slice(0, 80)}.json`);
function readCard(snoutDir, session) {
  try {
    return JSON.parse(readFileSync12(fileOf(snoutDir, session), "utf8"));
  } catch {
    return null;
  }
}
function readCards(snoutDir) {
  let names;
  try {
    names = readdirSync5(dirOf(snoutDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const cards = [];
  for (const n of names) {
    try {
      const c = JSON.parse(readFileSync12(join14(dirOf(snoutDir), n), "utf8"));
      if (c?.v === 1 && typeof c.session === "string") cards.push(c);
    } catch {
    }
  }
  return cards;
}
function writeCard(snoutDir, card) {
  mkdirSync7(dirOf(snoutDir), { recursive: true });
  writeAtomic(fileOf(snoutDir, card.session), `${JSON.stringify(card, null, 1)}
`);
}
function git(projectDir, args) {
  try {
    const r = spawnSync2("git", args, { cwd: projectDir, encoding: "utf8", timeout: 2e3, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : void 0;
  } catch {
    return void 0;
  }
}
var emptyCard = (session, agent, now) => ({ v: 1, id: session, session, agent, started: now, updated: now, changed: [], rules: [], commits: [] });
function captureSession(snoutDir, projectDir, session, agent, facts, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const prev = readCard(snoutDir, session);
  if (!facts.goal && !facts.changed.length && !prev?.commits.length) return null;
  const card = {
    ...prev ?? emptyCard(session, agent, now),
    updated: now,
    branch: git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? prev?.branch,
    author: prev?.author ?? git(projectDir, ["config", "user.name"]),
    task: facts.goal ?? prev?.task,
    request: facts.request !== facts.goal ? facts.request : void 0,
    changed: facts.changed.filter((p) => !/^[A-Za-z]:|^\//.test(p)).slice(0, 20),
    test: facts.test,
    error: facts.error,
    rules: facts.rules,
    outcome: facts.outcome ?? prev?.outcome,
    missing: facts.missing.map((m) => m.name),
    slow: facts.slow
  };
  writeCard(snoutDir, card);
  return card;
}
var COMMITS = /\bgit\b[^|;&]*\b(commit|merge|cherry-pick|revert|am)\b/;
function linkCommit(snoutDir, projectDir, session, agent, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const head = git(projectDir, ["log", "-1", "--format=%H%x1f%s%x1f%cI", "--name-only"]);
  if (!head) return null;
  const [first, ...rest] = head.split("\n");
  const [sha, subject, ts] = first.split("");
  if (!sha || !ts) return null;
  const card = readCard(snoutDir, session) ?? emptyCard(session, agent, now);
  if (card.commits.some((c) => c.sha === sha)) return null;
  if (Date.parse(ts) < Date.parse(card.started) - 6e4) return null;
  const commit = { sha, subject: subject ?? "", ts, files: rest.map((l) => l.trim()).filter(Boolean).slice(0, 30) };
  card.commits.push(commit);
  card.updated = now;
  writeCard(snoutDir, card);
  return commit;
}
var STOP3 = new Set("the and for are but not you all any can had her was one our out has his how its may new now old see two way who did get let put say she too use this that with from have what when where which will your into than then them they there these those were been being does done just also only some such more most very about after again could should would here make made want need like look fix add bug issue error file files code please thanks okay yes run test tests work works working change changes update".split(" "));
function terms(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}/g)) {
    const w = m[0];
    const parts2 = w.split(/_|(?<=[a-z0-9])(?=[A-Z])/).filter((p) => p.length >= 3);
    for (const t of new Set([w, ...parts2].map((x) => x.toLowerCase()))) if (!STOP3.has(t)) out.push(t);
  }
  return out;
}
function cardText(c) {
  return [c.task, c.request, c.outcome, ...c.changed, ...c.commits.flatMap((k) => [k.subject, ...k.files]), c.error?.line, c.branch].filter(Boolean).join(" ");
}
var cardFiles = (c) => [.../* @__PURE__ */ new Set([...c.changed, ...c.commits.flatMap((k) => k.files)])];
function liveCards(cards, opts) {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ? Date.parse(opts.asOf) : void 0;
  return cards.filter((c) => {
    if (c.session === opts.session) return false;
    if (asOf !== void 0) return Date.parse(c.started) < asOf;
    return now - Date.parse(c.updated) <= MAX_AGE_DAYS * 864e5;
  }).map((c) => asOf === void 0 ? c : { ...c, commits: c.commits.filter((k) => Date.parse(k.ts) < asOf) });
}
function recall(cards, prompt, opts = {}) {
  const live = liveCards(cards, opts);
  if (!live.length) return [];
  const q = [...new Set(terms(prompt))];
  if (!q.length) return [];
  const docs = live.map((c) => terms(cardText(c)));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = /* @__PURE__ */ new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const lower = prompt.toLowerCase();
  const out = [];
  live.forEach((card, i) => {
    const d = docs[i];
    const tf = /* @__PURE__ */ new Map();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    const matched = [];
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      matched.push(t);
      const n = df.get(t);
      const idf = Math.log(1 + (live.length - n + 0.5) / (n + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg));
    }
    let files = cardFiles(card).filter((p) => lower.includes(p.toLowerCase()) || p.split("/").pop().length >= 6 && lower.includes(p.split("/").pop().toLowerCase()));
    score += files.length * 3;
    if (matched.length < 2 && !files.length) return;
    if (opts.projectDir) files = files.filter((p) => existsSync12(join14(opts.projectDir, p)));
    out.push({ card, score, matched, files });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? MAX_CARDS);
}
function embedText(c) {
  return [c.task, c.outcome, ...c.commits.map((k) => k.subject), ...cardFiles(c).slice(0, 20)].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 1e3);
}
var HYBRID_CUT = 0.0321;
var RRF_K = 60;
var dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
function hybridRecall(cards, prompt, vectors, opts = {}) {
  const words = recall(cards, prompt, { ...opts, limit: 50 });
  const meaning = liveCards(cards, opts).filter((c) => vectors.cards.has(c.id)).map((c) => ({ c, s: dot(vectors.query, vectors.cards.get(c.id)) })).sort((a, b) => b.s - a.s).slice(0, 50);
  const fused = /* @__PURE__ */ new Map();
  words.forEach((h, i) => fused.set(h.card.id, { ...h, score: 1 / (RRF_K + i) }));
  meaning.forEach(({ c }, i) => {
    const h = fused.get(c.id) ?? { card: c, score: 0, matched: [], files: [] };
    fused.set(c.id, { ...h, score: h.score + 1 / (RRF_K + i) });
  });
  return [...fused.values()].filter((h) => h.score >= HYBRID_CUT || h.files.length > 0).sort((a, b) => b.score - a.score).slice(0, opts.limit ?? MAX_CARDS);
}
var packVector = (v) => Buffer.from(Float32Array.from(v).buffer).toString("base64");
var unpackVector = (s) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
var clip = (s, n) => safeText(s.replace(/\s+/g, " ").trim(), n);
function renderRecall(hits, projectDir) {
  if (!hits.length) return "";
  const exists = (p) => !projectDir || existsSync12(join14(projectDir, p));
  const lines = ["Snout memory: earlier sessions in this repo that bear on this request (local notes from their transcripts and commits; check before relying on them)."];
  for (const { card: c } of hits) {
    const parts2 = [`- ${c.started.slice(0, 10)} \xB7 ${c.agent}${c.branch ? ` \xB7 ${clip(c.branch, 60)}` : ""}: "${clip(c.task ?? c.commits[0]?.subject ?? "untitled", 160)}"`];
    if (c.outcome) parts2.push(`  how it ended: ${clip(c.outcome, 400)}`);
    const files = cardFiles(c).filter(exists).slice(0, 8);
    if (files.length) parts2.push(`  files: ${files.map((f) => clip(f, 120)).join(", ")}`);
    if (c.commits.length) parts2.push(`  commits: ${c.commits.slice(-3).map((k) => `${k.sha.replace(/[^0-9a-f]/gi, "").slice(0, 7)} "${clip(k.subject, 80)}"`).join("; ")}`);
    if (c.test) parts2.push(`  tests: \`${clip(c.test.command, 100)}\` \u2192 ${clip(c.test.result, 80)}`);
    if (c.error) parts2.push(`  unresolved at the end: ${clip(c.error.line, 140)} (from \`${clip(c.error.command, 80)}\`)`);
    if (c.rules.length) parts2.push(`  the user said: ${c.rules.slice(-3).map((r) => `"${clip(r, 120)}"`).join(" ")}`);
    lines.push(parts2.join("\n"));
  }
  let text = lines.join("\n");
  while (text.length > MAX_BRIEF_CHARS && lines.length > 2) {
    lines.pop();
    text = lines.join("\n");
  }
  return text.length > MAX_BRIEF_CHARS ? `${text.slice(0, MAX_BRIEF_CHARS - 1)}\u2026` : text;
}
var RECUR = 2;
var MAX_BRIEF_FILES = 8;
var BRIEF_CARDS = 200;
var MAX_REPO_BRIEF_CHARS = 1600;
function recurring(cards, values, key = (v) => v.toLowerCase()) {
  const seen = /* @__PURE__ */ new Map();
  for (const c of cards) {
    for (const v of new Set(values(c))) {
      const k = key(v);
      const e = seen.get(k);
      if (e) {
        e.sessions += 1;
        if (c.updated > e.last) {
          e.last = c.updated;
          e.value = v;
        }
      } else seen.set(k, { value: v, sessions: 1, last: c.updated });
    }
  }
  return [...seen.values()].filter((e) => e.sessions >= RECUR).sort((a, b) => b.sessions - a.sessions || b.last.localeCompare(a.last));
}
function repoBrief(cards, opts = {}) {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ? Date.parse(opts.asOf) : void 0;
  const live = cards.filter((c) => asOf !== void 0 ? Date.parse(c.started) < asOf : now - Date.parse(c.updated) <= MAX_AGE_DAYS * 864e5).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, BRIEF_CARDS);
  if (live.length < RECUR) return "";
  const known = (opts.instructions ?? "").toLowerCase();
  const fresh = (s) => !known.includes(s.toLowerCase());
  const exists = (p) => !opts.projectDir || existsSync12(join14(opts.projectDir, p));
  const lines = [];
  const test = recurring(live, (c) => c.test ? [c.test.command] : [], (v) => v).find((t) => fresh(t.value));
  if (test) lines.push(`- Tests run here with: \`${clip(test.value, 160)}\` (${test.sessions} sessions)`);
  const missing = recurring(live, (c) => c.missing ?? []).filter((m) => fresh(m.value)).slice(0, 4);
  if (missing.length) lines.push(`- Not installed here: ${missing.map((m) => clip(m.value, 40)).join(", ")}`);
  const slow = recurring(live, (c) => c.slow ?? [], (v) => v).filter((s) => fresh(s.value)).slice(0, 2);
  for (const s of slow) lines.push(`- Runs past the 2-minute tool limit (prefer narrower runs): \`${clip(s.value, 140)}\``);
  const files = recurring(live, (c) => cardFiles(c), (v) => v).filter((f) => exists(f.value)).slice(0, MAX_BRIEF_FILES);
  if (files.length) lines.push(`- Files most work here touches: ${files.map((f) => `${clip(f.value, 100)} (${f.sessions})`).join(", ")}`);
  const rules = recurring(live, (c) => c.rules).filter((r) => fresh(r.value)).slice(0, 5);
  for (const r of rules) lines.push(`- The user has said in ${r.sessions} sessions: "${clip(r.value, 200)}"`);
  if (!lines.length) return "";
  let text = [`Snout memory: what ${live.length} earlier sessions in this repo keep finding (local notes from their transcripts; check before relying on them).`, ...lines].join("\n");
  while (text.length > MAX_REPO_BRIEF_CHARS && lines.length > 1) {
    lines.pop();
    text = [text.split("\n")[0], ...lines].join("\n");
  }
  return text;
}
function shareMemory(projectDir, snoutDir) {
  const rel = relative7(projectDir, dirOf(snoutDir)).split(sep6).join("/");
  if (!rel || rel.startsWith("..") || isAbsolute10(rel)) return { ok: false, reason: "Snout's records are kept outside this project (SNOUT_DIR), so git can't share them from here." };
  if (git(projectDir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { ok: false, reason: "This project isn't a git repository." };
  const probe = `${rel}/card.json`;
  const ignored = () => spawnSync2("git", ["check-ignore", "-q", "--no-index", probe], { cwd: projectDir, timeout: 2e3, windowsHide: true }).status === 0;
  if (!ignored()) return { ok: true, changedGitignore: false, dir: rel };
  const file2 = join14(projectDir, ".gitignore");
  let text = "";
  try {
    text = readFileSync12(file2, "utf8");
  } catch {
  }
  const top = rel.split("/")[0];
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^/?${top.replace(/\./g, ".")}/?s*$`).test(l));
  if (i < 0) {
    const why = git(projectDir, ["check-ignore", "-v", "--no-index", probe]);
    return { ok: false, reason: `${rel} is ignored by a rule Snout won't edit${why ? ` (${why.split("	")[0]})` : ""}. Add \`!${rel}/\` after it to share memory.` };
  }
  lines.splice(i, 1, `${top}/*`, `!${rel}/`);
  writeAtomic(file2, lines.join(nl));
  return ignored() ? { ok: false, reason: `Updated .gitignore, but another rule still ignores ${rel}.` } : { ok: true, changedGitignore: true, dir: rel };
}

// src/memory/receipts.ts
import { join as join15 } from "node:path";
var file = (snoutDir) => join15(snoutDir, "decisions.jsonl");
function readRecallDecisions(snoutDir) {
  return readRows(file(snoutDir)).filter((r) => r?.kind === "recall" && Array.isArray(r.cands));
}
var norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
function recallOutcomes(decisions, cards, reads) {
  const changedBy = /* @__PURE__ */ new Map();
  for (const c of cards) changedBy.set(c.session, new Set([...c.changed, ...c.commits.flatMap((k) => k.files)].map(norm)));
  const readsBy = /* @__PURE__ */ new Map();
  for (const r of reads) (readsBy.get(r.session) ?? readsBy.set(r.session, []).get(r.session)).push(r);
  return decisions.map((d) => {
    const changed = changedBy.get(d.session) ?? /* @__PURE__ */ new Set();
    const kept = new Set(d.cands.filter((c) => c.kept).flatMap((c) => c.files.map(norm)));
    const dropped = new Set(d.cands.filter((c) => !c.kept).flatMap((c) => c.files.map(norm)));
    const later = new Set((readsBy.get(d.session) ?? []).filter((r) => r.ts >= d.ts).map((r) => norm(r.path)));
    return {
      ...d,
      opened: d.spoke ? [...kept].filter((f) => later.has(f)) : [],
      changed: d.spoke ? [...kept].filter((f) => changed.has(f)) : [],
      missed: d.spoke ? [] : [...dropped].filter((f) => changed.has(f))
    };
  });
}
function summarizeRecall(outcomes) {
  const byReason = { spoke: 0, "no-match": 0, "already-recalled": 0, "map-gate": 0 };
  for (const o of outcomes) byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
  const spoke = outcomes.filter((o) => o.spoke);
  const silent = outcomes.filter((o) => !o.spoke);
  return {
    prompts: outcomes.length,
    spoke: spoke.length,
    opened: spoke.filter((o) => o.opened.length).length,
    changed: spoke.filter((o) => o.changed.length).length,
    silent: silent.length,
    missed: silent.filter((o) => o.missed.length).length,
    byReason
  };
}
export {
  COMMITS,
  COMPACTION_COSTS,
  DEFAULTS,
  DEFAULT_LIMIT,
  HINT_SCORE,
  HYBRID_CUT,
  JEV_USD_PER_MTOK,
  LABELS,
  MAX_LIMIT,
  OVERSIZED_TOKENS,
  PINNED_MODEL,
  PRICES,
  PRICES_AS_OF,
  SQUEEZE_IFS,
  THRESHOLDS,
  agentLabel,
  appendRow,
  applyMode,
  archiveFiles,
  attach,
  auditCi,
  auditContext,
  authorOf,
  bandOf,
  boundedPowerShellRead,
  buildMap,
  byAgentOf,
  candidates,
  captureSession,
  classifyContextPath,
  claudeImports,
  claudeMdLine,
  claudeRequests,
  claudeSlug,
  codeNames,
  codexRequests,
  codexRows,
  codexSessionFacts,
  compactionWhatIf,
  costOf,
  cronPerMonth,
  dailyAggregates,
  decide,
  dropEchoes,
  dumpTargets,
  embedText,
  ensureDir,
  entryFor,
  estimateTokens,
  fingerprintOf,
  firstHit,
  fmtTokens,
  fromInternal,
  gateEntries,
  harnessOf,
  hybridRecall,
  ignoredOutputDirIn,
  installGate,
  isValidMode,
  kindOf,
  labelOf,
  linkCommit,
  listArchives,
  listFiles,
  loadConfig,
  loadState,
  looksCrafted,
  matchesAny,
  memoryText,
  modelKey,
  namedExactly,
  normalize,
  outline,
  overlap,
  packVector,
  parseGitignore,
  parseYaml,
  percentile,
  powerShellDumpTargets,
  priceOf,
  ratioFor,
  readCards,
  readClaudeTranscript,
  readDecisions,
  readPins,
  readProgress,
  readRecallDecisions,
  readRows,
  readSpend,
  readTargets,
  readTranscriptUsage,
  readTurns,
  recall,
  recallOutcomes,
  redundancyOf,
  refreshGate,
  renderAudit,
  renderCandidates,
  renderCi,
  renderMap,
  renderRecall,
  renderReplay,
  renderReport,
  renderStatusline,
  replaySession,
  totals2 as replayTotals,
  repoBrief,
  requestNames,
  resolvePaths,
  responseBytes,
  responseText,
  restoreArchive,
  rotateIfLarge,
  safePath,
  safeText,
  saveState,
  scoreFile,
  scoreLabels,
  scorePrompt,
  searchHint,
  sessionFacts,
  sessionStartMs,
  shareMemory,
  shingles,
  shouldSuggest,
  sizeOf,
  snoutignore,
  splitGrepOutput,
  squeeze,
  squeezeEntries,
  staleRefs,
  starterEntries,
  summarize,
  summarizeLedger,
  summarizeRecall,
  summarizeSpend,
  tailLines,
  terms,
  testCommand,
  tier0,
  tipsOf,
  toJson,
  toRegExp,
  toRel,
  totals,
  totalsOf,
  trimMcp,
  unpackVector,
  withOverride,
  writeAtomic
};
