/**
 * The tier 0 rules as pure functions over a file's signals: its path, the first 2 KB and
 * its size. No Node imports — `tier0.ts` supplies the signals from disk.
 *
 * Two views over the same rules:
 *
 *   firstHit   — the policy. Rules run in authority order and the first match wins. This
 *                is what the hooks act on, and the order is tested.
 *   scoreLabels — the explanation. Every rule runs on its own and reports a score per
 *                label, so a reader sees the runner-ups ("a lockfile, and also inside
 *                vendor/") and the near misses. It never changes a verdict.
 *
 * Near misses are *hints*: evidence one step short of a rule (a "DO NOT EDIT" banner with
 * no generator named, a 2 KB line with no `.min` in the name). Hints score HINT_SCORE,
 * which sits below the ask threshold, so by the low-confidence invariant they can never
 * act — they only show where the rules stop.
 */
import type { ContextValue, Decision } from "../types.js";
import { matchesAny, toRegExp } from "../util/glob.js";
import { looksCrafted, safePath, safeText } from "../util/safe.js";

/** The config keys the rules read. A subset of Config, so the browser needs no Node config. */
export interface RuleConfig {
  sizeCapBytes: number;
  alwaysAllow: readonly string[];
  alwaysDeny: readonly string[];
  redact: readonly string[];
  redactExempt: readonly string[];
}

/**
 * What a rule may look at. `head` and `bytes` are lazy so the policy path pays for a read
 * or a stat only when every cheaper rule has passed — the same cost profile tier 0 had
 * before the rules were pulled out.
 */
export interface Signals {
  /** POSIX path relative to the project root, or absolute when outside it. */
  rel: string;
  cfg: RuleConfig;
  head(): Uint8Array | null;
  bytes(): number;
  /** The OUTPUT_DIRS segment of `rel` the project's .gitignore ignores, if any. */
  ignoredOutputDir(rel: string): string | null;
  snoutignore: readonly string[];
}

/** Display labels. Several rules share one (`binary` and `binary-content` are both binary). */
export type Label =
  | "read"
  | "secret"
  | "crafted-path"
  | "binary"
  | "lockfile"
  | "license"
  | "vendored"
  | "minified"
  | "always-deny"
  | "snapshot"
  | "generated"
  | "oversized";

export const LABELS: readonly Label[] = [
  "read", "secret", "crafted-path", "binary", "lockfile", "license", "vendored",
  "minified", "always-deny", "snapshot", "generated", "oversized",
];

/** Score of a near miss. Must stay below THRESHOLDS.askMinConfidence; a test enforces it. */
export const HINT_SCORE = 0.4;

export interface LabelScore {
  label: Label;
  /** 0-1. For a rule, its confidence; for `read`, 1 minus the strongest flag. */
  score: number;
  /** The rule (or hint) that produced the score. */
  rule: string;
  hint?: boolean;
}

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "mp3", "mp4", "wav", "mov", "avi", "webm", "flac", "ogg",
  "woff", "woff2", "ttf", "otf", "eot",
  "so", "dylib", "dll", "exe", "bin", "o", "a", "class", "jar", "wasm",
  "pyc", "pyo", "db", "sqlite", "sqlite3", "parquet", "npy", "pkl", "onnx", "safetensors",
]);

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "poetry.lock", "Pipfile.lock", "uv.lock", "Cargo.lock", "composer.lock",
  "Gemfile.lock", "go.sum", "gradle.lockfile", "mix.lock", "pubspec.lock",
  "packages.lock.json", "flake.lock",
]);

/**
 * Standard license/copying text at the repo root. Found by `bench/label.mjs` against
 * WordPress/WordPress's `license.txt` — verified to be 384 lines of unmodified GPLv2
 * boilerplate, not project-specific content. An exact-filename list, same reasoning as
 * LOCKFILES: legal boilerplate is uniform enough that matching by name carries very low
 * false-deny risk, unlike trying to detect "is this legal text" from content.
 */
const LICENSE_FILES = new Set([
  "LICENSE", "LICENSE.txt", "LICENSE.md", "license.txt", "COPYING", "COPYING.txt",
  // Aggregated third-party notices; vscode's is 179 KB. Found by bench/label.mjs.
  "ThirdPartyNotices.txt", "THIRD-PARTY-NOTICES", "THIRD-PARTY-NOTICES.txt", "THIRD_PARTY_NOTICES", "THIRD_PARTY_NOTICES.txt",
]);

