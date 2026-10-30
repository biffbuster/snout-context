#!/usr/bin/env node
/**
 * Live smoke for memory as the agent's own tool: one real session, Claude Code or Codex, with
 * Snout's MCP server offering only snout_memory_search and snout_memory_fetch. It answers one
 * question: can the agent find a past record, open it, and use it correctly?
 *
 * A small project whose task depends on a decision recorded only in an earlier session's record:
 * when vaccination reminders go out. The decision is in no file of the project, and Snout's records
 * live outside the project folder (SNOUT_DIR), so the agent can reach them only through the tools.
 * The search line shows the session's headline sentence; the times are in the record itself, so
 * using them takes a fetch. Two unrelated sessions and one unrelated note are on record too. The
 * prompt mentions the earlier agreement and names no tool.
 *
 * Passes when all hold (set before the first run):
 *   found    the agent called snout_memory_search and the decision's session was among the results
 *   fetched  the agent called snout_memory_fetch on that session
 *   used     reminderPlan returns the agreed times: 10 days before the due date at 07:30, and a
 *            second reminder 2 days before when nothing was booked
 *
 *   node bench/memory-smoke.mjs --agent claude --api [--model claude-sonnet-5-5]   (bills ANTHROPIC_API_KEY)
 *   node bench/memory-smoke.mjs --agent codex [--model gpt-6.1-sol]                 (the operator's Codex login)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { launchClaude, REPO, SNOUT_BIN } from "./swe.mjs";
import { stamp } from "./stamp.mjs";

const flag = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const AGENT = flag("--agent", "claude");
const MODEL = flag("--model", AGENT === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5");
const TOOLS = ["snout_memory_search", "snout_memory_fetch"];
const run = mkdtempSync(join(homedir(), ".snout-bench", `smoke-mem-${AGENT}-`));
const project = join(run, "pawclinic");
const snoutDir = join(run, "snout"), cfg = join(run, "cfg");
for (const d of [join(project, "src", "reminders"), join(snoutDir, "memory"), cfg]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- the project and its memory

writeFileSync(join(project, "package.json"), JSON.stringify({ name: "pawclinic", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
writeFileSync(join(project, "src", "reminders", "vaccines.js"), [
  "/**",
  " * When to send a pet owner the reminders for a vaccine booster.",
  " * @param {string} due the booster's due date, \"YYYY-MM-DD\"",
  " * @param {{ booked: boolean }} opts whether the owner has already booked the visit",
  " * @returns {string[]} send times, \"YYYY-MM-DD HH:MM\" in the clinic's time zone, earliest first",
  " */",
  "export function reminderPlan(due, { booked }) {",
  "  throw new Error(\"not implemented\");",
  "}",
  "",
].join("\n"));
const git = (...a) => spawnSync("git", a, { cwd: project, encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "dev@pawclinic.test"); git("config", "user.name", "Dev"); git("add", "-A"); git("commit", "-q", "-m", "Initial");

const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const card = (session, agent, ago, fields) => writeFileSync(join(snoutDir, "memory", `${session}.json`), JSON.stringify({ v: 1, id: session, session, agent, started: day(ago), updated: day(ago - 0.02), changed: [], rules: [], commits: [], ...fields }, null, 1));
const DECISION = "s-reminders-7f3a";
card(DECISION, "codex", 3, {
  task: "Agree with the clinic when vaccination reminders go out, before we build them.",
  outcome: "We agreed with the clinic on vaccination reminders. They go out 10 days before the booster is due. The send time is 07:30 in the clinic's time zone, and a second reminder follows 2 days before the due date if the owner has not booked a visit by then. Nothing is built yet.",
});
card("s-invoices-21c0", "claude", 5, { task: "Add an invoice PDF export in src/billing/invoice.js.", outcome: "src/billing/invoice.js exports an invoice PDF with the clinic's letterhead. 12 tests pass.", changed: ["src/billing/invoice.js"] });
card("s-bookings-9d42", "claude", 2, { task: "Fix overlapping bookings for the same vet.", outcome: "Bookings for the same vet and slot run in one transaction, so overlapping bookings are refused. 14 tests pass.", changed: ["src/appointments/book.js"] });
const env = { ...process.env, SNOUT_DIR: snoutDir, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: project, CI: "", SNOUT_TOKEN: "" };
spawnSync(process.execPath, [SNOUT_BIN, "memory", "add", "Pet weights are stored in grams as integers.", "--kind", "decision"], { cwd: project, env, encoding: "utf8" });
const server = { command: process.execPath, args: [SNOUT_BIN, "mcp", project, "--tools", TOOLS.join(",")], env: { SNOUT_DIR: snoutDir, SNOUT_CONFIG_DIR: cfg } };

const PROMPT = "In src/reminders/vaccines.js, implement reminderPlan so the vaccination reminders go out the way we agreed with the clinic in an earlier session. Add a small test with node:test and run it.";

// ---------------------------------------------------------------- the session

async function claude() {
  const session = randomUUID();
  const mcpFile = join(run, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { snout: server } }));
  const argv = ["-p", PROMPT, "--output-format", "json", "--model", MODEL, "--session-id", session, "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", mcpFile, "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "Bash", ...TOOLS.map((t) => `mcp__snout__${t}`),
    "--disallowedTools", "WebFetch", "WebSearch", "--max-budget-usd", "1.00"];
  const r = await launchClaude(project, argv, { env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", CI: "" }, limitMs: 15 * 60_000 });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 400) }; }
  // Tool calls and their results, from the transcript.
  const root = join(homedir(), ".snout-bench", "claude-home", "projects");
  const file = (() => { try { return readdirSync(root, { recursive: true }).map(String).find((p) => p.endsWith(`${out.session_id ?? session}.jsonl`)); } catch { return null; } })();
  const calls = [], results = new Map();
  for (const l of file ? readFileSync(join(root, file), "utf8").split("\n") : []) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (b.type === "tool_use") calls.push({ id: b.id, name: b.name, input: b.input });
      if (b.type === "tool_result") results.set(b.tool_use_id, typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    }
  }
  const u = out.usage ?? {};
  return {
    calls: calls.map((c) => ({ tool: c.name.replace(/^mcp__snout__/, ""), input: c.input, result: results.get(c.id) ?? "" })),
    tokens: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
    costUsd: out.total_cost_usd ?? null, turns: out.num_turns ?? null, error: out.is_error ? String(out.result ?? out.subtype).slice(0, 300) : undefined, final: String(out.result ?? "").slice(0, 600),
  };
}

