#!/usr/bin/env node
/**
 * Compaction retention: what share of the facts a session established survives each compaction,
 * with Claude Code's own summary alone and with Snout's restored memory added. Offline and free:
 * it reads transcripts that already contain compactions.
 *
 * Facts are taken from the transcript independently of Snout:
 *   rule  — an instruction the user wrote (a sentence that starts with always, never, don't, make sure…)
 *   test  — the last command that ran the project's tests with a test-count result
 *   file  — a file the agent edited or wrote
 *   tool  — a module or command that was missing
 *   goal  — the session's first request (the task)
 *   error — the last error a command printed with no passing test run or clean rerun after it
 * A fact counts as kept when the post-compaction context contains it: verbatim (normalized text) or,
 * for rules, loosely (at least 75% of its content words appear).
 *
 *   node bench/retention.mjs [transcripts…]          # default: every transcript under ~/.claude/projects with a compaction
 *   node bench/retention.mjs --json
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const LIB = process.env.SNOUT_LIB || fileURLToPath(new URL("../dist/lib.mjs", import.meta.url));
const { sessionFacts, memoryText } = await import(pathToFileURL(LIB).href);

const args = process.argv.slice(2);
const json = args.includes("--json");
let files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  const root = join(homedir(), ".claude/projects");
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      if (readFileSync(p, "utf8").includes('"compact_boundary"')) files.push(p);
    }
  }
}

// An instruction, not a sentence from a pasted issue: it starts with the constraint.
const RULE = /^(?:(?:please|also|and|but|so|ok(?:ay)?|now|then|again|remember|note)[,:]?\s+)*(always|never|don'?t|do not|must|only|make sure|ensure|avoid|keep|no new|ask (?:me )?(?:first|before)|use |run |stop |leave |strip |remove |commit|push)\b/i;
const RAN = /\b\d+ (passed|failed|errors?|skipped)\b|\bRan \d+ tests?\b|^OK\b|\bOK \(|^FAILED\b|\bTests?:\s+\d+/m;
const TESTWORD = /\b(pytest|runtests\.py|bin\/test|jest|vitest|mocha|go test|cargo test|npm (run )?test|node --test|rspec|tox|unittest|manage\.py test)\b/;
const MISSING = [/No module named '?([\w.]+)'?/, /(?:^|\s)([\w.-]+): command not found/m];
const ERROR_LINE = /^(?:[\w.]+(?:Error|Exception)\b(?::.*)?|(?:FAILED|ERROR) [\w./:\[\]-]+.*|(?:FAIL|ERROR): \w+ \(.*|error\[\w+\]: .+|[^\s:]+:\d+(?::\d+)?: error: .+|(?:\S+:\s+)?error TS\d+: .+)$/;
const PRINTS = /^(cat|grep|rg|sed|awk|head|tail|echo|printf|ls|find)\b/;
const STOP = new Set("this that with from have will what when then than they them there their your about into just also only make sure should would could must never always dont keep avoid without these those which while where after before being been were does doing done each very more most other some such like".split(" "));

const norm = (s) => s.toLowerCase().replace(/[`'"*_]/g, "").replace(/\s+/g, " ").trim();
const words = (s) => [...new Set(norm(s).split(/[^a-z0-9.\/-]+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
const textOf = (o) => {
  const c = o.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => b.type === "text" ? b.text : b.type === "tool_use" ? JSON.stringify(b.input ?? {}) : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")) : "").join("\n");
};
const userWords = (o) => {
  const queued = o.type === "attachment" && o.attachment?.type === "queued_command" && typeof o.attachment.prompt === "string";
  if (!queued && (o.type !== "user" || o.isMeta || o.isCompactSummary)) return "";
  const c = o.message?.content;
  const t = queued ? o.attachment.prompt : typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
  if (/^\s*<(command-|local-command|system-reminder)/.test(t)) return "";
  return t.replace(/<\\?pasted_content\b[^>]*>[\s\S]*?(<\\?\/pasted_content>|$)/g, " ").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").replace(/<issue>[\s\S]*?(<\/issue>|$)/g, " ");
};

function factsBefore(entries, end, cwd) {
  const facts = new Map();
  const uses = new Map();
  let goal = "", error;
  const rel = (p) => (isAbsolute(p) && cwd && !relative(cwd, p).startsWith("..") ? relative(cwd, p) : p);
  for (let i = 0; i < end; i++) {
    const o = entries[i];
    if (!o || o.isSidechain || o.type === "system") continue;
    const said = userWords(o).replace(/\s+/g, " ").trim();
    if (!goal && said.length >= 15 && !/^<\\?[\w-]/.test(said)) goal = said.slice(0, 300);
    for (const s of userWords(o).split(/(?<=[.!?])\s+|\n+/)) {
      const t = s.trim();
      if (t.length >= 20 && t.length <= 300 && RULE.test(t) && words(t).length >= 3) facts.set(`rule:${norm(t)}`, { kind: "rule", text: t });
    }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === "tool_use") {
        uses.set(b.id, b);
        const f = b.input?.file_path;
        if (["Edit", "Write", "MultiEdit"].includes(b.name) && typeof f === "string") facts.set(`file:${f}`, { kind: "file", text: rel(f) });
      } else if (b.type === "tool_result") {
        const u = uses.get(b.tool_use_id);
        if (u?.name !== "Bash") continue;
        const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        const cmd = String(u.input?.command ?? "");
        for (const re of MISSING) { const m = out.match(re); if (m) facts.set(`tool:${m[1]}`, { kind: "tool", text: m[1] }); }
        const passed = RAN.test(out) && !/\b[1-9]\d* (failed|errors?)\b|FAILED|\b(failures|errors)=\d/i.test(out);
        const line = PRINTS.test(cmd.trim()) ? undefined : out.split("\n").map((l) => l.trim()).reverse().find((l) => ERROR_LINE.test(l));
        if (line && !passed) error = { cmd, line };
        else if (passed || error?.cmd === cmd) error = undefined;
        if (RAN.test(out) && TESTWORD.test(cmd.replace(/"[^"]*"|'[^']*'/g, ""))) {
          for (const k of [...facts.keys()]) if (k.startsWith("test:")) facts.delete(k);
          const core = cmd.split(/&&|;|\n/).map((s) => s.trim()).find((s) => TESTWORD.test(s)) ?? cmd;
          facts.set(`test:${core}`, { kind: "test", text: core.replace(/\s*2>&1.*$/, "").replace(/\s*\|.*$/, "").trim() });
        }
      }
    }
  }
  if (goal.split(" ").length >= 4) facts.set("goal", { kind: "goal", text: goal });
  if (error) facts.set("error", { kind: "error", text: error.line.slice(0, 200) });
  return [...facts.values()];
}

function kept(fact, context) {
  const C = norm(context);
  if (fact.kind === "file") return { exact: C.includes(norm(fact.text)) || C.includes(norm(basename(fact.text))), loose: C.includes(norm(basename(fact.text))) };
  if (fact.kind === "error") { const e = C.includes(norm(fact.text)); return { exact: e, loose: e || C.includes(norm(fact.text).slice(0, 60)) }; }
  if (fact.kind === "tool") return { exact: C.includes(norm(fact.text)), loose: C.includes(norm(fact.text)) };
  const exact = C.includes(norm(fact.text));
  const w = words(fact.text);
  const loose = exact || (w.length > 0 && w.filter((x) => C.includes(x)).length / w.length >= 0.75);
  return { exact, loose };
}

const tmp = mkdtempSync(join(tmpdir(), "snout-retention-"));
const rows = []; // one per (session, compaction round, fact)
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } });
  const byUuid = new Map(entries.filter(Boolean).map((o) => [o.uuid, o]));
  const bounds = entries.map((o, i) => (o?.subtype === "compact_boundary" ? i : -1)).filter((i) => i >= 0);
  if (!bounds.length) continue;
  const cwd = entries.find((o) => o?.cwd)?.cwd ?? "";
  const real = !/snout-long|snout-swe/.test(file);
  const first = factsBefore(entries, bounds[0], cwd);
  bounds.forEach((b, k) => {
    // Claude Code's post-compaction context: the summary, the messages it kept verbatim, its attachments.
    const meta = entries[b].compactMetadata ?? {};
    const preserved = (meta.preservedMessages?.uuids ?? []).map((u) => byUuid.get(u)).filter(Boolean).map(textOf);
    const after = [];
    let snoutInjected = "";
    for (let i = b + 1; i < entries.length; i++) {
      const o = entries[i];
      if (!o) continue;
      if (o.type === "assistant") break;
      if (o.isCompactSummary) after.push(textOf(o));
      else if (o.type === "attachment") {
        const r = (o.rendered ?? []).map((x) => x.content ?? "").join("\n");
        if (/Snout restored/.test(r) || /Snout restored/.test(JSON.stringify(o.attachment ?? {}))) snoutInjected = r || JSON.stringify(o.attachment);
        else after.push(r);
      }
    }
    const cc = [...after, ...preserved].join("\n");
    // Snout's memory from the current build, computed on the transcript up to this compaction.
    const prefix = join(tmp, `p${rows.length}.jsonl`);
    writeFileSync(prefix, lines.slice(0, b).join("\n") + "\n");
    const snout = memoryText(sessionFacts(prefix, cwd), [], cwd);
    const facts = factsBefore(entries, b, cwd);
    for (const f of facts) {
      const a = kept(f, cc), s = kept(f, `${cc}\n${snout}`);
      const fromFirst = first.some((x) => x.kind === f.kind && x.text === f.text);
      rows.push({ file: basename(file), real, round: k + 1, fromFirst, kind: f.kind, text: f.text.slice(0, 160), ccExact: a.exact, ccLoose: a.loose, snoutExact: s.exact, snoutLoose: s.loose, injected: !!snoutInjected });
    }
  });
}
rmSync(tmp, { recursive: true, force: true });

const pct = (xs, key) => (xs.length ? `${Math.round((100 * xs.filter((r) => r[key]).length) / xs.length)}%` : "—");
// Written synchronously: process.exit would cut a piped console.log short.
if (json) { writeFileSync(1, JSON.stringify(rows, null, 1) + "\n"); process.exit(0); }
console.log(`${files.length} transcripts, ${new Set(rows.map((r) => r.file + r.round)).size} compactions, ${rows.length} fact checks\n`);
const table = (title, xs) => {
  console.log(title);
  console.log("  kind   n     CC exact  CC loose   +Snout exact  +Snout loose");
  for (const kind of ["rule", "test", "file", "tool", "goal", "error", "all"]) {
    const s = kind === "all" ? xs : xs.filter((r) => r.kind === kind);
    if (!s.length) continue;
    console.log(`  ${kind.padEnd(6)} ${String(s.length).padEnd(5)} ${pct(s, "ccExact").padEnd(9)} ${pct(s, "ccLoose").padEnd(10)} ${pct(s, "snoutExact").padEnd(13)} ${pct(s, "snoutLoose")}`);
  }
  console.log();
};
table("All compactions, facts from before each compaction:", rows);
table("Benchmark sessions:", rows.filter((r) => !r.real));
table("Real sessions:", rows.filter((r) => r.real));
console.log("Cliff: facts from before the FIRST compaction, by round (loose):");
for (let k = 1; k <= Math.max(...rows.map((r) => r.round)); k++) {
  const s = rows.filter((r) => r.fromFirst && r.round === k);
  if (s.length < 5) continue;
  const rules = s.filter((r) => r.kind === "rule");
  console.log(`  round ${k}: n=${s.length}  CC ${pct(s, "ccLoose")}  +Snout ${pct(s, "snoutLoose")}   rules n=${rules.length} CC ${pct(rules, "ccLoose")} +Snout ${pct(rules, "snoutLoose")}`);
}
