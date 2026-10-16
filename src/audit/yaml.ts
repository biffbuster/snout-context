/**
 * A small YAML reader for GitHub workflow files: block maps and lists, block scalars (| and >),
 * quoted and plain scalars, and flow lists and maps ([a, b], {a: b}). Anchors, tags and multi-line
 * plain scalars are not supported; workflows rarely use them, and an unreadable file is reported,
 * not guessed at. Scalars stay strings: `on:` is the key "on", `true` is "true".
 */
export type Yaml = string | Yaml[] | { [key: string]: Yaml } | null;

interface Line { indent: number; text: string; n: number }

/** Strip a trailing comment: a # at the start or after whitespace, outside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === q && !(q === '"' && s[i - 1] === "\\")) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:\[{,-]/.test(s[i - 1]!)) q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["\\])/g, "$1");
  if (s.startsWith("[") || s.startsWith("{")) return flow(s, { i: 0 });
  return s;
}

/** Flow collections: [a, b, {c: d}] and {a: b, c: [d]}. */
function flow(s: string, p: { i: number }): Yaml {
  const ws = () => { while (p.i < s.length && /\s/.test(s[p.i]!)) p.i++; };
  ws();
  const open = s[p.i];
  if (open === "[" || open === "{") {
    p.i++;
    const close = open === "[" ? "]" : "}";
    const list: Yaml[] = [];
    const map: Record<string, Yaml> = {};
    for (;;) {
      ws();
      if (s[p.i] === close) { p.i++; break; }
      if (p.i >= s.length) break;
      if (open === "[") list.push(flow(s, p));
      else {
        const key = atom(s, p, ":}");
        if (s[p.i] === ":") { p.i++; map[String(key ?? "")] = flow(s, p); } else map[String(key ?? "")] = null;
      }
      ws();
      if (s[p.i] === ",") p.i++;
    }
    return open === "[" ? list : map;
  }
  return atom(s, p, ",]}");
}

function atom(s: string, p: { i: number }, stops: string): Yaml {
  while (p.i < s.length && /\s/.test(s[p.i]!)) p.i++;
  const q = s[p.i];
  if (q === '"' || q === "'") {
    let j = p.i + 1;
    while (j < s.length && !(s[j] === q && s[j - 1] !== "\\")) j++;
    const v = scalar(s.slice(p.i, j + 1));
    p.i = j + 1;
    return v;
  }
  let j = p.i;
  while (j < s.length && !stops.includes(s[j]!) && !(s[j] === ":" && /\s|$/.test(s[j + 1] ?? ""))) j++;
  if (stops.includes(":") && s[j] === ":") { const v = s.slice(p.i, j).trim(); p.i = j; return v; }
  const v = scalar(s.slice(p.i, j));
  p.i = j;
  return v;
}

/** Index of the ": " (or trailing ":") that separates a key from its value, outside quotes; -1 if none. */
function keySplit(t: string): number {
  let q: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && i === 0) { q = c; continue; }
    if (c === "[" || c === "{") return -1;
    if (c === ":" && (i === t.length - 1 || t[i + 1] === " " || t[i + 1] === "\t")) return i;
  }
  return -1;
}

export function parseYaml(text: string): Yaml {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const lines: (Line & { raw: string })[] = [];
  raw.forEach((r, n) => {
    if (/^\s*(#|$)/.test(r) || /^(---|\.\.\.)\s*$/.test(r)) { lines.push({ indent: -1, text: "", n, raw: r }); return; }
    lines.push({ indent: r.length - r.trimStart().length, text: stripComment(r.trim()), n, raw: r });
  });
  const p = { i: 0 };
  const skip = () => { while (p.i < lines.length && lines[p.i]!.indent < 0) p.i++; };

  /** Lines of a block scalar after `key: |`, keeping their relative indentation. */
  function blockScalar(header: string, parent: number): string {
    const folded = header.startsWith(">");
    const keep = header.includes("+"), strip = header.includes("-");
    const body: string[] = [];
    let ind = -1;
    while (p.i < lines.length) {
      const l = lines[p.i]!;
      if (l.indent >= 0 && l.indent <= parent) break;
      if (l.indent < 0) { body.push(""); p.i++; continue; }
      if (ind < 0) ind = l.indent;
      body.push(l.raw.slice(Math.min(ind, l.indent)));
      p.i++;
    }
    while (!keep && body.length && body[body.length - 1] === "") body.pop();
    const out = folded ? body.join("\n").replace(/([^\n])\n(?=[^\n ])/g, "$1 ") : body.join("\n");
    return strip ? out : out + "\n";
  }

  function value(rest: string, indent: number): Yaml {
    const v = rest.trim();
    if (/^[|>][-+0-9]*$/.test(v)) return blockScalar(v, indent);
    if (v === "") {
      skip();
      const next = lines[p.i];
      if (!next) return null;
      // A list may sit at the same indent as its key.
      if (next.indent > indent || (next.indent === indent && (next.text.startsWith("- ") || next.text === "-"))) return block(next.indent);
      return null;
    }
    return scalar(v);
  }

  function block(indent: number): Yaml {
    skip();
    const first = lines[p.i];
    if (!first) return null;
    if (first.text === "-" || first.text.startsWith("- ")) {
      const list: Yaml[] = [];
      while (p.i < lines.length) {
        skip();
        const l = lines[p.i];
        if (!l || l.indent !== indent || !(l.text === "-" || l.text.startsWith("- "))) break;
        const inner = l.text === "-" ? "" : l.text.slice(2);
        const innerIndent = indent + (l.text.length - l.text.slice(1).trimStart().length);
        p.i++;
        if (inner === "") { list.push(value("", indent)); continue; }
        const k = keySplit(inner);
        if (k >= 0 && !/^["'[{]/.test(inner)) {
          // "- key: v" opens a map whose further keys sit at innerIndent.
          const map: Record<string, Yaml> = {};
          map[unquote(inner.slice(0, k))] = value(inner.slice(k + 1), innerIndent);
          Object.assign(map, mapAt(innerIndent));
          list.push(map);
        } else list.push(value(inner, indent));
      }
      return list;
    }
    return mapAt(indent);
  }

  function mapAt(indent: number): Record<string, Yaml> {
    const map: Record<string, Yaml> = {};
    while (p.i < lines.length) {
      skip();
      const l = lines[p.i];
      if (!l || l.indent !== indent || l.text.startsWith("- ") || l.text === "-") break;
      const k = keySplit(l.text);
      p.i++;
      if (k < 0) continue; // not a key: tolerated, ignored
      map[unquote(l.text.slice(0, k))] = value(l.text.slice(k + 1), indent);
    }
    return map;
  }

  skip();
  return lines[p.i] ? block(lines[p.i]!.indent) : null;
}

const unquote = (k: string) => { const s = k.trim(); return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s; };

/** Helpers for reading a parsed document. */
export const asMap = (v: Yaml | undefined): Record<string, Yaml> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
export const asList = (v: Yaml | undefined): Yaml[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
export const asStr = (v: Yaml | undefined): string => (typeof v === "string" ? v : "");
