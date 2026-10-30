/**
 * Repo map: names that recur across a project's files, each linked to the files that define or
 * use it, built once and reused for every request. Given a request, the files linked to the names
 * it mentions are offered as candidate paths, so the agent can open the right files instead of
 * rediscovering them by search.
 *
 * The design follows CorpusMap (Jeong et al., 2026, arXiv:2609.37226) for code:
 * - names, not documents, are the anchors; a name links files only when two or more share it,
 *   except a name the request types exactly as declared, which points to its declaring file;
 *   a name no file declares counts only where the request writes it as code (backticks, a code
 *   block or traceback, a call, an underscore), so English words ("Please", "Create") link nothing;
 * - a file is "named" only when the request writes it as a file (`query.py`, `/query`, "the query
 *   module"), not when a word matches its stem ("tests", "changelog");
 * - the map is a plain name→files index (no name→name edges: they added tokens, not recall);
 * - it is built without a model (declarations and identifiers), from hand-written files only:
 *   Snout's own rules leave out generated, vendored and lockfile content;
 * - the agent gets paths, never contents, and a short list (CorpusMap: quality holds from a few
 *   candidates up, and long lists cost tokens on every later turn).
 * - per-file entries are reused while a file's size and mtime are unchanged, so a rebuild only
 *   reads what changed.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

export interface FileEntry {
  size: number;
  mtime: number;
  /** Names this file declares at top level. */
  defs: string[];
  /** Distinct identifiers it mentions (capped). */
  words: string[];
}

export interface RepoMap {
  version: 1;
  builtAt: string;
  files: Record<string, FileEntry>;
}

export interface Candidate {
  path: string;
  score: number;
  defines: string[];
  uses: string[];
  /** The request writes this file's path. */
  named?: boolean;
}

const TEXT_EXT = /\.(m?js|cjs|jsx|ts|tsx|mts|cts|py|pyi|go|rs|java|kt|kts|cs|rb|php|swift|scala|c|cc|cpp|h|hpp|m|mm|ex|exs|erl|clj|lua|sh|bash|zsh|sql|graphql|proto|vue|svelte|astro|md|mdx|rst|txt|toml|ya?ml|json|ini|cfg|conf|env\.example|html|css|scss)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", "third_party", "coverage", ".next", ".venv", "venv", "__pycache__", ".snout", ".claude", ".tox", ".mypy_cache", ".pytest_cache"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;
const MAX_WORDS = 3000;
/** What a name counts for when it appears only in output pasted into the request. */
const OUTPUT_WEIGHT = 0.25;

const WORD = /[A-Za-z_][A-Za-z0-9_]{3,63}/g;
/** Test files: they use every name a bug report's example uses, so their uses count for less. */
const TESTS = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*$|_tests?\.[a-z]+$|\.(test|spec)\.[a-z]+$/i;
/** Links in a request: their paths and hosts are not names or file references. */
const URL = /\b(?:https?:\/\/|www\.)\S+/g;
/** Files that mention names in prose rather than code. */
const PROSE = /\.(md|mdx|rst|txt|ya?ml|json|toml|ini|cfg|html)$|(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS)/i;
/** Language keywords and filler that would link every file to every other. */
const STOP = new Set(("this that with from import export return const self None True False null true false function class def async await else elif while yield None void static public private protected final string number boolean object undefined type interface extends implements raise except finally lambda pass break continue default switch case throw catch new delete typeof instanceof struct enum impl trait match package module require include using namespace println printf print len range dict list tuple int float str bool char auto var let elif then done when unless begin end").split(" "));

/** Top-level declarations per language: the names a request is likely to mention. */
const DECLARATIONS: [RegExp, RegExp][] = [
  [/\.(m?js|cjs|jsx|ts|tsx|mts|cts|vue|svelte)$/, /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)|^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm],
  [/\.pyi?$/, /^\s{0,4}(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm],
  [/\.go$/, /^(?:func\s+(?:\([^)\n]*\)\s*)?|type\s+)([A-Za-z_]\w*)/gm],
  [/\.rs$/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_]\w*)/gm],
  [/\.(java|kt|kts|cs|scala|swift)$/, /^\s{0,8}(?:(?:public|private|protected|internal|static|final|abstract|open|data|sealed|override)\s+)*(?:class|interface|enum|record|object|struct|fun|func|def|void|[\w<>\[\]]+)\s+([A-Za-z_]\w*)\s*[({<:]/gm],
  [/\.rb$/, /^\s*(?:def\s+(?:self\.)?|class\s+|module\s+)([A-Za-z_]\w*[?!]?)/gm],
  [/\.php$/, /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function|class|interface|trait)\s+([A-Za-z_]\w*)/gm],
  [/\.(c|cc|cpp|h|hpp)$/, /^(?:[A-Za-z_][\w\s\*]*\s)?\**([A-Za-z_]\w*)\s*\([^;]*$/gm],
];
/** UPPER_SNAKE names (settings, env vars, error codes) count as declared wherever they are assigned. */
const CONSTANT = /^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+|final\s+|static\s+)*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*[:=]/gm;