/**
 * Directory names that are never hand-maintained source. `deps` was added after
 * `bench/label.mjs` flagged `nodejs/node`'s `deps/LIEF/` as unclassified; checking the real
 * repo found `deps/` holding ~30 independent third-party projects (LIEF, openssl, v8, zlib,
 * uv, sqlite, undici, ...), the same convention `vendor/` names for other ecosystems.
 * `deps` counts only at the repository root (ROOT_VENDOR_DIRS): Track A found bun's
 * hand-written build recipes in `scripts/build/deps/` trimmed as vendored.
 */
const VENDOR_DIRS = [
  "node_modules", ".git", "vendor",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".nyc_output", ".gradle", ".terraform", "Pods", "DerivedData",
  ".snout",
];

/**
 * Third-party files dropped straight into a tree, with no vendor directory and no
 * generator banner to signal it — the directory check above and the banner check below
 * both miss these by construction. This is an exact-filename list, not a heuristic:
 * content-based "does this look like someone else's code" detection would carry far more
 * false-deny risk than this codebase accepts for a value-0 verdict. Every entry here was
 * independently verified against the real file (not recalled from memory) before being
 * added: `bench/run.mjs` found `class-pclzip.php` unclassified in WordPress/WordPress;
 * `class-phpass.php` and `class-IXR.php` were confirmed the same way, at the same commit.
 * Add to this list only after the same verification — a wrong entry here is a silent
 * false-deny on every user who happens to have a file with that exact name.
 */
const KNOWN_VENDORED_FILES = new Set(["class-pclzip.php", "class-phpass.php", "class-IXR.php"]);

/**
 * Build-output directory names. Unlike VENDOR_DIRS these count only when the root
 * `.gitignore` ignores them. `bench/label.mjs` found every committed `build/` in the corpus
 * being denied as vendored while holding hand-written source: vscode's build tooling,
 * kubernetes's build scripts, spring-boot's `org/springframework/boot/build/` Java package
 * (946 files). Same for go's `src/cmd/dist` and deno's `cli/tools/coverage`. A committed
 * output-named directory is almost always source; an ignored one is output.
 */
const OUTPUT_DIRS = ["dist", "build", "out", "target", "coverage"];

/**
 * Directory segments that hold machine-generated JSON/YAML with no comment syntax to carry
 * a banner — the check below cannot see these by construction, the way STRONG_MARKERS
 * cannot. Real example: kubernetes/kubernetes's OpenAPI spec dump under
 * `api/openapi-spec/`, found by `bench/run.mjs`.
 */
const GENERATED_PATH_SEGMENTS = ["openapi-spec"];

/** Filename suffixes for the same comment-less-generated-output case, by convention rather than directory. */
const GENERATED_FILENAME_SUFFIXES = [
  ".generated.json", ".generated.yaml", ".generated.yml", ".gen.json", ".gen.yaml", ".gen.yml",
  // GitHub Agentic Workflows compiles `x.md` to `x.lock.yml`; found by bench/label.mjs in dotnet/aspnetcore.
  ".lock.yml",
];

/** Extensions the two markers above apply to — formats with no comment syntax at all. */
const NO_COMMENT_SYNTAX_EXT = new Set(["json", "yaml", "yml"]);

/**
 * Markers that only a generator writes. A hit is conclusive.
 */
const STRONG_MARKERS = [
  "@generated",
  "Code generated by",
  "Generated by protoc",
  "Generated by the protocol buffer compiler",
  "This file was generated",
  "This file is generated",
  "@nocommit-generated",
  "prisma-client-js",
  "autogenerated by",
  "Automatically generated by",
];

/**
 * Phrases that suggest generation but also appear in hand-written code.
 *
 * "DO NOT EDIT" was previously treated as conclusive, so
 *
 *     // TODO: do not edit this constant without updating the migration
 *     export const V = 3
 *
 * was classified generated with confidence 1.0 — and in enforce mode, denied. That is
 * exactly the false deny that makes a context gate untrustworthy.
 *
 * A weak marker now counts only alongside a separate generator hint, and only near the
 * top of the file where a generator's banner actually lives.
 */
const WEAK_MARKERS = [
  "DO NOT EDIT", "do not edit", "auto-generated", "autogenerated", "Automatically generated",
  "This is a generated file", // biome's codegen banner, found by bench/label.mjs
];

