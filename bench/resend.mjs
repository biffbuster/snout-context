#!/usr/bin/env node
/**
 * Where an agent's context goes, from its own session logs (Claude Code transcripts and Codex
 * rollouts on this machine). Nothing is sent anywhere and nothing is changed.
 *
 * Every request sends the whole conversation again, so a piece of context costs its size on every
 * later request until a compaction drops it. For each piece this counts its tokens (characters / 4)
 * and the requests it rode along in ("token-requests"), totalled by where it came from: file reads,
 * shell output, searches, edits, the user's prompts, the agent's own text. It also counts rereads:
 * a file read again while an earlier read of it is still in context, split by whether the file was
 * edited in between (as far as the log shows: Edit/Write/apply_patch on it).
 *
 *   node bench/resend.mjs [--claude dir,...] [--codex dir] [--min-requests 20] [--out file.json]
 *
 * Defaults: every project under ~/.claude/projects (subagent sidechains left out) and ~/.codex/sessions.
 * Token counts are estimates; each agent's real input tokens (from its usage records) are shown beside them.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MIN_REQUESTS = Number(flag("--min-requests", 20));
/** --examples: list the rereads an earlier read already covered, to see why they got through. */
const EXAMPLES = args.includes("--examples") ? [] : null;
/**
 * Characters per token. Calibrated on 2026-10-30 from 556 pairs of consecutive Claude Code requests
 * on this machine: real input growth against the characters added between them, median 2.25 (p25
 * 2.02, p75 2.42). Four per token, the usual rule, undercounted code and JSON by about 1.8 times.
 */