/** Hand-written text files under the project, via git when available. */
export function listFiles(projectDir: string): string[] {
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && git.stdout.trim()) {
    return git.stdout.split("\n").filter((f) => f && TEXT_EXT.test(f) && !f.split("/").some((p) => SKIP_DIR.has(p))).slice(0, MAX_FILES);
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name)); }
      else if (e.isFile() && TEXT_EXT.test(e.name)) out.push(relative(projectDir, join(dir, e.name)).split(sep).join("/"));
    }
  };
  walk(projectDir);
  return out;
}

export function entryFor(rel: string, text: string, size: number, mtime: number): FileEntry {
  const defs = new Set<string>();
  for (const [ext, re] of DECLARATIONS) {
    if (!ext.test(rel)) continue;
    for (const m of text.matchAll(re)) { const n = m[1] ?? m[2]; if (n && n.length >= 3) defs.add(n); }
  }
  for (const m of text.matchAll(CONSTANT)) defs.add(m[1]!);
  const words = new Set<string>();
  for (const m of text.matchAll(WORD)) {
    if (words.size >= MAX_WORDS) break;
    if (!STOP.has(m[0]) && !STOP.has(m[0].toLowerCase())) words.add(m[0]);
  }
  return { size, mtime, defs: [...defs], words: [...words] };
}

/**
 * Builds the map, reusing `prev` entries for files whose size and mtime are unchanged.
 * `skip(rel)` leaves a file out (Snout passes its own low-value rules).
 */
export function buildMap(projectDir: string, prev?: RepoMap | null, skip?: (rel: string) => boolean): { map: RepoMap; read: number; reused: number } {
  const files: Record<string, FileEntry> = {};
  let read = 0, reused = 0;
  for (const rel of listFiles(projectDir)) {
    if (skip?.(rel)) continue;
    let st;
    try { st = statSync(join(projectDir, rel)); } catch { continue; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const old = prev?.files[rel];
    if (old && old.size === st.size && old.mtime === st.mtimeMs) { files[rel] = old; reused++; continue; }
    let text: string;
    try { text = readFileSync(join(projectDir, rel), "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;
    files[rel] = entryFor(rel, text, st.size, st.mtimeMs);
    read++;
  }
  return { map: { version: 1, builtAt: new Date().toISOString(), files }, read, reused };
}

/** The names a request mentions: identifiers, plus camelCase/snake_case joins of adjacent words. */
export function requestNames(prompt: string): Set<string> {
  const names = new Set<string>();
  for (const m of prompt.matchAll(WORD)) if (!STOP.has(m[0].toLowerCase())) names.add(m[0]);
  const words = prompt.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [];
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i]!, words[i + 1]!];
    if (a.length < 3 || b.length < 2) continue;
    names.add(`${a}_${b}`);
    names.add(a + b[0]!.toUpperCase() + b.slice(1));
    names.add(a[0]!.toUpperCase() + a.slice(1) + b[0]!.toUpperCase() + b.slice(1));
  }
  return names;
}

/**
 * Names the request writes as code: inside backticks, a fenced or indented block or a traceback
 * line, or shaped like code in running text (a call, attribute access, decorator, an underscore,
 * a digit, or a lowercase-first camelCase name).
 */