const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(",")}]` : typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(",")}}` : `'${String(v)}'`);

async function codex() {
  const cli = process.env.CODEX_CLI_JS || join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  const argv = [cli, "exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-C", project, "-m", MODEL, "-c", "model_reasoning_effort=low",
    "-c", "project_doc_max_bytes=0", "-c", `mcp_servers={snout=${toml(server)}}`, PROMPT];
  const r = await new Promise((done) => {
    const child = spawn(process.execPath, argv, { cwd: project, env: { ...process.env, CI: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.on("close", () => { clearTimeout(timer); done({ stdout, stderr }); });
  });
  const calls = []; let input = 0, cached = 0, output = 0, error, final = "";
  for (const l of r.stdout.split("\n")) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === "turn.completed" && e.usage) { input += e.usage.input_tokens ?? 0; cached += e.usage.cached_input_tokens ?? 0; output += e.usage.output_tokens ?? 0; }
    else if (e.type === "item.completed" && e.item?.type === "mcp_tool_call") calls.push({ tool: String(e.item.tool), input: e.item.arguments, result: JSON.stringify(e.item.result ?? e.item.error ?? "") });
    else if (e.type === "item.completed" && e.item?.type === "command_execution") calls.push({ tool: "shell", input: e.item.command, result: "" });
    else if (e.type === "item.completed" && e.item?.type === "agent_message") final = String(e.item.text ?? "").slice(0, 600);
    else if (e.type === "error" || e.type === "turn.failed") error = String(e.message ?? e.error?.message ?? e.type);
  }
  if (!r.stdout.trim()) error = (r.stderr || "no output").slice(-400);
  return { calls, tokens: { input, cached, output }, costUsd: null, error, final };
}

const s = AGENT === "codex" ? await codex() : await claude();

// ---------------------------------------------------------------- grading

const searches = s.calls.filter((c) => c.tool === "snout_memory_search");
const fetches = s.calls.filter((c) => c.tool === "snout_memory_fetch");
const found = searches.some((c) => c.result.includes(DECISION));
const fetched = fetches.some((c) => JSON.stringify(c.input ?? "").includes(DECISION) && /07:30/.test(c.result));
let used = false, got = null;
try {
  const mod = await import(`${pathToFileURL(join(project, "src", "reminders", "vaccines.js")).href}?t=${Date.now()}`);
  got = { open: mod.reminderPlan("2026-12-15", { booked: false }), booked: mod.reminderPlan("2026-12-15", { booked: true }) };
  used = JSON.stringify(got.open) === JSON.stringify(["2026-12-05 07:30", "2026-12-13 07:30"]) && JSON.stringify(got.booked) === JSON.stringify(["2026-12-05 07:30"]);
} catch (err) { got = { error: String(err.message ?? err).slice(0, 200) }; }

const result = { agent: AGENT, model: MODEL, ranAt: new Date().toISOString(), ...stamp(), project, pass: found && fetched && used, found, fetched, used, got, memoryCalls: [...searches, ...fetches].map((c) => ({ tool: c.tool, input: c.input, result: c.result.slice(0, 1500) })), toolsUsed: s.calls.map((c) => c.tool), tokens: s.tokens, costUsd: s.costUsd, turns: s.turns, error: s.error, final: s.final };
const out = join(REPO, "bench", "ab-results", `memory-smoke-${AGENT}-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
console.log(`${AGENT} ${MODEL}: ${result.pass ? "PASS" : "FAIL"}  found ${found}, fetched ${fetched}, used ${used}`);
console.log(`  memory calls: ${[...searches, ...fetches].map((c) => `${c.tool}(${JSON.stringify(c.input)})`).join("; ") || "none"}`);
console.log(`  tools: ${result.toolsUsed.join(", ")}`);
console.log(`  reminderPlan: ${JSON.stringify(got)}`);
console.log(`  tokens ${JSON.stringify(s.tokens)}${s.costUsd != null ? `, $${s.costUsd.toFixed(4)}` : ""}${s.error ? `; error: ${s.error}` : ""}`);
console.log(`  ${out}`);