/** Corroboration for a weak marker: some named tool or pipeline in the same banner. */
const GENERATOR_HINT =
  /\b((?:auto-?)?generat\w*|codegen|protoc|openapi|swagger|graphql-codegen|prisma|thrift|grpc|bindgen|sqlc|jooq|wsdl|xsd|scaffold)\b/i;

/** How many lines from the top a generator banner may appear. */
const BANNER_LINES = 6;


interface Rule {
  label: Label;
  run(s: Signals, name: string, ext: string | null): Decision | null;
}

/** The rules in authority order. The order is the policy: see tier0.ts. */
const RULES: readonly Rule[] = [
  // 0. A path carrying control characters or bidi overrides is itself the finding: no
  // legitimate build writes one, and it is how a repository tries to talk to the model
  // through our own output.
  {
    label: "crafted-path",
    run: (s) =>
      looksCrafted(s.rel)
        ? {
            verdict: "ask",
            tier: 0,
            rule: "crafted-path",
            value: 0,
            confidence: 1,
            reason: `${safePath(s.rel)} contains control or text-direction characters that no ordinary filename needs. Treat it as untrusted.`,
            warn: true,
          }
        : null,
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
        warn: true,
      };
    },
  },

  // 2. The user's own allowlist outranks every heuristic below it.
  {
    label: "read",
    run: (s) => {
      const allowed = matchesAny(s.rel, s.cfg.alwaysAllow);
      return allowed ? decision("allow", "always-allow", 3, 1, `${safePath(s.rel)} is on your always-allow list (${safeText(allowed)}).`) : null;
    },
  },

  // 3. Binary content. A coding agent gets nothing usable from these bytes.
  {
    label: "binary",
    run: (s, _n, ext) =>
      ext && BINARY_EXT.has(ext)
        ? low("binary", `${safePath(s.rel)} is a binary ${safeText(ext.toUpperCase(), 12)} file, so reading it yields no usable text.`)
        : null,
  },

  // 4. Lockfiles: enormous, machine-owned, and almost never what the task needs.
  {
    label: "lockfile",
    run: (s, name) =>
      LOCKFILES.has(name) ? low("lockfile", `${safePath(s.rel)} is a dependency lockfile, written by the package manager rather than by hand.`) : null,
  },

  // 4b. Standard license text: uniform boilerplate, not project-specific content.
  {
    label: "license",
    run: (s, name) =>
      LICENSE_FILES.has(name) ? low("license", `${safePath(s.rel)} is standard license text, not project-specific content.`) : null,
  },

  // 5. Vendored, built and cached trees.
  {
    label: "vendored",
    run: (s) => {
      const top = s.rel.split("/")[0]!;
      const vendorDir = firstSegmentMatch(s.rel, VENDOR_DIRS) ?? (s.rel.includes("/") && ROOT_VENDOR_DIRS.includes(top) ? top : null) ?? s.ignoredOutputDir(s.rel);
      return vendorDir
        ? low("vendored", `${safePath(s.rel)} sits inside ${safeText(vendorDir, 40)}/, a directory of installed or generated output rather than source you maintain.`)
        : null;
    },
  },

  // 5b. Known third-party files with no vendor directory to catch them. See
  // KNOWN_VENDORED_FILES for why this is a short, verified, exact-match list rather than a
  // content heuristic.
  {
    label: "vendored",
    run: (s, name) =>
      KNOWN_VENDORED_FILES.has(name)
        ? low("vendored", `${safePath(s.rel)} is a known third-party library bundled directly into this tree, not under a vendor directory.`)
        : null,
  },

  // 6. Minified and source-map output.
  {
    label: "minified",
    run: (s, name) =>
      /\.min\.(js|css|mjs|cjs)$/.test(name) || name.endsWith(".map")
        ? low("minified", `${safePath(s.rel)} is minified or a source map, so its contents are unreadable to a person and to a model.`)
        : null,
  },

  // 7. The user's own denylist, plus anything in .snoutignore.
  {
    label: "always-deny",
    run: (s) => {
      const denied = matchesAny(s.rel, s.cfg.alwaysDeny) ?? matchesAny(s.rel, s.snoutignore);
      return denied ? low("always-deny", `${safePath(s.rel)} is on your always-deny list (${safeText(denied)}).`) : null;
    },
  },

  // 8. Snapshot and recorded-fixture directories: marginal, not worthless.
  {
    label: "snapshot",
    run: (s, name) =>
      // Recorded output only. Plain fixtures/ folders were dropped: Track A's audit found most of
      // them hold hand-written test inputs, and the ask stopped the agent to read them.
      /(^|\/)(__snapshots__|cassettes)(\/|$)/.test(s.rel) || name.endsWith(".snap")
        ? marginal("snapshot", `${safePath(s.rel)} is a recorded snapshot or fixture; useful only when the task is specifically about it.`)
        : null,
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
      return head && isBinary(head)
        ? low("binary-content", `${safePath(s.rel)} contains binary data rather than text, so reading it yields nothing usable.`)
        : null;
    },
  },

  // 9. A generated-file marker in the first 2 KB. One small read, still no network.
  {
    label: "generated",
    run: (s) => {
      const marker = generatedMarker(s.head());
      return marker
        ? low("generated", `${safePath(s.rel)} declares itself generated ("${safeText(marker, 40)}"), so editing it would be overwritten by the tool that produces it.`)
        : null;
    },
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
          `${safePath(s.rel)} sits inside ${safeText(genDir, 40)}/, a directory convention for machine-generated ${safeText(ext.toUpperCase(), 6)} output that cannot carry a generator banner.`,
        );
      }
      const genSuffix = GENERATED_FILENAME_SUFFIXES.find((x) => name.endsWith(x));
      if (genSuffix) {
        return low(
          "generated",
          `${safePath(s.rel)} is named with the "${safeText(genSuffix, 20)}" convention for machine-generated output, which cannot carry a generator banner.`,
        );
      }
      return null;
    },
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
      return text && /<link[^>]+href="[^"]*\bjazzy\.css"/.test(text)
        ? low("generated", `${safePath(s.rel)} is a page rendered by the jazzy documentation generator.`)
        : null;
    },
  },

  // 10. Size cap. Not a value judgement: a file this large crowds out everything else.
  {
    label: "oversized",
    run: (s) => {
      const bytes = s.bytes();
      return bytes > s.cfg.sizeCapBytes
        ? marginal(
            "oversized",
            `${safePath(s.rel)} is ${(bytes / 1024).toFixed(0)} KB, large enough to crowd out the rest of the conversation. Reading a specific range is usually better than the whole file.`,
          )
        : null;
    },
  },
];