export function codeNames(request: string): Set<string> {
  const out = new Set<string>();
  const prompt = request.replace(URL, " ");
  const spans = [
    ...[...prompt.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]),
    ...prompt.split("\n").filter((l) => /^(\t| {4})|^\s*File "|^\s*(>>>|\$|In \[\d+\]:)/.test(l)),
  ];
  for (const sp of spans) for (const m of sp.matchAll(WORD)) out.add(m[0]);
  for (const m of prompt.matchAll(/(?<=[.@])[A-Za-z_]\w{3,63}|[A-Za-z_]\w{3,63}(?=\()/g)) out.add(m[0]);
  for (const m of prompt.matchAll(WORD)) if (/_|\d|^[a-z]+[A-Z]/.test(m[0])) out.add(m[0]);
  return out;
}

/**
 * True when the prompt names `name` itself, as code: the identifier appears verbatim and looks like
 * one (mixed case, an underscore or digit, or long enough not to be an ordinary word). Plain words
 * that merely join into a declared name ("tax rate" → taxRate) don't count.
 */
export function namedExactly(prompt: string, name: string): boolean {
  if (!new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[$]/g, "\\$")}($|[^A-Za-z0-9_])`).test(prompt)) return false;
  return /[A-Z_0-9]/.test(name.slice(1)) || name.length >= 8 || (/^[A-Z]/.test(name) && name.length >= 6);
}

/**
 * A line a program printed rather than one the reporter wrote: a timestamped or levelled log line,
 * a table row drawn with box characters, a version banner ("hugo v0.164.0-…").
 */
const LOG_LINE = /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]\d|\[?\d{2}:\d{2}:\d{2}\b|(?:INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|FATAL)\b|[│┃┆─━┼╋┌┐└┘├┤]|[a-z][\w-]* v\d+\.\d+\.\d+\S*\s)/;
const OUTPUT_FENCE = /^(?:text|txt|plain|plaintext|console|log|logs|output|terminal|shell-session|sh-session)$/i;
/** Tracebacks and stack frames stay: the frame nearest the error is the strongest pointer there is. */
const STACK = /Traceback \(most recent call last\)|File "[^"\n]+", line \d+|^\s+at \S+[ (]|^goroutine \d+ \[|^\S+\.go:\d+/m;
/** One stack frame line: Python's `File "…", line N`, a JS or Java `at …`, a Go `path.go:N +0x…`. */
const FRAME = /File "[^"\n]+", line \d+|^\s+at \S+[ (]|^\s*\S+\.go:\d+(?:\s+\+0x[0-9a-f]+)?\s*$/;

/**
 * The request without the program output pasted into it: `<pre>` blocks, fenced blocks marked as
 * text or console output or made mostly of log lines, and log lines in running text. Build logs and
 * version banners name a project's own pipeline functions ("step process", "render deferred") on
 * every report and outweigh the few names the reporter wrote; measured on Hugo #15234, where they
 * pushed the file the issue itself names out of the top 40.
 */
export function withoutOutput(prompt: string): string {
  const s = prompt
    .replace(/<pre>[\s\S]*?<\/pre>/gi, "\n")
    .replace(/```([^\n`]*)\n([\s\S]*?)```/g, (block, info: string, body: string) => {
      if (STACK.test(body)) return block;
      const lines = body.split("\n").filter((l) => l.trim());
      const logged = lines.filter((l) => LOG_LINE.test(l)).length;
      return OUTPUT_FENCE.test(info.trim()) || (lines.length >= 3 && logged * 2 >= lines.length) ? "\n" : block;
    });
  return s.split("\n").filter((l) => !LOG_LINE.test(l)).join("\n");
}

/** Code files, matched by a path's tail; a `layouts/single.html` or `config/hugo.toml` is usually the reporter's own. */
const CODE_EXT = /\.(m?js|cjs|jsx|ts|tsx|mts|cts|py|pyi|go|rs|java|kt|kts|cs|rb|php|swift|scala|c|cc|cpp|h|hpp|m|mm|ex|exs|erl|clj|lua|vue|svelte)$/i;

/**
 * Files the request names by path: a code file's path of two or more segments that ends one project
 * file's path and no other's (`tpl/tplimpl/templatetransform.go`, `src/cart.ts:41`), or any file's
 * full path from the project root. Read from the request without its pasted output.
 */
export function namedPaths(paths: string[], signal: string): Set<string> {
  const bySuffix = new Map<string, string | null>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 0; i + 1 < segs.length; i++) {
      const s = segs.slice(i).join("/");
      bySuffix.set(s, bySuffix.has(s) && bySuffix.get(s) !== p ? null : p);
    }
  }
  const files = new Set(paths);
  const out = new Set<string>();
  // Stack frames are weighed by `locations` (innermost first), not lifted all at once.
  const text = signal.replace(URL, " ").split("\n").filter((l) => !FRAME.test(l)).join("\n");
  for (const m of text.matchAll(/(?<![\w.\/-])((?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z]\w{0,5})(?![\w\/])/g)) {
    const raw = m[1]!.replace(/\\/g, "/").replace(/^\.\//, "");
    const segs = raw.split("/").filter(Boolean);
    // A bare name (`changelog.py`) keeps the smaller boost `candidates` gives a file named as a file.
    if (segs.length < 2) continue;
    // A site, config or content file the reporter names (`layouts/single.html`) is usually their own,
    // matching some docs or skeleton copy by its tail: only a code file is matched that way.
    if (!CODE_EXT.test(raw)) {
      if (files.has(segs.join("/"))) out.add(segs.join("/"));
      continue;
    }
    // An absolute or checkout-relative path (`/home/me/hugo/tpl/x.go`) is matched by its longest known tail.
    for (let i = 0; i + 1 < segs.length; i++) {
      const hit = bySuffix.get(segs.slice(i).join("/"));
      if (hit) out.add(hit);
      if (hit !== undefined) break;
    }
  }
  // A test the reporter points at shows the bug; the fix is rarely in it (SWE-bench: 2 of 5 losses).
  return new Set([...out].filter((p) => !TESTS.test(p)));
}

