#!/usr/bin/env node
/**
 * Which tool outputs cost the most, across the Claude Code and Codex sessions on this machine.
 * Read-only and local: it reads session files, prints a ranking, and sends nothing anywhere.
 *
 *   node bench/outputs.mjs [--days N] [--project SUBSTRING] [--json FILE]
 *
 * An output is paid for more than once. It enters the context once, then rides along, cached, on
 * every later request until the next compaction. So each output is priced in input-token
 * equivalents as
 *
 *   Claude Code   1.25 x tokens (cache write)  +  0.1 x tokens x later requests (cache reads)
 *   Codex         1    x tokens (fresh input)  +  0.1 x tokens x later requests (cached input)
 *
 * and the session's whole input bill is priced with the same weights from its recorded usage, so
 * "share of input" is like for like. Tokens are estimated from the text in context (what the agent
 * actually saw, after any truncation by the agent itself), with Snout's estimator.
 *
 * Commands are grouped by their first real command (after cd / Set-Location / env assignments).
 * "Squeeze kind" says whether Snout's output trimming already recognises that command; Claude Code
 * trims after the run; Codex cannot replace output, so for Codex it shows what Snout would trim
 * if Codex allowed it. Output stays on this machine: write --json under .snout/ (ignored by git).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexRows, estimateTokens, kindOf } from "../dist/lib.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const days = Number(opt("--days")) || 0;
const projectFilter = (opt("--project") || "").toLowerCase();
const since = days ? Date.now() - days * 86_400_000 : 0;
const W = { claude: { first: 1.25, carry: 0.1 }, codex: { first: 1, carry: 0.1 } };
const BIG = 2000; // tokens: roughly the 8k-character outputs earlier sampling found dominant

const tokens = (text) => estimateTokens(Buffer.byteLength(text), "output.txt");

function files(dir, out = [], depth = 6) {
  if (depth < 0) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out, depth - 1);
    else if (e.name.endsWith(".jsonl")) { try { if (statSync(p).mtimeMs >= since) out.push(p); } catch { /* gone */ } }
  }
  return out;
}

// --- command families ------------------------------------------------------------------------

