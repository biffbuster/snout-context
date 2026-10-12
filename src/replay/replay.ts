/**
 * Replay: run a recorded session's tool calls through Snout's real hook handlers, offline, and
 * measure what Snout would have done. Model-free and local: nothing is sent anywhere, and the
 * handlers write to a temporary .snout directory, never the project's.
 *
 * Three measures per session:
 *   - savings   tokens Snout keeps out of a call, and the same tokens carried on every later
 *               request until the next compaction (a token kept out of turn 10 of 160 is not
 *               re-read 150 times). Compared with the input the session actually used.
 *   - regret    how often what was kept out was needed after all: the agent later read or edited
 *               a file Snout held back, or re-ran a command whose output Snout trimmed. The
 *               false-positive rate of every gate, on real work.
 *   - memory    at each compaction: did the restored test command match the test runs that came
 *               next, and did the restored file list cover the files edited next.
 *
 * It cannot say whether the agent would still have finished the task: an agent that sees less
 * acts differently. That takes a live run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { estimateTokens } from "../ledger/tokens.js";
import { memoryText, sessionFacts, testCommand } from "../compact/memory.js";

/** The hook handlers, run in-process; each returns the hook's JSON answer or null. */
export interface HookRunner {
  pre(input: Record<string, unknown>): Record<string, any> | null;
  squeeze(input: Record<string, unknown>): Record<string, any> | null;
  post(input: Record<string, unknown>): void;
}

export interface SessionReplay {
  session: string;
  file: string;
  projectDir: string;
  /** Files rebuilt from the transcript because the project is no longer on disk (0: judged on disk). */
  rebuilt: number;
  calls: number;
  requests: number;
  /** Input the session used: uncached + cache writes + cache reads, all requests. */
  inputTokens: number;
  /** Tokens kept out at the call (gate denials, repeat skips, trimmed output), net of Snout's own notes. */
  keptOut: number;
  /** keptOut carried over the later requests up to the next compaction. */
  carried: number;
  denied: number;
  /** Reads Snout let through narrowed (the head of a generated file, one section of a long doc). */
  narrowed: number;
  /** Re-reads of an unchanged file, answered with a pointer to the copy already in context. */
  repeats: number;
  asked: number;
  trimmed: number;
  /** Notes Snout added to the agent's context, in tokens. */
  added: number;
  regrets: number;
  /** Interventions that could regret (denials and trims). */
  interventions: number;
  compactions: number;
  memory: { withTest: number; testUsed: number; testMissed: number; editsAfter: number; editsListed: number; chars: number };
  examples: { regret: string[]; kept: string[] };
}

const tokens = (text: string) => estimateTokens(Buffer.byteLength(text), "output.txt");
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n") : "";
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** A command without its leading `cd <dir> &&` / `;`, which most commands in a session share. */
const withoutCd = (c: string) => c.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "");

interface Line { o: any; raw: string }

function readLines(file: string): Line[] {
  const out: Line[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw) continue;
    try { out.push({ o: JSON.parse(raw), raw }); } catch { /* a torn last line */ }
  }
  return out;
}

