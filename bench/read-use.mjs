#!/usr/bin/env node
/**
 * What agents use of the large files they read, from Claude Code's session logs on this machine.
 * Nothing is sent anywhere and nothing is changed.
 *
 * For each Read that returned at least --min-tokens (default 2,000) of text, the rest of that context
 * (until a compaction or the session's end) is searched for evidence of which of its lines were used:
 *   edited     an Edit of the file whose old_string is on those lines
 *   named      a distinctive name from the file (a word of 5+ characters on at most 3 of its lines)
 *              written later by the agent: in its text, a command, an edit, a search
 *   reread     a later, narrower Read or ranged print of those lines
 * Lines without evidence may still have been read and understood, so "used" is a lower bound. The
 * span from the first to the last used line, with --margin lines either side (default 20), is the
 * window a targeted read would have needed: an upper bound on what the agent needed.
 *
 *   node bench/read-use.mjs [--claude dir,...] [--min-tokens 2000] [--margin 20] [--min-requests 20] [--examples]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MIN_TOKENS = Number(flag("--min-tokens", 2000));
const MARGIN = Number(flag("--margin", 20));
const MIN_REQUESTS = Number(flag("--min-requests", 20));
/**
 * Characters per token. Calibrated on 2026-10-30 from 556 pairs of consecutive Claude Code requests
 * on this machine: real input growth against the characters added between them, median 2.25 (p25
 * 2.02, p75 2.42). Four per token, the usual rule, undercounted code and JSON by about 1.8 times.
 */
const CHARS_PER_TOKEN = Number(flag("--chars-per-token", 2.25));
const tok = (s) => Math.ceil(String(s ?? "").length / CHARS_PER_TOKEN);
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl") && !/[\\/]subagents[\\/]/.test(f)).map((f) => join(dir, f)) : []);
const rows = (f) => readFileSync(f, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
const norm = (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase();
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "");

/** A Read's result as numbered lines: "   12→text" or "12\ttext". */
function numbered(text) {
  const out = new Map();
  for (const l of text.split("\n")) {
    const m = /^\s*(\d+)[\t→](.*)$/.exec(l);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}
const kindOf = (p) => {
  const e = extname(p).toLowerCase();
  if (/\.(md|mdx|txt|rst)$/.test(e)) return "docs";
  if (/\.(json|jsonl|ya?ml|toml|csv|lock)$/.test(e)) return "data and config";
  if (/\.(log|out)$/.test(e)) return "logs";
  if (/test|spec/.test(p.split("/").pop() ?? "")) return "tests";
  return "source";
};

function analyze(file, result, examples) {
  const ev = rows(file).filter((o) => !o.isSidechain);
  const requests = new Set(ev.filter((o) => o.type === "assistant").map((o) => o.requestId ?? o.message?.id)).size;
  if (requests < MIN_REQUESTS) return;
  result.sessions++;
  const tools = new Map();
  // Every assistant output and later read, in order, with compactions marked.
  const stream = [];
  for (const o of ev) {
    if ((o.type === "system" && /compact/.test(String(o.subtype ?? ""))) || (o.type === "user" && o.isCompactSummary)) { stream.push({ compact: true }); continue; }
    if (o.type === "assistant") for (const b of o.message?.content ?? []) {
      if (b.type === "text") stream.push({ said: b.text });
      if (b.type === "tool_use") { tools.set(b.id, b); stream.push({ said: JSON.stringify(b.input ?? {}), use: b }); }
    }
    if (o.type === "user" && Array.isArray(o.message?.content)) for (const b of o.message.content) {
      if (b.type !== "tool_result") continue;
      const use = tools.get(b.tool_use_id);
      if (use?.name === "Read" && o.toolUseResult?.type !== "image") stream.push({ read: { path: norm(use.input?.file_path), text: textOf(b.content), offset: Number(use.input?.offset) || 1, limit: Number(use.input?.limit) || 0 } });
    }
  }
  for (let i = 0; i < stream.length; i++) {
    const r = stream[i].read;
    if (!r || tok(r.text) < MIN_TOKENS) continue;
    const lines = numbered(r.text);
    if (lines.size < 20) continue;
    // A file already read whole earlier in this context is a reread, not a first read.
    if (stream.slice(0, i).some((x, j) => x.read?.path === r.path && !stream.slice(j, i).some((y) => y.compact))) continue;
    const used = { edited: new Set(), named: new Set(), reread: new Set() };
    // Distinctive names: words of 5+ characters that appear on at most 3 of the read's lines.
    const where = new Map();
    for (const [n, l] of lines) for (const w of new Set(l.match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) ?? [])) { const s = where.get(w) ?? new Set(); s.add(n); where.set(w, s); }
    const distinctive = new Map([...where].filter(([, s]) => s.size <= 3));
    const content = [...lines.values()];
    const first = [...lines.keys()][0];
    for (let j = i + 1; j < stream.length && !stream[j].compact; j++) {
      const x = stream[j];
      if (x.use && /^(Edit|MultiEdit)$/.test(x.use.name) && norm(x.use.input?.file_path) === r.path) {
        for (const e of x.use.name === "MultiEdit" ? x.use.input?.edits ?? [] : [x.use.input]) {
          const old = String(e?.old_string ?? "").split("\n")[0].trim();
          if (old.length < 4) continue;
          const at = content.findIndex((l) => l.includes(old));
          if (at >= 0) for (let k = 0; k < String(e.old_string).split("\n").length; k++) used.edited.add(first + at + k);
        }
      }
      if (x.read && x.read.path === r.path) for (const n of numbered(x.read.text).keys()) if (lines.has(n)) used.reread.add(n);
      if (x.said) for (const w of new Set(x.said.match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) ?? [])) for (const n of distinctive.get(w) ?? []) used.named.add(n);
    }
    const all = new Set([...used.edited, ...used.named, ...used.reread]);
    const lineTok = (n) => tok(lines.get(n) ?? "") + 2;
    const total = [...lines.keys()].reduce((a, n) => a + lineTok(n), 0);
    const usedTok = [...all].reduce((a, n) => a + lineTok(n), 0);
    const sorted = [...all].sort((a, b) => a - b);
    const spanTok = sorted.length ? [...lines.keys()].filter((n) => n >= sorted[0] - MARGIN && n <= sorted.at(-1) + MARGIN).reduce((a, n) => a + lineTok(n), 0) : 0;
    const k = kindOf(r.path);
    const s = (result.byKind[k] ??= { reads: 0, tokens: 0, usedTokens: 0, spanTokens: 0, noEvidence: 0, edited: 0 });
    s.reads++; s.tokens += total; s.usedTokens += usedTok; s.spanTokens += spanTok; if (!all.size) s.noEvidence++; if (used.edited.size) s.edited++;
    result.reads.push({ path: r.path, kind: k, lines: lines.size, tokens: total, usedLines: all.size, usedTokens: usedTok, spanTokens: spanTok, edited: used.edited.size, named: used.named.size, reread: used.reread.size, whole: !r.limit });
    if (examples) examples.push(result.reads.at(-1));
  }
}

