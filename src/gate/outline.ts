/**
 * A compact map of a withheld file, carried in the deny reason so the agent can often answer
 * from the reason itself — or go straight to the right lines — instead of spending a turn
 * searching. bench/ab.mjs measured the cost it removes: after a deny on a generated client,
 * agents took ~3 extra turns to find one function.
 *
 * The file is untrusted and the reason is model-visible, so nothing from the file reaches the
 * output except names that match a strict identifier or package-name pattern, and versions
 * that match a strict version pattern. Anything else is dropped, never escaped.
 *
 * Pure: no Node imports.
 */

/** Names past this are summarised as "+N more": the outline must stay far cheaper than the file. */
const MAX_ITEMS = 40;

const IDENT = /^[A-Za-z_$][\w$]{0,63}$/;
const PKG = /^(@[a-z0-9][\w.-]{0,62}\/)?[a-z0-9][\w.-]{0,63}$/i;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}([-+][\w.-]{1,40})?$/;

/** Top-level declarations per language: the names an agent would grep for. */
const DECLARATIONS: { ext: RegExp; pattern: RegExp }[] = [
  {
    ext: /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/,
    pattern: /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)|^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm,
  },
  { ext: /\.pyi?$/, pattern: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm },
  { ext: /\.go$/, pattern: /^(?:func\s+(?:\([^)\n]*\)\s*)?|type\s+)([A-Z]\w*)/gm },
  { ext: /\.rs$/, pattern: /^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_]\w*)/gm },
  { ext: /\.(java|kt|cs)$/, pattern: /^\s{0,4}public\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record|[\w<>\[\]]+)\s+([A-Za-z_]\w*)\s*[({<]/gm },
];

/**
 * The outline sentence for a withheld file, or "" when there is nothing useful to say.
 * `text` is the file's contents (the caller caps how much it reads).
 */
export function outline(relPath: string, rule: string, text: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return npmLockOutline(text);
  // A minified file is one line: line numbers would all read L1, and its names are mangled.
  if (rule === "minified" || rule === "secret" || rule === "binary" || rule === "crafted-path") return "";

  const decl = DECLARATIONS.find((d) => d.ext.test(base));
  if (!decl) return "";
  const lineStarts = starts(text);
  const items: string[] = [];
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

/** Direct dependencies and their installed versions: the usual reason to open a lockfile. */
function npmLockOutline(text: string): string {
  let lock: { packages?: Record<string, { version?: unknown; dependencies?: unknown; devDependencies?: unknown }> };
  try {
    lock = JSON.parse(text);
  } catch {
    return ""; // truncated or not JSON: say nothing rather than something half-right
  }
  const root = lock.packages?.[""];
  if (!root) return "";
  const names = [
    ...Object.keys((root.dependencies as object) ?? {}),
    ...Object.keys((root.devDependencies as object) ?? {}),
  ];
  const items: string[] = [];
  for (const name of names) {
    const v = lock.packages?.[`node_modules/${name}`]?.version;
    if (!PKG.test(name) || typeof v !== "string" || !VERSION.test(v)) continue;
    if (items.length < MAX_ITEMS) items.push(`${name} ${v}`);
  }
  if (items.length === 0) return "";
  const more = names.length > items.length ? ` (+${names.length - items.length} more)` : "";
  return ` Direct dependencies as installed: ${items.join(", ")}${more}.`;
}

function starts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

function lineOf(lineStarts: number[], index: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