/**
 * Near misses. Scored, never acted on. Each names what the rule it shadows would need.
 * The fixture hint covers `testdata/`, `golden/` and `__mocks__/`, which are an open policy
 * question (a golden file is sometimes exactly what a task needs), so they are shown and
 * not flagged.
 */
const HINTS: readonly { label: Label; rule: string; test(s: Signals, name: string): boolean }[] = [
  {
    label: "generated",
    rule: "generated-hint",
    test: (s) => {
      const text = decode(s.head());
      if (!text) return false;
      const banner = text.split("\n", BANNER_LINES).join("\n");
      return WEAK_MARKERS.some((m) => banner.includes(m));
    },
  },
  {
    label: "minified",
    rule: "minified-hint",
    test: (s) => {
      const text = decode(s.head());
      return !!text && text.split("\n").some((line) => line.length >= 1000);
    },
  },
  {
    label: "snapshot",
    rule: "fixture-hint",
    test: (s, name) => /(^|\/)(testdata|golden|goldens|__mocks__)(\/|$)/.test(s.rel) || /\.golden(\.|$)/.test(name),
  },
  {
    label: "oversized",
    rule: "size-hint",
    test: (s) => s.bytes() > s.cfg.sizeCapBytes / 2,
  },
];

/** The policy: the first rule in authority order that matches, or null for "no rule applies". */
export function firstHit(s: Signals): Decision | null {
  const name = basename(s.rel);
  const ext = extOf(name);
  for (const r of RULES) {
    const d = r.run(s, name, ext);
    if (d) return d;
  }
  return null;
}

/**
 * The explanation: every label's score, highest first, `read` included.
 *
 * A label's score is the highest confidence any of its rules reported, or HINT_SCORE for a
 * near miss. `read` is 1 minus the strongest flag — how much room the flags leave — and 1
 * outright when the user's allowlist matched. Scores are independent per label, like a
 * multi-label classifier, so they do not sum to 1: a lockfile inside `vendor/` is both.
 */