/** The first real command: drop cd / Set-Location / pushd prefixes and env assignments. */
function firstCommand(cmd) {
  // Statements, not pipes: `echo "== a =="; cat a` is a file print, `$c = Get-Content x` too.
  const parts = String(cmd).split(/\r?\n|;|&&|\|\|/).map((l) => l.trim().replace(/^\$\w+\s*=\s*/, "")).filter((l) => l && !l.startsWith("#"));
  let c = parts.find((l) => !/^(echo|write-host|write-output|printf|cd|set-location|sl|pushd|\$env:\w+\s*=|[A-Z_][A-Z0-9_]*=\S*$)\b/i.test(l)) ?? parts[0] ?? "";
  for (let i = 0; i < 6; i++) {
    const before = c;
    c = c.replace(/^(cd|set-location|sl|pushd)\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;|\|\|)\s*/i, "")
      .replace(/^(\$env:\w+\s*=\s*("[^"]*"|'[^']*'|\S+)\s*;\s*)/i, "")
      .replace(/^([A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)/, "")
      .replace(/^(&\s*|\.\s+|powershell(\.exe)?\s+(-\w+\s+)*|pwsh\s+(-\w+\s+)*|bash\s+-l?c\s+|sh\s+-c\s+)["']?/i, "");
    if (c === before) break;
  }
  return c.trim();
}

const FAMILIES = [
  ["test run", /^(npm (run )?test|npm run verify|npm run eval|npx (jest|vitest|mocha)|node --test|(python3? -m )?pytest|go test|cargo test|jest|vitest|bun test|pnpm (run )?test|yarn test|dotnet test|mvn test|gradle test|tox|deno test)\b/],
  ["build / typecheck / lint", /^(npm run (build|typecheck|lint|check\S*)|n?px tsc|tsc|cargo (build|check|clippy)|go (build|vet)|make|eslint|npx eslint|ruff|mypy|dotnet build|mvn (compile|package)|gradle build)\b/],
  ["search", /^(rg|grep|egrep|git grep|select-string|sls|findstr|ag|ack)\b/],
  ["print file", /^(cat|get-content|gc|type|head|tail|sed\s+-n|less|more|bat|nl|awk|jq|format-hex)\b/],
  ["list files", /^(ls|dir|get-childitem|gci|find|tree|fd|git ls-files|du|wc)\b/],
  ["git diff / show / log", /^git\s+(-c\s+\S+\s+)*(diff|show|log|blame|shortlog|reflog)\b/],
  ["git other", /^git\b/],
  ["github cli", /^gh\b/],
  ["install", /^(npm (i|install|ci|update)|pip3? install|pnpm (i|install|add)|yarn( add| install)?\b|uv (pip|sync|add)|cargo install|bun (i|install|add)|winget|choco|brew)\b/],
  ["network", /^(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b/],
  ["docker", /^(docker|docker-compose|podman)\b/],
  ["run a script", /^(node|python3?|py|bun|deno|tsx|ts-node|npx|npm run|pnpm|yarn|uv run|cargo run|go run|dotnet run)\b/],
];

function family(cmd) {
  const c = firstCommand(cmd).toLowerCase();
  // A pipeline into a filter is judged by its producer, but a pipeline into a search is a search.
  for (const [name, re] of FAMILIES) if (re.test(c)) return name;
  return "other command";
}

function claudeFamily(name, input) {
  if (name === "Bash" || name === "PowerShell") return typeof input?.command === "string" ? family(input.command) : "other command";
  if (name === "Read") return "Read tool (file)";
  if (name === "Grep") return "Grep tool";
  if (name === "Glob") return "Glob tool";
  if (name === "WebFetch" || name === "WebSearch") return "web fetch / search";
  if (name === "Task" || name === "Agent") return "subagent result";
  if (name.startsWith("mcp__")) return "MCP tool";
  return "other tools";
}

// --- stats ---------------------------------------------------------------------------------

const groups = new Map();
const sessions = { claude: { n: 0, input: 0, outputs: 0 }, codex: { n: 0, input: 0, outputs: 0 } };

function record(agent, fam, text, later, cmd) {
  const t = tokens(text);
  if (!t) return;
  const w = W[agent];
  const cost = w.first * t + w.carry * t * later;
  const key = `${agent}\t${fam}`;
  let g = groups.get(key);
  if (!g) groups.set(key, (g = { agent, family: fam, n: 0, tokens: 0, cost: 0, carried: 0, big: 0, bigCost: 0, squeezable: 0, sizes: [], top: [] }));
  g.n++;
  g.tokens += t;
  g.cost += cost;
  g.carried += t * later;
  if (t >= BIG) { g.big++; g.bigCost += cost; }
  if (cmd && kindOf(cmd)) g.squeezable += cost;
  g.sizes.push(t);
  if (cmd !== undefined || g.top.length < 3 || cost > g.top[g.top.length - 1].cost) {
    g.top.push({ cost, tokens: t, later, what: (cmd ? firstCommand(cmd) : fam).replace(/\s+/g, " ").slice(0, 70) });
    g.top.sort((a, b) => b.cost - a.cost);
    g.top.length = Math.min(g.top.length, 3);
  }
  sessions[agent].outputs += cost;
}

// --- file prints: repeats, whole-file dumps, several files at once ----------------------------

const PRINT_CMD = /^(cat|get-content|gc|type|head|tail|less|more|bat|nl|sed)$/i;
const RANGED = /(-totalcount|-head|-tail|-first|-last|-skip|\[\s*\d+\s*\.\.|\bsed\s+-n|^\s*(head|tail)\b|\|\s*(head|tail|select-object|select)\b)/i;
/** Files a shell command prints, by path text alone (the files may be gone since), with whether each print is ranged. */
function printedFiles(cmd) {
  const out = [];
  for (const raw of String(cmd).split(/\r?\n|;|&&|\|\|/)) {
    const part = raw.trim().replace(/^\$\w+\s*=\s*/, "");
    const words = part.split(/\s+/);
    if (!PRINT_CMD.test(words[0] ?? "")) continue;
    const ranged = RANGED.test(part) || /^(head|tail)$/i.test(words[0]);
    for (const w of words.slice(1)) {
      const p = w.replace(/^["']|["'),]+$/g, "");
      if (p.startsWith("-") || /^\d+(,\d+)?p?$/.test(p) || !/[\w)]\.[A-Za-z0-9]{1,8}$/.test(p) || /[|$<>]/.test(p)) continue;
      out.push({ path: p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(), ranged });
    }
  }
  return out;
}

const prints = { claude: newPrintStats(), codex: newPrintStats() };
function newPrintStats() { return { cost: 0, repeatCost: 0, wholeBigCost: 0, multiCost: 0, rangedCost: 0, n: 0, repeats: 0 }; }

/** Per session: when each file was last printed whole (compaction window), and edits since. */
function printTracker(agent) {
  const seen = new Map();
  // The last two path segments, so absolute and relative spellings of one file meet.
  const key = (p) => p.replace(/^.*?\/(?=[^/]+\/[^/]+$)/, "");
  return {
    edit(path) { seen.delete(key(String(path).replace(/\\/g, "/").toLowerCase())); },
    print(cmd, text, later, windowNo) {
      const files = printedFiles(cmd);
      if (!files.length) return;
      const t = tokens(text);
      const w = W[agent];
      const cost = w.first * t + w.carry * t * later;
      const s = prints[agent];
      s.n++;
      s.cost += cost;
      const repeat = files.every((f) => { const prev = seen.get(key(f.path)); return prev && prev.window === windowNo && (prev.whole || f.ranged); });
      if (repeat) { s.repeats++; s.repeatCost += cost; }
      if (files.length > 1) s.multiCost += cost;
      if (files.every((f) => f.ranged)) s.rangedCost += cost;
      else if (t >= BIG) s.wholeBigCost += cost;
      for (const f of files) if (!f.ranged || !seen.has(key(f.path))) seen.set(key(f.path), { window: windowNo, whole: !f.ranged });
    },
  };
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.type === "text" ? x.text ?? "" : "")).join("") : "");

// --- Claude Code ---------------------------------------------------------------------------

function claudeSession(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const rows = [];
  for (const l of lines) { if (!l) continue; try { rows.push(JSON.parse(l)); } catch { /* partial line */ } }
  if (projectFilter && !String(rows.find((o) => o.cwd)?.cwd ?? "").toLowerCase().includes(projectFilter)) return;
  const reqAt = [], bounds = [];
  const seen = new Set();
  let input = 0;
  rows.forEach((o, i) => {
    if (o.subtype === "compact_boundary") bounds.push(i);
    const u = o.message?.usage;
    if (!u || o.type !== "assistant") return;
    const id = String(o.requestId ?? o.message?.id ?? i);
    if (seen.has(id)) return;
    seen.add(id);
    reqAt.push(i);
    input += (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
  });
  if (!reqAt.length) return;
  sessions.claude.n++;
  sessions.claude.input += input;
  const later = (i) => { const end = bounds.find((b) => b > i) ?? Infinity; let n = 0; for (const x of reqAt) if (x > i && x < end) n++; return n; };
  const uses = new Map();
  const pt = printTracker("claude");
  const windowOf = (i) => bounds.filter((b) => b < i).length;
  rows.forEach((o, i) => {
    const content = o.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") {
        uses.set(b.id, { name: b.name, input: b.input });
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && typeof b.input?.file_path === "string") pt.edit(b.input.file_path);
      }
      else if (b?.type === "tool_result") {
        const u = uses.get(b.tool_use_id);
        if (!u) continue;
        const cmd = (u.name === "Bash" || u.name === "PowerShell") && typeof u.input?.command === "string" ? u.input.command : undefined;
        record("claude", claudeFamily(u.name, u.input), textOf(b.content), later(i), cmd);
        if (cmd) pt.print(cmd, textOf(b.content), later(i), windowOf(i));
      }
    }
  });
}

// --- Codex ---------------------------------------------------------------------------------

function codexSession(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const reqAt = [], bounds = [];
  let input = 0, sawRecords = false, lastTotal = -1, cwd = "";
  const fallback = [];
  const parsed = lines.map((l) => { if (!l) return null; try { return JSON.parse(l); } catch { return null; } });
  parsed.forEach((o, i) => {
    if (!o) return;
    const p = o.payload ?? {};
    if ((o.type === "session_meta" || o.type === "turn_context") && typeof p.cwd === "string") cwd = p.cwd;
    if (o.type === "compacted") bounds.push(i);
    const add = (u) => { const cached = u.cached_input_tokens || 0; input += Math.max(0, (u.input_tokens || 0) - cached) + 0.1 * cached; };
    if (o.type === "token_usage_record" && p.usage) { sawRecords = true; reqAt.push(i); add(p.usage); }
    else if (o.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) {
      const total = p.info.total_token_usage?.total_tokens ?? -1;
      if (total !== lastTotal) { lastTotal = total; fallback.push([i, p.info.last_token_usage]); }
    }
  });
  if (!sawRecords) for (const [i, u] of fallback) { reqAt.push(i); const cached = u.cached_input_tokens || 0; input += Math.max(0, (u.input_tokens || 0) - cached) + 0.1 * cached; }
  if (projectFilter && !cwd.toLowerCase().includes(projectFilter)) return;
  if (!reqAt.length) return;
  sessions.codex.n++;
  sessions.codex.input += input;
  const later = (i) => { const end = bounds.find((b) => b > i) ?? Infinity; let n = 0; for (const x of reqAt) if (x > i && x < end) n++; return n; };
  const calls = new Map();
  // A long command keeps running in a process session; later write_stdin calls poll its output.
  const procs = new Map();
  const pt = printTracker("codex");
  const windowOf = (i) => bounds.filter((b) => b < i).length;
  parsed.forEach((o, i) => {
    if (!o || o.type !== "response_item") return;
    const p = o.payload ?? {};
    if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const id = String(p.call_id ?? p.id ?? "");
      let cmd;
      for (const r of codexRows([lines[i]])) {
        const b = JSON.parse(r).message?.content?.[0];
        if (b?.type === "tool_use" && b.name === "Bash") cmd = b.input.command;
        if (b?.type === "tool_use" && b.name === "Edit") pt.edit(b.input.file_path);
      }
      const body = String(p.input ?? p.arguments ?? "");
      let label = String(p.name ?? p.type);
      let polled = false;
      if (!cmd && label === "exec") {
        const poll = /\btools\.write_stdin\(\s*\{[^}]*session_id["']?\s*:\s*(\d+)/.exec(body) ?? (p.name === "write_stdin" ? /session_id["']?\s*:\s*(\d+)/.exec(body) : null);
        if (poll && procs.has(poll[1])) { cmd = procs.get(poll[1]); polled = true; }
        else label = /\btools\.apply_patch\b/.test(body) ? "apply_patch" : /\btools\.web__/.test(body) ? "web search" : /\btools\.mcp__/.test(body) ? "MCP tool" : /\btools\.write_stdin\b/.test(body) ? "process poll (origin unknown)" : "exec (other)";
      }
      calls.set(id, { name: label, cmd, polled });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const call = calls.get(String(p.call_id));
      const text = codexRows([lines[i]]).map((r) => textOf(JSON.parse(r).message?.content?.[0]?.content)).join("");
      const sid = /\\?"session_id\\?"\s*:\s*(\d+)/.exec(text);
      if (sid && call?.cmd && !procs.has(sid[1])) procs.set(sid[1], call.cmd);
      const fam = call?.cmd ? family(call.cmd) : call?.name === "apply_patch" ? "apply_patch result" : `tool: ${call?.name ?? "unknown"}`;
      record("codex", fam, text, later(i), call?.cmd);
      if (call?.cmd && !call.polled) pt.print(call.cmd, text, later(i), windowOf(i));
    }
  });
}

// --- run -----------------------------------------------------------------------------------

const claudeRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const codexRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
for (const f of files(claudeRoot)) claudeSession(f);
for (const f of files(codexRoot)) codexSession(f);

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

const out = { generated: new Date().toISOString(), days: days || "all", sessions, groups: [] };
for (const agent of ["codex", "claude"]) {
  const s = sessions[agent];
  if (!s.n) continue;
  const rows = [...groups.values()].filter((g) => g.agent === agent).sort((a, b) => b.cost - a.cost);
  console.log(`\n${agent === "codex" ? "Codex" : "Claude Code"}: ${s.n} sessions · tool outputs are ${pct(s.outputs, s.input)} of the input bill (input-token equivalents: ${k(s.outputs)} of ${k(s.input)})`);
  console.log(`  ${"COMMAND TYPE".padEnd(26)}${"CALLS".padStart(7)}${"SHARE".padStart(8)}${"OF BILL".padStart(9)}${"MEDIAN".padStart(8)}${"P95".padStart(8)}${"MAX".padStart(8)}${"≥2k TOK".padStart(9)}${"SQUEEZE".padStart(9)}`);
  for (const g of rows.slice(0, 18)) {
    console.log(`  ${g.family.slice(0, 25).padEnd(26)}${String(g.n).padStart(7)}${pct(g.cost, s.outputs).padStart(8)}${pct(g.cost, s.input).padStart(9)}${k(q(g.sizes, 50)).padStart(8)}${k(q(g.sizes, 95)).padStart(8)}${k(Math.max(...g.sizes)).padStart(8)}${pct(g.bigCost, g.cost).padStart(9)}${pct(g.squeezable, g.cost).padStart(9)}`);
  }
  for (const g of rows.slice(0, 6)) {
    console.log(`\n  ${g.family}: costliest`);
    for (const t of g.top) console.log(`    ~${k(t.tokens)} tokens × ${t.later} later requests   ${t.what}`);
  }
  out.groups.push(...rows.map(({ sizes, ...g }) => ({ ...g, median: q(sizes, 50), p95: q(sizes, 95), max: Math.max(...sizes), shareOfOutputs: g.cost / s.outputs, shareOfInput: g.cost / s.input })));
}
for (const agent of ["codex", "claude"]) {
  const p = prints[agent], s = sessions[agent];
  if (!p.n) continue;
  console.log(`\n${agent === "codex" ? "Codex" : "Claude Code"} shell file prints: ${p.n} commands, ${pct(p.cost, s.input)} of the input bill`);
  console.log(`  repeats of a file already in context (same window, not edited since)  ${pct(p.repeatCost, p.cost).padStart(6)} of print cost (${p.repeats} commands)`);
  console.log(`  whole-file prints of 2k+ tokens                                         ${pct(p.wholeBigCost, p.cost).padStart(6)}`);
  console.log(`  several files in one command                                            ${pct(p.multiCost, p.cost).padStart(6)}`);
  console.log(`  already ranged (head, -TotalCount, sed -n, [a..b])                      ${pct(p.rangedCost, p.cost).padStart(6)}`);
}
out.prints = prints;
console.log("\nSHARE: of this agent's tool-output cost · OF BILL: of its whole input bill · ≥2k TOK: share of the type's cost from outputs of 2k+ tokens · SQUEEZE: share Snout's trimming recognises.");
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(out, null, 2));
