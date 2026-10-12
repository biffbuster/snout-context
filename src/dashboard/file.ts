/**
 * One file as Snout sees it, for the dashboard's report card: its label and confidence, what a
 * trimmed read would send (the head), the outline Snout attaches, and the search hint. The same
 * pieces `snout_read` uses, so the card shows what the agent would actually get.
 *
 * Only files inside the project, and never the contents of a secret or a binary.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import { bandOf, searchHint } from "../gate/decide.js";
import { outline } from "../gate/outline.js";
import { tier0 } from "../gate/tier0.js";
import { estimateTokens } from "../ledger/tokens.js";

/** What a trimmed read sends: the same head as the gate and snout_read. */
const HEAD_LINES = 60;
const HEAD_BYTES = 6 * 1024;
/** Files past this are summarised from their head only. */
const MAX_BYTES = 4 * 1024 * 1024;

export interface OutlineItem {
  name: string;
  /** A version for a dependency, the declaration keyword for code. */
  detail: string;
  line: number | null;
  kind: "dependency" | "declaration";
}

export interface FileReport {
  path: string;
  tokens: number;
  lines: number;
  label: string;
  confidence: number;
  band: string;
  reason: string;
  /** The head a trimmed read sends, or null when the file would be read whole or has none (one long line). */
  head: { lines: number; tokens: number } | null;
  outline: OutlineItem[];
  /** Outline entries past the ones listed. */
  more: number;
  hint: string;
}

export function fileReport(projectDir: string, path: string, cfg: Config): FileReport {
  const abs = resolve(isAbsolute(path) ? path : join(projectDir, path));
  const rel = relative(projectDir, abs).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("outside the project");
  const st = statSync(abs);
  if (!st.isFile()) throw new Error("not a file");
  const d = tier0({ absPath: abs, projectDir, cfg });
  const label = d && d.value <= 1 ? d.rule : "source";
  const base = { path: rel, tokens: estimateTokens(st.size, rel), label, confidence: d?.confidence ?? 0, band: bandOf(d), reason: d?.reason ?? "" };
  if (label === "secret" || label === "binary" || label === "binary-content") return { ...base, lines: 0, head: null, outline: [], more: 0, hint: "" };

  const text = readFileSync(abs, "utf8").slice(0, MAX_BYTES);
  const lines = text.split("\n");
  const oneLine = st.size / Math.max(1, lines.length) > 1000;
  let head: FileReport["head"] = null;
  if (label !== "source" && !oneLine) {
    let used = 0, n = 0;
    for (const l of lines.slice(0, HEAD_LINES)) {
      if (used + l.length + 1 > HEAD_BYTES) break;
      used += l.length + 1;
      n++;
    }
    head = { lines: n, tokens: estimateTokens(used, rel) };
  }
  const { items, more } = parseOutline(outline(rel, label, text), text, lines);
  const cmd = /`([^`]+)`/.exec(searchHint(label, rel, { oneLine }))?.[1] ?? "";
  return { ...base, lines: lines.length, head, outline: items, more, hint: cmd };
}

/** outline() writes a sentence for the agent; the card wants rows. Its formats are fixed and strict. */
function parseOutline(sentence: string, text: string, lines: string[]): { items: OutlineItem[]; more: number } {
  const more = Number(/\(\+(\d+) more\)/.exec(sentence)?.[1] ?? 0);
  if (sentence.includes("Direct dependencies")) {
    const body = sentence.slice(sentence.indexOf(":") + 1);
    const items: OutlineItem[] = [];
    for (const m of body.matchAll(/(@?[\w.\/-]+) (\d+\.\d+\.\d+(?:[-+][\w.-]*[\w])?)/g)) {
      const at = text.indexOf(`"node_modules/${m[1]}"`);
      items.push({ name: m[1]!, detail: m[2]!, line: at < 0 ? null : text.slice(0, at).split("\n").length, kind: "dependency" });
    }
    return { items, more };
  }
  const items: OutlineItem[] = [];
  for (const m of sentence.matchAll(/([A-Za-z_$][\w$]*) L(\d+)/g)) {
    const line = Number(m[2]);
    const src = lines[line - 1] ?? "";
    const kw = /\b(function|class|interface|type|enum|const|let|var|def|struct|trait|fn)\b/.exec(src)?.[1] ?? "";
    items.push({ name: m[1]!, detail: kw, line, kind: "declaration" });
  }
  return { items, more };
}