const dirs = (flag("--claude") ?? "").split(",").filter(Boolean);
const files = (dirs.length ? dirs : [join(homedir(), ".claude", "projects")]).flatMap(walk);
const result = { sessions: 0, byKind: {}, reads: [] };
const examples = args.includes("--examples") ? [] : null;
for (const f of files) { try { analyze(f, result); } catch (err) { console.error(`skipped ${f}: ${err.message}`); } }

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const all = Object.values(result.byKind).reduce((a, s) => ({ reads: a.reads + s.reads, tokens: a.tokens + s.tokens, usedTokens: a.usedTokens + s.usedTokens, spanTokens: a.spanTokens + s.spanTokens, noEvidence: a.noEvidence + s.noEvidence, edited: a.edited + s.edited }), { reads: 0, tokens: 0, usedTokens: 0, spanTokens: 0, noEvidence: 0, edited: 0 });
console.log(`Claude Code: ${result.sessions} sessions with ${MIN_REQUESTS}+ requests; first reads of ${fmt(MIN_TOKENS)}+ tokens of text: ${all.reads} (${fmt(all.tokens)} tokens)`);
console.log(`  lines with evidence of use: ${pct(all.usedTokens, all.tokens)} of those tokens; the span around them (±${MARGIN} lines): ${pct(all.spanTokens, all.tokens)}; reads with no evidence at all: ${all.noEvidence}; reads followed by an edit of the file: ${all.edited}`);
console.log("  by kind of file:");
for (const [k, s] of Object.entries(result.byKind).sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`    ${k.padEnd(16)} ${String(s.reads).padStart(4)} reads ${fmt(s.tokens).padStart(7)} tokens · used ${pct(s.usedTokens, s.tokens).padStart(4)} · span ${pct(s.spanTokens, s.tokens).padStart(4)} · no evidence ${s.noEvidence} · edited after ${s.edited}`);
}
const buckets = [[2000, 5000], [5000, 10000], [10000, 25000], [25000, Infinity]];
console.log("  by size of the read:");
for (const [a, b] of buckets) {
  const rs = result.reads.filter((r) => r.tokens >= a && r.tokens < b);
  const t = rs.reduce((x, r) => x + r.tokens, 0), u = rs.reduce((x, r) => x + r.usedTokens, 0), sp = rs.reduce((x, r) => x + r.spanTokens, 0);
  console.log(`    ${`${fmt(a)}–${b === Infinity ? "" : fmt(b)}`.padEnd(12)} ${String(rs.length).padStart(4)} reads ${fmt(t).padStart(7)} tokens · used ${pct(u, t).padStart(4)} · span ${pct(sp, t).padStart(4)} · no evidence ${rs.filter((r) => !r.usedLines).length}`);
}
if (examples) for (const r of examples.sort((a, b) => b.tokens - a.tokens).slice(0, 25)) console.log(JSON.stringify(r));