/**
 * The hook's firing rule: suggest when the request names a candidate's file by path, or when a
 * candidate declares a name the request types exactly outside pasted output.
 */
export function shouldSuggest(cs: Candidate[], prompt: string): boolean {
  const signal = withoutOutput(prompt);
  return cs.some((c) => c.named || c.defines.some((name) => namedExactly(signal, name)));
}

/**
 * Files linked to the names a request mentions, best first. A file that declares a name scores
 * more than one that only uses it; rarer names score more (inverse document frequency). Names
 * linked to only one file, or to too large a share of the project, are not anchors.
 */
export function candidates(map: RepoMap, prompt: string, k = 15): Candidate[] {
  const paths = Object.keys(map.files);
  const N = paths.length;
  if (!N) return [];
  const asked = requestNames(prompt.replace(URL, " "));
  const signal = withoutOutput(prompt);
  const written = requestNames(signal.replace(URL, " "));
  const writtenLower = new Set([...written].map((a) => a.toLowerCase()));
  // A name that appears only in pasted output counts a quarter, and never as code.
  const weight = (name: string) => (written.has(name) || writtenLower.has(name.toLowerCase()) ? 1 : OUTPUT_WEIGHT);
  const asCode = codeNames(signal);
  const askedLower = new Map<string, string>();
  for (const a of asked) if (a.length >= 6) askedLower.set(a.toLowerCase(), a);

  const definedBy = new Map<string, string[]>();
  for (const p of paths) for (const d of map.files[p]!.defs) {
    if (asked.has(d) || askedLower.has(d.toLowerCase())) (definedBy.get(d) ?? definedBy.set(d, []).get(d)!).push(p);
  }
  const usedBy = new Map<string, string[]>();
  for (const p of paths) for (const w of map.files[p]!.words) {
    if (asked.has(w) || (w.length >= 6 && askedLower.has(w.toLowerCase()))) (usedBy.get(w) ?? usedBy.set(w, []).get(w)!).push(p);
  }

  const scored = new Map<string, Candidate>();
  const add = (p: string, s: number, name: string, def: boolean) => {
    const c = scored.get(p) ?? { path: p, score: 0, defines: [], uses: [] };
    c.score += s;
    const list = def ? c.defines : c.uses;
    if (!list.includes(name)) list.push(name);
    scored.set(p, c);
  };
  for (const [name, users] of usedBy) {
    const defs = definedBy.get(name) ?? [];
    // A name no file declares is an anchor only where the request writes it as code; otherwise
    // ordinary English ("drops", "Please", "Create") links unrelated files.
    if (!defs.length && !asCode.has(name)) continue;
    // Short plain words ("repo", "name", "data") are declared somewhere in most projects.
    if (/^[a-z]{1,4}$/.test(name)) continue;
    const linked = new Set([...users, ...defs]);
    // A name typed exactly as declared is the strongest signal there is, even in one file.
    if (linked.size < 2 && !(defs.length && asked.has(name))) continue;
    if (linked.size > Math.max(25, N * 0.05)) continue;
    const idf = Math.log(1 + N / linked.size) * weight(name);
    for (const p of defs) add(p, 2 * idf, name, true);
    // A plain word ("update", "select") that the request doesn't write as code points to the files
    // declaring it; every file that merely uses the word is noise.
    if (/^[a-z]+$/.test(name) && !asCode.has(name)) continue;
    // Docs, changelogs and CI config mention names in prose; tests use every name in an example.
    for (const p of users) if (!defs.includes(p)) add(p, PROSE.test(p) ? idf * 0.3 : TESTS.test(p) ? idf * 0.5 : idf, name, false);
  }
  // A request that names a file as a file ("fix utils.py", "src/cart", "the cart module"); a word
  // that only matches a stem ("tests", "query", "changelog") is not a file reference.
  const lower = signal.replace(URL, " ").toLowerCase();
  for (const p of paths) {
    const stem = basename(p, extname(p)).toLowerCase();
    if (stem.length < 5) continue;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w.])${esc}\\.[a-z]{1,5}\\b|/${esc}\\b|\\b${esc} (module|file|package)\\b`).test(lower)) add(p, Math.log(1 + N), stem, true);
  }
  for (const [p, w] of locations(paths, prompt)) add(p, Math.log(1 + N) * w, basename(p), true);
  // A file the request names by path leads, whatever the names around it add up to: a long issue
  // sums scores for the files that use many of its words, and the file it points at falls behind.
  const named = namedPaths(paths, signal);
  const lead = Math.max(0, ...[...scored.values()].map((c) => c.score));
  for (const p of named) {
    const c = scored.get(p) ?? { path: p, score: 0, defines: [], uses: [] };
    scored.set(p, { ...c, score: c.score + lead + 1, named: true });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k);
}

/**
 * Files a request locates directly, with a weight: frames of a traceback and dotted module paths.
 * A frame's path is matched to a project file by its longest suffix of two or more segments (an
 * installed copy, `/usr/lib/python3/site-packages/django/db/models/query.py`, is the project's
 * `django/db/models/query.py`). Following BRTracer (Wong et al., 2014), the frame nearest the error
 * counts most: a Python traceback lists it last, so the n-th project frame from the end weighs 1/n.
 * A dotted name (`django.db.models.lookups.Exact`) locates the file of its longest prefix that is a
 * module (`django/db/models/lookups.py`), weight 1. A package (`django.db`) locates nothing: its
 * `__init__.py` is named by every import line.
 */
export function locations(paths: string[], prompt: string): Map<string, number> {
  const bySuffix = new Map<string, string | null>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 0; i + 1 < segs.length; i++) {
      const s = segs.slice(i).join("/");
      bySuffix.set(s, bySuffix.has(s) && bySuffix.get(s) !== p ? null : p); // null: ambiguous
    }
  }
  const resolve = (raw: string): string | null => {
    const segs = raw.split(/[\\/]+/).filter(Boolean);
    for (let i = 0; i + 1 < segs.length; i++) {
      const hit = bySuffix.get(segs.slice(i).join("/"));
      if (hit) return hit;
      if (hit === null) return null;
    }
    return null;
  };
  const out = new Map<string, number>();
  const put = (p: string, w: number) => out.set(p, Math.max(out.get(p) ?? 0, w));
  const frames = [...prompt.matchAll(/File "([^"\n]+)", line \d+/g)].map((m) => resolve(m[1]!)).filter((p): p is string => !!p);
  const seen: string[] = [];
  for (const p of frames.reverse()) if (!seen.includes(p)) seen.push(p);
  seen.forEach((p, i) => put(p, 1 / (i + 1)));
  const files = new Set(paths);
  for (const m of prompt.replace(URL, " ").matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,8}\b/g)) {
    const parts = m[0].split(".");
    for (let n = parts.length; n >= 2; n--) {
      const base = parts.slice(0, n).join("/");
      if (files.has(`${base}.py`)) { put(`${base}.py`, 1); break; }
    }
  }
  return out;
}

/** The line handed to the agent: paths and why, never file contents. */
export function renderCandidates(cs: Candidate[]): string {
  if (!cs.length) return "";
  const why = (c: Candidate) => [c.named ? "named in the request" : "", c.defines.length ?`defines ${c.defines.slice(0, 3).join(", ")}` : "", c.uses.length ? `uses ${c.uses.slice(0, 3).join(", ")}` : ""].filter(Boolean).join("; ");
  return `snout map: files in this repo that define or use names in this request, most relevant first (candidates from a local index, not a plan): ${cs.map((c) => `${c.path} (${why(c)})`).join(" · ")}`;
}