const CHARS_PER_TOKEN = Number(flag("--chars-per-token", 2.25));
const tok = (s) => Math.ceil((typeof s === "string" ? s.length : JSON.stringify(s ?? "").length) / CHARS_PER_TOKEN);
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : []);
const rows = (f) => readFileSync(f, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** What a shell command does to files: reads (path, whole or a window), searches, edits, tests. */
const READ_CMD = /(?:^|[;&|(]\s*)(?:cat|type|bat|nl(?:\s+-\w+)*|head(?:\s+-n?\s*\d+)?|tail(?:\s+-n?\s*\d+)?|sed\s+-n\s+(['"]?)[\d,$p;\s]+\1|Get-Content|gc)\s+((?:"[^"]+"|'[^']+'|[^\s|;&>]+))/gi;
function shellKind(cmd) {
  const c = String(cmd);
  if (/\bapply_patch\b|\bsed\s+-i\b|>\s*\S|Set-Content|Out-File|tee\s/.test(c)) return "edit";
  if (/\b(?:npm\s+(?:run\s+)?test|node\s+--test|pytest|vitest|jest|go\s+test|cargo\s+test|tox|npm\s+run\s+verify)\b/.test(c)) return "test";
  if (/(?:^|[;&|(]\s*)(?:rg|grep|Select-String|findstr|git\s+grep)\b/.test(c)) return "search";
  READ_CMD.lastIndex = 0;
  if (READ_CMD.test(c)) return "read";
  if (/(?:^|[;&|(]\s*)(?:ls|dir|find|Get-ChildItem|tree)\b/.test(c)) return "list";
  if (/\bgit\s+(?:diff|log|show|status)\b/.test(c)) return "git";
  return "other";
}
/** The files a shell command reads, each with the lines it prints when the command says (sed -n 'a,bp', head -n N). */
function shellReads(cmd) {
  const out = [];
  READ_CMD.lastIndex = 0;
  for (const m of String(cmd).matchAll(READ_CMD)) {
    const sed = /sed\s+-n\s+['"]?(\d+),(\d+)p/.exec(m[0]), head = /head\s+-n?\s*(\d+)/.exec(m[0]);
    const tail = /^\W*tailb/.test(m[0].trim());
    // tail's lines depend on the file's length: a window no other read can be compared with.
    if (/^-/.test(m[2])) continue; // a flag the pattern took for a path (head -40 f)
    out.push({ path: norm(m[2].replace(/^["']|["']$/g, "")), ...(sed ? { from: +sed[1], to: +sed[2] } : head ? { from: 1, to: +head[1] } : tail ? { from: -1, to: -1 } : {}) });
  }
  return out;
}
const patchFiles = (text) => [...String(text).matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => norm(m[1].trim()));
const endsWithPath = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** One session, as a list of events: a request, a piece of context added, a compaction, an edit. */
/**
 * A reread, by what was in context from earlier reads of the same file:
 *   covered    unchanged since, and an earlier read already holds every line asked for: skippable whole
 *   overlap    unchanged since, and part of it was read before
 *   newLines   unchanged since, but these lines were never read: not a repeat
 *   changed    edited since the earlier read: what changed is new, the rest is not
 *   answered   a reply of a few tokens: already answered as unchanged (by the agent or by Snout)
 */
const REREADS = ["covered", "overlap", "newLines", "changed", "answered"];
const zero = () => ({ n: 0, tokens: 0, tokenRequests: 0 });
function newTally() { return { sessions: 0, requests: 0, realInput: 0, realCached: 0, bySource: {}, reread: Object.fromEntries(REREADS.map((k) => [k, zero()])), reads: 0 }; }
const ANSWERED = 60;
const inside = (w, ws) => ws.some((x) => x.from <= w.from && x.to >= w.to);
const touches = (w, ws) => ws.some((x) => x.from <= w.to && x.to >= w.from);

function account(tally, events) {
  // First pass: when each piece leaves (the next compaction), so its token-requests are known.
  let live = [];
  const pieces = [];
  let requests = 0;
  const lastRead = new Map(); // path -> { windows: [{from, to}], edited }
  for (const e of events) {
    if (e.kind === "request") { requests++; for (const p of live) p.rides++; tally.realInput += e.input ?? 0; tally.realCached += e.cached ?? 0; continue; }
    if (e.kind === "compact") { live = []; lastRead.clear(); continue; }
    if (e.kind === "edit") { for (const f of e.files) for (const [k, v] of lastRead) if (endsWithPath(k, f)) v.edited = true; continue; }
    const p = { source: e.source, tokens: e.tokens, rides: 0, reread: null };
    if (e.reads?.length) {
      tally.reads++;
      for (const r of e.reads) {
        const w = { from: r.from ?? 1, to: r.to ?? Infinity };
        const before = [...lastRead.entries()].find(([k]) => endsWithPath(k, r.path));
        if (before) {
          const prior = before[1];
          p.reread = e.tokens <= ANSWERED ? "answered" : prior.edited ? "changed" : inside(w, prior.windows) ? "covered" : touches(w, prior.windows) ? "overlap" : "newLines";
          if (EXAMPLES && p.reread === "covered") EXAMPLES.push({ file: tally.file, path: r.path, source: e.source, window: [w.from, w.to], before: prior.windows.map((x) => [x.from, x.to]), tokens: e.tokens });
          if (e.tokens > ANSWERED) lastRead.set(before[0], { windows: prior.edited ? [w] : [...prior.windows, w], edited: false });
        } else if (e.tokens > ANSWERED) lastRead.set(r.path, { windows: [w], edited: false });
      }
    }
    pieces.push(p);
    live.push(p);
  }
  if (requests < MIN_REQUESTS) return false;
  tally.sessions++;
  tally.requests += requests;
  for (const p of pieces) {
    const s = (tally.bySource[p.source] ??= { pieces: 0, tokens: 0, tokenRequests: 0 });
    s.pieces++; s.tokens += p.tokens; s.tokenRequests += p.tokens * p.rides;
    if (p.reread) { const r = tally.reread[p.reread]; r.n++; r.tokens += p.tokens; r.tokenRequests += p.tokens * p.rides; }
  }
  return true;
}

// ---------- Claude Code ----------

function claudeEvents(file) {
  const ev = [];
  const tools = new Map();
  const seenRequest = new Set();
  for (const o of rows(file)) {
    if (o.isSidechain) continue;
    if (o.type === "system" && /compact/.test(String(o.subtype ?? ""))) { ev.push({ kind: "compact" }); continue; }
    if (o.type === "user" && o.isCompactSummary) { ev.push({ kind: "compact" }); ev.push({ kind: "piece", source: "compaction summary", tokens: tok(o.message?.content) }); continue; }
    // Attachments become reminders in the conversation, except the transcript's own records of the
    // system prompt and the tool list, which are sent with every request anyway (the overhead).
    if (o.type === "attachment") {
      const a = o.attachment ?? {};
      if (a.type === "prompt_snapshot" || a.type === "deferred_tools_record") continue;
      const kind = a.type === "hook_non_blocking_error" ? `hook errors (${/ECONNREFUSED/.test(String(a.stderr)) ? "fast-hook server not running" : "other"})` : a.type === "hook_additional_context" || a.type === "hook_success" ? "hook output" : String(a.type ?? "other");
      ev.push({ kind: "piece", source: `attachment: ${kind}`, tokens: tok(a) });
      continue;
    }
    if (o.type === "assistant") {
      const rid = o.requestId ?? o.message?.id;
      if (rid && !seenRequest.has(rid)) {
        seenRequest.add(rid);
        const u = o.message?.usage ?? {};
        ev.push({ kind: "request", input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0 });
      }
      for (const b of o.message?.content ?? []) {
        if (b.type === "text") ev.push({ kind: "piece", source: "agent text", tokens: tok(b.text) });
        if (b.type === "tool_use") {
          tools.set(b.id, b);
          const big = b.name === "Write" || b.name === "Edit" || b.name === "MultiEdit" || b.name === "NotebookEdit";
          ev.push({ kind: "piece", source: big ? "agent edits (the new text it wrote)" : "agent tool calls", tokens: tok(b.input) });
          if (big && b.input?.file_path) ev.push({ kind: "edit", files: [norm(b.input.file_path)] });
          if (b.name === "Bash" && shellKind(b.input?.command) === "edit") ev.push({ kind: "edit", files: [...patchFiles(b.input?.command), ...shellReads(b.input?.command).map((r) => r.path)] });
        }
        // Thinking from earlier turns is not sent again: not counted.
      }
      continue;
    }
    if (o.type === "user") {
      const c = o.message?.content;
      if (typeof c === "string") { ev.push({ kind: "piece", source: "user prompts", tokens: tok(c) }); continue; }
      for (const b of c ?? []) {
        if (b.type === "text") { ev.push({ kind: "piece", source: "user prompts", tokens: tok(b.text) }); continue; }
        if (b.type !== "tool_result") continue;
        const use = tools.get(b.tool_use_id);
        const name = use?.name ?? "?";
        // An image costs what the model sees (about width × height / 750 tokens), not its base64 text.
        const dim = o.toolUseResult?.type === "image" ? o.toolUseResult.file?.dimensions : null;
        const t = dim ? Math.ceil(((dim.displayWidth ?? dim.originalWidth ?? 0) * (dim.displayHeight ?? dim.originalHeight ?? 0)) / 750) || 1500
          : tok(Array.isArray(b.content) ? b.content.map((x) => (x?.type === "text" ? x.text : x?.type === "image" ? "" : JSON.stringify(x))).join("") : b.content);
        if (name === "Read") {
          // What it returned, when the log says (a read can come back cut short); else what it asked for.
          const got = o.toolUseResult?.file;
          const from = Number(got?.startLine) || Math.max(1, Number(use.input?.offset) || 1);
          const limit = typeof got?.numLines === "number" ? got.numLines : Number(use.input?.limit);
          const whole = typeof got?.numLines === "number" ? from <= 1 && got.numLines >= (Number(got.totalLines) || got.numLines) : !(limit > 0);
          ev.push({ kind: "piece", source: "file reads (Read)", tokens: t, reads: [{ path: norm(use.input?.file_path), from, to: whole ? Infinity : from + limit - 1, image: o.toolUseResult?.type === "image" }] });
        }
        else if (name === "Bash") {
          const k = shellKind(use.input?.command);
          ev.push({ kind: "piece", source: k === "read" ? "file reads (shell)" : `shell: ${k}`, tokens: t, ...(k === "read" ? { reads: shellReads(use.input?.command) } : {}) });
        } else if (name === "Grep" || name === "Glob") ev.push({ kind: "piece", source: "search (Grep, Glob)", tokens: t });
        else if (/^mcp__/.test(name)) ev.push({ kind: "piece", source: "MCP tools", tokens: t });
        else if (name === "Task" || name === "Agent") ev.push({ kind: "piece", source: "subagent reports", tokens: t });
        else if (name === "WebFetch" || name === "WebSearch") ev.push({ kind: "piece", source: "web", tokens: t });
        else if (name === "Edit" || name === "Write" || name === "MultiEdit") ev.push({ kind: "piece", source: "edit results", tokens: t });
        else ev.push({ kind: "piece", source: "other tools", tokens: t });
      }
    }
  }
  return ev;
}

// ---------- Codex ----------

const codexText = (o) => (typeof o === "string" ? o : Array.isArray(o) ? o.map((x) => x?.text ?? "").join("") : JSON.stringify(o ?? ""));
function codexCall(p) {
  let a = p.arguments ?? p.input ?? "";
  try { const j = JSON.parse(a); a = Array.isArray(j.command) ? j.command.join(" ") : j.cmd ?? j.command ?? a; } catch { /* free text */ }
  return String(a);
}
function codexEvents(file) {
  const ev = [];
  const calls = new Map();
  for (const o of rows(file)) {
    const p = o.payload ?? {};
    if (o.type === "compacted") { ev.push({ kind: "compact" }); ev.push({ kind: "piece", source: "compaction summary", tokens: tok(p.replacement_history ?? p.message) }); continue; }
    if (p.type === "token_count" && p.info?.last_token_usage) { const u = p.info.last_token_usage; ev.push({ kind: "request", input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0 }); continue; }
    if (o.type !== "response_item") continue;
    if (p.type === "message") ev.push({ kind: "piece", source: p.role === "user" ? "user prompts" : p.role === "assistant" ? "agent text" : "instructions", tokens: tok(codexText(p.content)) });
    else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const cmd = codexCall(p);
      calls.set(p.call_id, cmd);
      const k = shellKind(cmd);
      ev.push({ kind: "piece", source: k === "edit" ? "agent edits (the new text it wrote)" : "agent tool calls", tokens: tok(cmd) });
      if (k === "edit") ev.push({ kind: "edit", files: [...patchFiles(cmd), ...shellReads(cmd).map((r) => r.path)] });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
      const cmd = calls.get(p.call_id) ?? "";
      const k = shellKind(cmd);
      const t = tok(codexText(p.output));
      ev.push({ kind: "piece", source: k === "read" ? "file reads (shell)" : k === "edit" ? "edit results" : `shell: ${k}`, tokens: t, ...(k === "read" ? { reads: shellReads(cmd) } : {}) });
    }
  }
  return ev;
}

// ---------- Report ----------

const claudeDirs = (flag("--claude") ?? "").split(",").filter(Boolean);
const claudeFiles = (claudeDirs.length ? claudeDirs : [join(homedir(), ".claude", "projects")]).flatMap(walk).filter((f) => !/[\\/]subagents[\\/]/.test(f));
const codexFiles = walk(flag("--codex", join(homedir(), ".codex", "sessions")));
const result = { measuredAt: new Date().toISOString(), minRequests: MIN_REQUESTS, claude: newTally(), codex: newTally() };
for (const f of claudeFiles) { try { result.claude.file = f; account(result.claude, claudeEvents(f)); } catch (err) { console.error(`skipped ${f}: ${err.message}`); } }
for (const f of codexFiles) { try { result.codex.file = f; account(result.codex, codexEvents(f)); } catch (err) { console.error(`skipped ${f}: ${err.message}`); } }

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
for (const [agent, t] of Object.entries({ "Claude Code": result.claude, Codex: result.codex })) {
  const total = Object.values(t.bySource).reduce((a, s) => a + s.tokenRequests, 0);
  console.log(`\n${agent}: ${t.sessions} sessions with ${MIN_REQUESTS}+ requests, ${fmt(t.requests)} requests`);
  console.log(`  real input tokens ${fmt(t.realInput)}, of which cached ${t.realInput ? Math.round((100 * t.realCached) / t.realInput) : 0}%; estimated conversation re-sent ${fmt(total)} (the rest is the system prompt and tool definitions, sent with every request)`);
  console.log("  where the re-sent conversation comes from (share of token-requests; tokens when first added):");
  for (const [k, s] of Object.entries(t.bySource).sort((a, b) => b[1].tokenRequests - a[1].tokenRequests)) {
    console.log(`    ${k.padEnd(40)} ${String(total ? ((100 * s.tokenRequests) / total).toFixed(1) : "0").padStart(5)}%   ${fmt(s.tokens).padStart(7)} tokens in ${s.pieces} pieces, avg ${s.pieces ? Math.round(s.tokenRequests / Math.max(1, s.tokens)) : 0} requests in context`);
  }
  const LABEL = { covered: "unchanged, every line already in context", overlap: "unchanged, partly read before", newLines: "unchanged, lines not read before", changed: "edited since the earlier read", answered: "already answered as unchanged" };
  console.log(`  rereads of a file still in context: ${REREADS.reduce((a, k) => a + t.reread[k].n, 0)} of ${t.reads} file reads`);
  for (const k of REREADS) { const r = t.reread[k]; console.log(`    ${LABEL[k].padEnd(42)} ${String(r.n).padStart(5)} rereads, ${fmt(r.tokens).padStart(7)} tokens, ${total ? ((100 * r.tokenRequests) / total).toFixed(1) : 0}% of the re-sent conversation`); }
}
if (EXAMPLES) for (const x of EXAMPLES) console.log(JSON.stringify({ ...x, file: x.file.split(/[\/]/).slice(-2).join("/") }));
if (flag("--out")) writeFileSync(flag("--out"), JSON.stringify(result, null, 2));
