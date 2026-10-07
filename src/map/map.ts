/**
 * Repo map: names that recur across a project's files, each linked to the files that define or
 * use it, built once and reused for every request. Given a request, the files linked to the names
 * it mentions are offered as candidate paths, so the agent can open the right files instead of
 * rediscovering them by search.
 *
 * The design follows CorpusMap (Jeong et al., 2026, arXiv:2609.37226) for code:
 * - names, not documents, are the anchors; a name links files only when two or more share it,
 *   except a name the request types exactly as declared, which points to its declaring file;
 *   plain lowercase words count only when some file declares them;
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
}

const TEXT_EXT = /\.(m?js|cjs|jsx|ts|tsx|mts|cts|py|pyi|go|rs|java|kt|kts|cs|rb|php|swift|scala|c|cc|cpp|h|hpp|m|mm|ex|exs|erl|clj|lua|sh|bash|zsh|sql|graphql|proto|vue|svelte|astro|md|mdx|rst|txt|toml|ya?ml|json|ini|cfg|conf|env\.example|html|css|scss)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", "third_party", "coverage", ".next", ".venv", "venv", "__pycache__", ".snout", ".claude", ".tox", ".mypy_cache", ".pytest_cache"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;
const MAX_WORDS = 3000;

const WORD = /[A-Za-z_][A-Za-z0-9_]{3,63}/g;
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
 * Files linked to the names a request mentions, best first. A file that declares a name scores
 * more than one that only uses it; rarer names score more (inverse document frequency). Names
 * linked to only one file, or to too large a share of the project, are not anchors.
 */
export function candidates(map: RepoMap, prompt: string, k = 15): Candidate[] {
  const paths = Object.keys(map.files);
  const N = paths.length;
  if (!N) return [];
  const asked = requestNames(prompt);
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
    // A plain lowercase word ("drops", "config") is an anchor only if some file declares it;
    // otherwise ordinary English in the request links unrelated files.
    if (!defs.length && /^[a-z]+$/.test(name)) continue;
    // Short plain words ("repo", "name", "data") are declared somewhere in most projects.
    if (/^[a-z]{1,4}$/.test(name)) continue;
    const linked = new Set([...users, ...defs]);
    // A name typed exactly as declared is the strongest signal there is, even in one file.
    if (linked.size < 2 && !(defs.length && asked.has(name))) continue;
    if (linked.size > Math.max(25, N * 0.05)) continue;
    const idf = Math.log(1 + N / linked.size);
    for (const p of defs) add(p, 2 * idf, name, true);
    // Docs, changelogs and CI config mention names in prose; they rank below code that uses them.
    for (const p of users) if (!defs.includes(p)) add(p, PROSE.test(p) ? idf * 0.3 : idf, name, false);
  }
  // A request that names a file directly ("fix utils.py", "the cart module").
  for (const p of paths) {
    const stem = basename(p, extname(p)).toLowerCase();
    if (stem.length >= 5 && (asked.has(stem) || [...asked].some((a) => a.toLowerCase() === stem))) add(p, Math.log(1 + N), stem, true);
  }
  return [...scored.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k);
}

/** The line handed to the agent: paths and why, never file contents. */
export function renderCandidates(cs: Candidate[]): string {
  if (!cs.length) return "";
  const why = (c: Candidate) => [c.defines.length ? `defines ${c.defines.slice(0, 3).join(", ")}` : "", c.uses.length ? `uses ${c.uses.slice(0, 3).join(", ")}` : ""].filter(Boolean).join("; ");
  return `snout map: files in this repo that define or use names in this request, most relevant first (candidates from a local index, not a plan): ${cs.map((c) => `${c.path} (${why(c)})`).join(" · ")}`;
}