/** The project a session worked in: the cwd it recorded most often. */
function projectOf(lines: Line[]): string {
  const counts = new Map<string, number>();
  for (const { o } of lines) if (typeof o.cwd === "string") counts.set(o.cwd, (counts.get(o.cwd) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? process.cwd();
}

/**
 * A stand-in for a project that is no longer on disk (another tool's published runs, a deleted
 * benchmark checkout): every file the session read, rebuilt from the copy the transcript recorded,
 * so the real gate judges the same bytes the agent saw. Lines the session never read are filled
 * with lines of the same average length, so sizes stay close; their content is unknown.
 */
function shadowProject(lines: Line[], projectDir: string): { root: string; files: number } {
  const root = mkdtempSync(join(tmpdir(), "snout-replay-project-"));
  const best = new Map<string, { content: string; start: number; total: number }>();
  for (const { o } of lines) {
    const f = o.toolUseResult?.file;
    if (!f || typeof f.filePath !== "string" || typeof f.content !== "string") continue;
    const r = relative(projectDir, f.filePath);
    if (!r || r.startsWith("..") || isAbsolute(r)) continue;
    const prev = best.get(r);
    if (!prev || f.content.length > prev.content.length) best.set(r, { content: f.content, start: Number(f.startLine) || 1, total: Number(f.totalLines) || 0 });
  }
  for (const [r, f] of best) {
    const known = f.content.split("\n");
    const avg = Math.max(1, Math.round(f.content.length / Math.max(1, known.length)));
    const filler = "x".repeat(avg);
    const total = Math.max(f.total, f.start - 1 + known.length);
    const out = Array.from({ length: total }, (_, i) => (i >= f.start - 1 && i < f.start - 1 + known.length ? known[i - f.start + 1]! : filler));
    const dest = join(root, r);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out.join("\n"));
  }
  return { root, files: best.size };
}

/** Replays one Claude Code transcript. */
export function replaySession(file: string, run: HookRunner): SessionReplay {
  const lines = readLines(file).filter(({ o }) => !o.isSidechain);
  const projectDir = projectOf(lines);
  // The project is gone: judge the recorded copies in a stand-in, with paths mapped onto it.
  const shadow = existsSync(projectDir) ? null : shadowProject(lines, projectDir);
  const onDisk = (v: unknown): any => {
    if (!shadow) return v;
    if (typeof v === "string") return v.split(projectDir).join(shadow.root);
    if (Array.isArray(v)) return v.map(onDisk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, onDisk(x)]));
    return v;
  };
  const session = String(lines.find(({ o }) => o.sessionId)?.o.sessionId ?? file);
  const rel = (p: string) => {
    if (!isAbsolute(p)) return p;
    const r = relative(projectDir, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : p;
  };
  const r: SessionReplay = {
    session, file, projectDir, rebuilt: shadow?.files ?? 0, calls: 0, requests: 0, inputTokens: 0, keptOut: 0, carried: 0, denied: 0, narrowed: 0, repeats: 0, asked: 0, trimmed: 0, added: 0,
    regrets: 0, interventions: 0, compactions: 0,
    memory: { withTest: 0, testUsed: 0, testMissed: 0, editsAfter: 0, editsListed: 0, chars: 0 },
    examples: { regret: [], kept: [] },
  };

  // Requests in order, with the line index each one appears at (for carrying savings forward).
  const seenReq = new Set<string>();
  const reqAt: number[] = [];
  const boundaries: number[] = [];
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
  /** Requests after line i and before the next compaction: how often a token kept out at i would have been re-read. */
  const laterRequests = (i: number) => {
    const end = boundaries.find((b) => b > i) ?? Infinity;
    return reqAt.filter((x) => x > i && x < end).length;
  };
  const keep = (i: number, saved: number, label: string) => {
    if (saved <= 0) return;
    r.keptOut += saved;
    r.carried += saved * laterRequests(i);
    if (r.examples.kept.length < 5) r.examples.kept.push(`${label} (~${saved} tokens)`);
  };

  // Interventions waiting for evidence of regret: a held-back path, or a trimmed command.
  const heldPaths = new Map<string, string>();
  const trimmedCommands: { key: string; at: number; label: string }[] = [];
  const uses = new Map<string, { name: string; input: any; at: number; pre: Record<string, any> | null }>();
  let callIndex = 0;

  lines.forEach(({ o }, i) => {
    const content = o.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") {
        r.calls++;
        callIndex++;
        const input = { hook_event_name: "PreToolUse", session_id: session, cwd: onDisk(o.cwd ?? projectDir), tool_name: b.name, tool_input: onDisk(b.input ?? {}), tool_use_id: b.id, transcript_path: file };
        // Regret: the agent came back for something Snout held back.
        const path = typeof b.input?.file_path === "string" ? b.input.file_path : typeof b.input?.notebook_path === "string" ? b.input.notebook_path : undefined;
        if (path && heldPaths.has(path)) {
          r.regrets++;
          if (r.examples.regret.length < 5) r.examples.regret.push(`${b.name} ${rel(path)} after Snout held it back (${heldPaths.get(path)})`);
          heldPaths.delete(path);
        }
        if (b.name === "Bash" && typeof b.input?.command === "string") {
          const c = b.input.command as string;
          const hit = trimmedCommands.findIndex((t) => callIndex - t.at <= 5 && withoutCd(c).includes(t.key));
          if (hit >= 0) {
            r.regrets++;
            if (r.examples.regret.length < 5) r.examples.regret.push(`re-ran \`${trimmedCommands[hit]!.label}\` within 5 calls of a trim`);
            trimmedCommands.splice(hit, 1);
          }
        }
        uses.set(b.id, { name: b.name, input: b.input ?? {}, at: callIndex, pre: run.pre(input) });
        continue;
      }
      if (b?.type !== "tool_result") continue;
      const use = uses.get(b.tool_use_id);
      if (!use) continue;
      const resultText = textOf(b.content);
      const resultTokens = tokens(resultText);
      const pre = use.pre?.hookSpecificOutput;
      const path = typeof use.input.file_path === "string" ? use.input.file_path : undefined;
      if (pre?.permissionDecision === "deny") {
        r.denied++;
        r.interventions++;
        const reason = String(pre.permissionDecisionReason ?? "");
        keep(i, resultTokens - tokens(reason), `${use.name} ${path ? rel(path) : ""} held back`);
        if (path) heldPaths.set(path, reason.slice(0, 80));
        continue; // the agent would have seen the reason, not this result
      }
      const upd = pre?.updatedInput;
      if (pre?.permissionDecision === "allow" && upd && typeof upd.limit === "number" && path) {
        // The agent would have got only these lines of what it read, plus Snout's note.
        const file = o.toolUseResult?.file;
        const full: string = typeof file?.content === "string" ? file.content : resultText;
        const from = Math.max(0, (Number(upd.offset) || 1) - (Number(file?.startLine) || 1));
        const slice = full.split("\n").slice(from, from + upd.limit).join("\n");
        const note = typeof pre.additionalContext === "string" ? pre.additionalContext : "";
        const saved = tokens(full) - tokens(slice) - tokens(note);
        if (/is unchanged since you read/.test(note)) {
          // The full text is already in context: nothing withheld, so nothing to regret.
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
      const response = o.toolUseResult ?? { stdout: resultText, stderr: "", interrupted: false, isImage: false };
      const postInput = { hook_event_name: "PostToolUse", session_id: session, cwd: onDisk(o.cwd ?? projectDir), tool_name: use.name, tool_input: onDisk(use.input), tool_use_id: b.tool_use_id, tool_response: onDisk(response), transcript_path: file };
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

  // Memory at each compaction: what would be restored, against what the agent did next.
  if (boundaries.length) {
    const dir = mkdtempSync(join(tmpdir(), "snout-replay-mem-"));
    try {
      for (const at of boundaries) {
        const prefix = join(dir, "prefix.jsonl");
        writeFileSync(prefix, lines.slice(0, at).map((l) => l.raw).join("\n") + "\n");
        const facts = sessionFacts(prefix, projectDir);
        r.memory.chars += memoryText(facts, [], projectDir).length;
        const next = lines.slice(at + 1).flatMap(({ o }) => (Array.isArray(o.message?.content) ? o.message.content : [])).filter((b: any) => b?.type === "tool_use").slice(0, 40);
        const runner = (c: string) => c.split(/\s+/).slice(0, 3).join(" ");
        const testsNext = next.filter((b: any) => b.name === "Bash" && typeof b.input?.command === "string").map((b: any) => testCommand(b.input.command, projectDir)).filter(Boolean) as string[];
        if (facts.test) {
          r.memory.withTest++;
          if (testsNext.some((t) => runner(t) === runner(facts.test!.command))) r.memory.testUsed++;
        } else if (testsNext.length) r.memory.testMissed++;
        const listed = new Set(facts.changed.slice(0, 12));
        for (const b of next) {
          const p = b.input?.file_path;
          if (!EDITS.has(b.name) || typeof p !== "string") continue;
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

/**
 * What if this session had compacted whenever its context passed `cap` tokens? Worked out from
 * the session's own recorded requests, no model: the context grows by what each request really
 * added, and each early compaction costs a summary call, a fresh context to cache again, and the
 * agent re-reading what it lost (both sized as a share of the cap). Both the
 * session as recorded and the what-if are priced with the same formula, so its simplifications
 * mostly cancel. Prices are flat per token (no long-prompt tier).
 */
export interface CompactionCosts {
  /** The summary left after a compaction, as a share of the cap (measured: ~27k left at a 66k trigger, prefix included). */
  summary: number;
  /** What the agent re-reads because the summary lost it, as a share of the cap, over `rereadCalls` extra requests. */
  reread: number;
  rereadCalls: number;
}
export const COMPACTION_COSTS: Record<"usual" | "harsh", CompactionCosts> = {
  // Fitted to the two long-session runs measured both ways (2026-10-08/09): live savings were
  // 6–8 points larger than even this predicts, so it errs toward saving less.
  usual: { summary: 0.12, reread: 0.05, rereadCalls: 2 },
  harsh: { summary: 0.25, reread: 0.3, rereadCalls: 8 },
};
export interface WhatIf { cap: number; baseCost: number; capCost: number; change: number; compactions: number; peak: number }

interface Req { written: number; cached: number; output: number }

function requestsOf(lines: Line[]): Req[] {
  const seen = new Set<string>();
  const out: Req[] = [];
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

/** Relative prices (cache write 1.25×, cache read 0.1×, output 5× input): the shape every Claude model shares. */
const W = 1.25, R = 0.1, O = 5;

export function compactionWhatIf(file: string, cap: number, costs: CompactionCosts): WhatIf {
  const reqs = requestsOf(readLines(file).filter(({ o }) => !o.isSidechain));
  const prefix = reqs.length ? reqs[0]!.written + reqs[0]!.cached : 0;
  let base = 0, sim = 0, ctx = 0, prev = 0, compactions = 0, peak = 0, rewrite = false;
  for (const q of reqs) {
    const size = q.written + q.cached;
    base += q.written * W + q.cached * R + q.output * O;
    // The session compacted on its own here (its context fell by a third or more): so does the what-if.
    if (prev && size < prev * 0.67) ctx = size;
    else ctx += size - prev;
    prev = size;
    if (ctx > cap) {
      compactions++;
      const summary = costs.summary * cap, reread = costs.reread * cap;
      sim += ctx * R + summary * O; // the summary call reads the context and writes the summary
      ctx = prefix + summary + reread;
      sim += costs.rereadCalls * ctx * R + reread * W; // re-reading what the summary lost
      rewrite = true;
    }
    peak = Math.max(peak, ctx);
    // Right after a compaction the whole new context is written to the cache once.
    const written = rewrite ? ctx : Math.min(q.written, ctx);
    sim += written * W + Math.max(0, ctx - written) * R + q.output * O;
    rewrite = false;
  }
  return { cap, baseCost: base, capCost: sim, change: base ? sim / base - 1 : 0, compactions, peak };
}

export interface ReplayTotals {
  sessions: number;
  calls: number;
  inputTokens: number;
  keptOut: number;
  carried: number;
  added: number;
  /** carried − added, as a share of the input the sessions used. */
  share: number;
  regretRate: number | null;
  compactions: number;
  testRecall: number | null;
  fileRecall: number | null;
}

export function totals(rows: SessionReplay[]): ReplayTotals {
  const sum = (f: (r: SessionReplay) => number) => rows.reduce((a, r) => a + f(r), 0);
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
    fileRecall: editsAfter ? sum((r) => r.memory.editsListed) / editsAfter : null,
  };
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)));
const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);

export function renderReplay(rows: SessionReplay[]): string {
  const t = totals(rows);
  const out = [
    `Replay of ${t.sessions} session(s), ${t.calls} tool calls, offline (no model, nothing sent).`,
    "",
    `  input the sessions used        ${fmt(t.inputTokens)} tokens`,
    `  kept out at the call           ${fmt(t.keptOut)} tokens`,
    `  carried to later requests      ${fmt(t.carried)} tokens  (until each compaction)`,
    `  Snout's own notes              ${fmt(t.added)} tokens`,
    `  would have saved               ${pct(t.share)} of input`,
    `  regret                         ${pct(t.regretRate)} of interventions were needed later`,
  ];
  if (t.compactions) out.push(`  memory, ${t.compactions} compaction(s)   test command matched next runs ${pct(t.testRecall)} · files edited next listed ${pct(t.fileRecall)}`);
  const count = (f: (r: SessionReplay) => number) => rows.reduce((a, r) => a + f(r), 0);
  out.push(`  interventions                  ${count((r) => r.narrowed)} reads narrowed · ${count((r) => r.denied)} held back · ${count((r) => r.trimmed)} outputs trimmed · ${count((r) => r.repeats)} repeat reads`);
  out.push("", "  session       calls  input    saved   regret  compactions");
  for (const r of rows) {
    const share = r.inputTokens ? (r.carried - r.added) / r.inputTokens : 0;
    out.push(`  ${r.session.slice(0, 12).padEnd(12)}  ${String(r.calls).padStart(5)}  ${fmt(r.inputTokens).padStart(6)}  ${pct(share).padStart(6)}  ${`${r.regrets}/${r.interventions}`.padStart(6)}  ${String(r.compactions).padStart(4)}`);
  }
  const regrets = rows.flatMap((r) => r.examples.regret).slice(0, 5);
  if (regrets.length) out.push("", "  needed after all:", ...regrets.map((x) => `    ${x}`));
  const rebuilt = rows.filter((r) => r.rebuilt);
  out.push("", "  An estimate of tokens, not of outcomes: an agent that sees less acts differently.");
  out.push(rebuilt.length
    ? `  ${rebuilt.length} session(s) whose project is gone were judged on the file copies they recorded (${rebuilt.reduce((a, r) => a + r.rebuilt, 0)} files); the rest on the files as they are on disk now.`
    : "  Files are judged as they are on disk now.");
  return out.join("\n");
}