export function scoreLabels(s: Signals): LabelScore[] {
  const name = basename(s.rel);
  const ext = extOf(name);
  const best = new Map<Label, LabelScore>();
  const put = (x: LabelScore) => {
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

/** The display label a decision's rule belongs to. */
export function labelOf(d: Decision | null): Label {
  if (!d || d.verdict === "allow") return "read";
  if (d.rule === "binary-content") return "binary";
  return (LABELS as readonly string[]).includes(d.rule) ? (d.rule as Label) : "read";
}

function decision(
  verdict: Decision["verdict"],
  rule: string,
  value: ContextValue,
  confidence: number,
  reason: string,
): Decision {
  return { verdict, tier: 0, rule, value, confidence, reason };
}

/** Low value, high certainty: the deny candidates. */
function low(rule: string, reason: string): Decision {
  return decision("deny", rule, 0, 1, reason);
}

/** Marginal value: worth asking about, never worth denying outright. */
function marginal(rule: string, reason: string): Decision {
  return decision("ask", rule, 1, 0.8, reason);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function basename(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}

function extOf(name: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m?.[1]?.toLowerCase() ?? null;
}

/** True when `marker` sits inside a double-quoted string on `line`, judged by an odd number of quotes on either side. */
function insideDoubleQuotes(line: string, marker: string): boolean {
  const i = line.indexOf(marker);
  const count = (t: string) => (t.match(/"/g) ?? []).length;
  return count(line.slice(0, i)) % 2 === 1 || count(line.slice(i + marker.length)) % 2 === 1;
}

/** Vendor directory names that mean third-party code only as a repository's top-level folder. */
const ROOT_VENDOR_DIRS = ["deps"];

function firstSegmentMatch(rel: string, dirs: readonly string[]): string | null {
  const segments = rel.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (dirs.includes(seg)) return seg;
  }
  return null;
}

// ---------- .gitignore, the subset that decides a directory ----------

export interface IgnoreRule {
  negate: boolean;
  anchored: boolean;
  re: RegExp;
}

/**
 * Only the subset of gitignore that decides a directory: `!` negation, a leading or inner
 * `/` anchoring to the root, a trailing `/` or `/**`. spring-boot and kotlin rely on
 * negation (`build` then `!**\/src/**\/build`), bun and deno on anchoring (`/build/`,
 * `/coverage`); both are exercised by the corpus.
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n").slice(0, 2000)) {
    let p = line.trim();
    if (!p || p.startsWith("#")) continue;
    const negate = p.startsWith("!");
    if (negate) p = p.slice(1);
    p = p.replace(/\/\*\*$/, "").replace(/\/+$/, "");
    if (!p) continue;
    const anchored = p.includes("/"); // git: a slash anywhere but the end anchors to the root
    rules.push({ negate, anchored, re: toRegExp(p.replace(/^\//, "")) });
  }
  return rules;
}

/** The first OUTPUT_DIRS segment of `rel` that `rules` ignore. Last matching rule wins, as in git. */
export function ignoredOutputDirIn(rel: string, rules: readonly IgnoreRule[]): string | null {
  const segments = rel.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
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

// ---------- content checks over the 2 KB head ----------

const utf8 = new TextDecoder("utf-8");

function decode(head: Uint8Array | null): string | null {
  if (!head || head.length === 0) return null;
  try {
    return utf8.decode(head);
  } catch {
    return null;
  }
}

/**
 * Binary by content: a NUL byte, or a high share of bytes that no text file carries.
 *
 * A NUL in the first 2 KB is the classic test and is what git itself uses. The ratio check
 * catches the rest without decoding, and the threshold is deliberately high so that UTF-8
 * text, which is full of high bytes, is never mistaken for binary.
 */
function isBinary(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  let suspicious = 0;
  for (const b of head) {
    if (b === 0) return true;
    // Control bytes that are not tab, newline, carriage return or form feed.
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++;
  }
  return suspicious / head.length > 0.3;
}

/**
 * Looks for a generator's banner in a head already read.
 *
 * A strong marker anywhere in that window is conclusive. A weak marker counts only in the
 * first few lines and only with a corroborating generator hint nearby.
 */
function generatedMarker(headBuf: Uint8Array | null): string | null {
  const head = decode(headBuf);
  if (!head) return null;

  for (const marker of STRONG_MARKERS) {
    if (head.includes(marker)) return marker;
  }

  // A weak marker on a line that quotes something is talking about a banner, not being one
  // (Track A: a CI script describing the "this is generated, do not edit" header it checks for).
  const bannerLines = head.split("\n", BANNER_LINES);
  const banner = bannerLines.join("\n");
  for (const marker of WEAK_MARKERS) {
    const line = bannerLines.find((l) => l.includes(marker));
    if (line && !insideDoubleQuotes(line, marker) && GENERATOR_HINT.test(banner)) return marker;
  }
  return null;
}
