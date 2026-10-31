#!/usr/bin/env node
/**
 * The lesson loop, end to end, on the billing project (bench/handoff/berthbook), both directions:
 * Claude Code → Codex, then Codex → Claude Code. Free and offline: stand-in agents drive Snout's real
 * hooks, MCP server and CLI, and the project's tests run for real.
 *
 *   node bench/lesson-handoff.mjs              # prints what was saved, approved, found and used, and the test results
 *   node bench/lesson-handoff.mjs --json out.json
 *
 * Per direction:
 *   giver     The user gives finance's two export formats and asks for the invoice export only
 *             (spec-record.json's task). The stand-in writes a test, sees it fail, applies the
 *             reference fix, sees the suite pass, and proposes two lessons over MCP: the portal
 *             format the user gave (basis decision, quoting the user), and one quoting words the
 *             user never typed. Snout's Stop hook checks both against the session's record.
 *   review    A stand-in for the person, in this check's own throwaway store: it reads
 *             `snout memory review`, tries to approve both (only the backed one goes through), and
 *             approves it as the replacement for an older, wrong lesson.
 *   receiver  The other agent, in a fresh session, gets "the format finance gave us" for the fuel
 *             export. The stand-in searches with words from its prompt, opens the lesson, applies
 *             the reference fix, and the hidden tests grade the result.
 * Lessons that must stay out of every search are seeded first: an outdated one (replaced at review),
 * one whose file changed since, one from another project, one never approved, one rejected, and one
 * that shares a single word with the receiver's question. An unrelated approved lesson must appear
 * only for a question about its own topic.
 *
 * What this shows: the loop works through Snout's own code in both agents' formats, and what is
 * kept out. What it cannot show: whether a real agent searches, trusts the lesson and uses it. The
 * stand-ins search and apply by script; the live check (docs/memory-lessons.md) runs real agents.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "dist", "snout.mjs");
const HERE = join(REPO, "bench", "handoff", "berthbook");
const SPEC = JSON.parse(readFileSync(join(REPO, "bench", "handoff", "spec-record.json"), "utf8")).directions.find((d) => d.project === "berthbook");
const lib = await import(pathToFileURL(join(REPO, "dist", "lib.mjs")).href);
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

/** The portal format as the user typed it in the giver's prompt: the words the lesson must quote. */
const QUOTE = "Fuel sales, for the supplier's portal: tab-separated, litres with three decimals and a decimal point, amounts in whole cents.";
if (!SPEC.giverPrompt.includes(QUOTE)) throw new Error("spec-record.json's giver prompt no longer holds the quoted format");
const LESSON = "Fuel sales for the supplier's portal export tab-separated, litres with three decimals and a decimal point, amounts in whole cents; the invoice CSV format (semicolons, decimal comma) is not the portal's.";
const APPLIES = "exporting fuel sales for the supplier's portal (berthbook export-fuel)";
const RECEIVER_QUERY = "fuel sales export supplier portal format";
const USED = new RegExp(SPEC.codePattern);

const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: "utf8", timeout: 120_000, ...opts });
const tokens = (s) => Math.ceil(Buffer.byteLength(s) / 4);

function workspace(tag) {
  const ws = mkdtempSync(join(tmpdir(), `snout-lessons-${tag}-`));
  const cfg = mkdtempSync(join(tmpdir(), `snout-lessons-cfg-`));
  cpSync(join(HERE, "base"), ws, { recursive: true });
  sh("git", ["init", "-q"], { cwd: ws });
  sh("git", ["config", "user.email", "reviewer@example.com"], { cwd: ws });
  sh("git", ["config", "user.name", "Reviewer"], { cwd: ws });
  sh("git", ["add", "-A"], { cwd: ws });
  sh("git", ["commit", "-qm", "berthbook"], { cwd: ws });
  const env = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: ws, SNOUT_MODE: "enforce", PYTHONDONTWRITEBYTECODE: "1" };
  for (const k of ["CI", "SNOUT_TOKEN", "SNOUT_MEMORY_NOTES"]) delete env[k];
  return { ws, cfg, env, snout: (a, input) => sh(process.execPath, [CLI, ...a], { cwd: ws, env, ...(input === undefined ? {} : { input }) }).stdout };
}

const pytest = (dir) => {
  const r = sh("python", ["-m", "pytest", "-q", "-p", "no:cacheprovider"], { cwd: dir, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim(), line: `${r.stdout}`.trim().split("\n").pop() ?? "" };
};

/** Snout's MCP server, as the plugin and `snout init codex` register it: one request per tool call, in order. */
function mcp(w, calls) {
  const msgs = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ...calls.map(([name, a], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: a } }))];
  const out = w.snout(["mcp", w.ws, "--tools", "snout_memory_search,snout_memory_fetch,snout_memory_propose"], msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return calls.map((_, i) => { const r = replies.find((x) => x.id === i + 1)?.result; return { text: r?.content?.[0]?.text ?? "", error: !!r?.isError }; });
}

/**
 * A stand-in session, in Claude Code's transcript or Codex's rollout format, firing Snout's hooks as
 * that agent does. `work(run)` does the session's work; `run(command)` runs a real command and records it.
 */
function session(w, agent, prompt, work) {
  const id = agent === "codex" ? randomUUID() : `claude-${randomUUID()}`;
  const transcript = join(w.cfg, `${id}.jsonl`);
  const row = (o) => appendFileSync(transcript, JSON.stringify(o) + "\n");
  const hook = (event, extra = {}) => {
    const input = JSON.stringify({ cwd: w.ws, session_id: id, transcript_path: transcript, hook_event_name: event, ...extra });
    const cmd = agent === "codex" ? ["hook", "codex", event] : [{ SessionStart: "session-start", UserPromptSubmit: "prompt-submit", Stop: "stop", PostToolUse: "post-tool" }[event]];
    const out = w.snout(cmd, input).trim();
    try { return out ? JSON.parse(out) : {}; } catch { return {}; }
  };
  if (agent === "codex") row({ type: "session_meta", payload: { id, cwd: w.ws, originator: "lesson-handoff" } });
  const start = hook("SessionStart", { source: "startup" });
  const prompted = hook("UserPromptSubmit", { prompt });
  if (agent === "codex") row({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });
  else row({ type: "user", message: { content: prompt } });
  let n = 0;
  const run = (command, shown = command) => {
    const r = command === "pytest" ? pytest(w.ws) : null;
    const out = r ? r.out : "";
    const callId = `call_${n++}`;
    if (agent === "codex") {
      row({ type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: shown }), call_id: callId } });
      row({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output: `${out}\nExit code: ${r?.ok ? 0 : 1}` } });
    } else {
      row({ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name: "Bash", input: { command: shown } }] } });
      row({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: callId, content: out, ...(r?.ok ? {} : { is_error: true }) }] } });
    }
    hook("PostToolUse", { tool_name: "Bash", tool_input: { command: shown }, tool_response: out, tool_use_id: callId });
    return r;
  };
  const edited = (file) => {
    if (agent === "claude") row({ type: "assistant", message: { content: [{ type: "tool_use", id: `edit_${n++}`, name: "Edit", input: { file_path: join(w.ws, file) } }] } });
    else row({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch`, call_id: `call_${n++}` } });
  };
  // The MCP server names the session the hooks saw last here: this one.
  const result = work({ run, edited, id });
  const say = result.say ?? "Done; tests pass.";
  if (agent === "codex") row({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: say }] } });
  else row({ type: "assistant", message: { content: [{ type: "text", text: say }] } });
  hook("Stop");
  return { id, start: start?.hookSpecificOutput?.additionalContext ?? "", injected: prompted?.hookSpecificOutput?.additionalContext ?? "", ...result };
}

/** Lessons already in the store before the giver's: what must stay out, and one unrelated lesson that must not leak into the receiver's search. */
function seed(w) {
  const stores = lib.storesFor(w.ws, join(w.ws, ".snout"), w.cfg);
  const user = lib.userPrincipal(w.ws);
  const day = (d) => new Date(`2026-10-${String(d).padStart(2, "0")}T10:00:00Z`);
  const backed = (s, n, session, d) => {
    const o = lib.proposeLesson(s, user, { ...n, session, agent: n.agent ?? "claude" }, day(d));
    lib.checkProposals(s, { session, test: { command: "python -m pytest -q", result: "6 passed in 0.21s" }, commits: [] }, [n.evidence], day(d));
    return o;
  };
  const approve = (s, o, d) => lib.approveLesson(s, o.id, {}, day(d));
  const fuelOld = approve(stores, backed(stores, { text: "Fuel sales for the supplier's portal export comma-separated, with amounts in euros and two decimals.", basis: "decision", applies: "exporting fuel sales for the supplier's portal", evidence: "the portal takes comma-separated euros with two decimals" }, "seed-old", 3), 3);
  const fuelHeld = lib.proposeLesson(stores, user, { text: "Fuel sale totals for an export come from fuel.py's sale_cents, which rounds once per sale.", basis: "test", applies: "computing fuel sales totals for an export", evidence: "python -m pytest -q", files: ["berthbook/fuel.py"], session: "seed-held", agent: "codex" }, day(5));
  lib.checkProposals(stores, { session: "seed-held", test: { command: "python -m pytest -q", result: "6 passed in 0.20s" }, commits: [] }, [], day(5));
  approve(stores, fuelHeld, 5);
  // A later commit changed fuel.py: the lesson about it is held back until someone checks it again.
  appendFileSync(join(w.ws, "berthbook", "fuel.py"), "\n# Rounding reviewed 2026-10-20.\n");
  sh("git", ["commit", "-qam", "fuel: note on rounding"], { cwd: w.ws });
  const other = lib.storesFor(join(w.ws, "..", "another-billing-app"), join(w.ws, ".snout"), w.cfg, "another-billing-app");
  const elsewhere = approve(other, backed(other, { text: "Fuel sales for the supplier's portal export as semicolon CSV with a VAT column.", basis: "decision", applies: "exporting fuel sales for the supplier's portal", evidence: "add a VAT column to the portal export" }, "seed-other", 6), 6);
  const pending = backed(stores, { text: "Fuel sales exports for the supplier's portal should list litres before the vessel name.", basis: "decision", applies: "exporting fuel sales for the supplier's portal", evidence: "litres first, then the vessel" }, "seed-pending", 7);
  const rejected = lib.rejectLesson(stores, backed(stores, { text: "Fuel sales for the supplier's portal use a decimal comma for litres.", basis: "decision", applies: "exporting fuel sales for the supplier's portal", evidence: "use a decimal comma for the litres" }, "seed-rejected", 8).id, "wrong: that is the invoice format", day(8));
  const weak = approve(stores, backed(stores, { text: "Portal uploads over 5 MB are refused; split a large month by week.", basis: "decision", applies: "uploading files to a web portal", evidence: "uploads over 5 MB are refused" }, "seed-weak", 9), 9);
  const unrelated = approve(stores, backed(stores, { text: "A berth booking that crosses midnight is billed in the month its hours start, as invoices_for_month does.", basis: "test", applies: "invoicing berth bookings that cross midnight or a month end", evidence: "python -m pytest -q", files: [] , agent: "codex" }, "seed-unrelated", 10), 10);
  return { stores, out: { outdated: fuelOld.id, heldBack: fuelHeld.id, otherProject: elsewhere.id, neverApproved: pending.id, rejected: rejected.id, weakMatch: weak.id }, unrelated: unrelated.id };
}

function direction(giver, receiver) {
  const w = workspace(`${giver}-to-${receiver}`);
  if (giver === "codex" || receiver === "codex") w.snout(["init", "codex"]);
  const seeded = seed(w);
  const trace = { direction: `${giver} → ${receiver}`, project: "berthbook (billing)", workspace: w.ws };

  // ---- giver
  const g = session(w, giver, SPEC.giverPrompt, ({ run, edited }) => {
    cpSync(join(HERE, "hidden", "test_handoff_giver.py"), join(w.ws, "tests", "test_export_invoices.py"));
    edited("tests/test_export_invoices.py");
    const before = run("pytest", "python -m pytest -q");
    cpSync(join(HERE, SPEC.grade.refGiver), w.ws, { recursive: true });
    edited("berthbook/cli.py");
    edited("berthbook/finance.py");
    const after = run("pytest", "python -m pytest -q");
    const proposed = mcp(w, [
      ["snout_memory_propose", { text: LESSON, applies_when: APPLIES, basis: "decision", evidence: QUOTE, files: [] }],
      ["snout_memory_propose", { text: "Fuel sales for the supplier's portal need a VAT column after the amount.", applies_when: APPLIES, basis: "decision", evidence: "the portal needs a VAT column after the amount" }],
    ]);
    return { before: before.line, after: after.line, proposed, say: SPEC.dryRunSay };
  });
  const stores = seeded.stores;
  const all = lib.lessons(stores);
  const mine = all.filter((o) => o.source.session === g.id);
  const good = mine.find((o) => o.text === LESSON);
  const bad = mine.find((o) => o !== good);
  trace.giver = { agent: giver, session: g.id, tests: { before: g.before, after: g.after }, proposed: g.proposed.map((p) => p.text) };
  trace.saved = mine.map((o) => ({ id: o.id, lesson: o.text, applies: o.lesson.applies, basis: o.lesson.basis, evidence: o.source.evidence, session: o.source.session, agent: o.source.agent, date: o.created.slice(0, 10), project: o.project, check: o.lesson.check, record: o.lesson.checked ?? null }));

  // ---- review (a stand-in for the person)
  const review = w.snout(["memory", "review"]);
  const refusedBad = w.snout(["memory", "approve", bad.id]);
  const approvedGood = w.snout(["memory", "approve", good.id, "--replaces", seeded.out.outdated]);
  w.snout(["memory", "reject", bad.id, "the user never asked for a VAT column"]);
  trace.review = { listed: review, approveUnbacked: refusedBad.trim().split("\n")[0], approved: approvedGood.trim().split("\n")[0], afterReview: lib.lessons(stores).filter((o) => o.source.session === g.id).map((o) => `${o.id} ${o.status}${o.lesson.review ? ` (${o.lesson.review.verdict})` : ""}`) };

  // ---- receiver
  const r = session(w, receiver, SPEC.receiverPrompt, ({ run, edited }) => {
    const [search] = mcp(w, [["snout_memory_search", { query: RECEIVER_QUERY }]]);
    const shown = [...new Set(search.text.match(/\bo_[a-f0-9]{12}\b/g) ?? [])];
    const [fetch] = shown.includes(good.id) ? mcp(w, [["snout_memory_fetch", { id: good.id }]]) : [{ text: "" }];
    const [other] = mcp(w, [["snout_memory_search", { query: "berth booking crosses midnight invoice month" }]]);
    const before = readFileSync(join(w.ws, "berthbook", "cli.py"), "utf8");
    cpSync(join(HERE, SPEC.grade.refReceiver), w.ws, { recursive: true });
    edited("berthbook/cli.py");
    const after = run("pytest", "python -m pytest -q");
    return { search, shown, fetch, other, usedBefore: USED.test(before), usedAfter: USED.test(readFileSync(join(w.ws, "berthbook", "cli.py"), "utf8")), after: after.line, say: "Added export-fuel in the portal format finance gave (tab-separated, three-decimal litres, whole cents). Tests pass." };
  });
  const keptOut = Object.fromEntries(Object.entries(seeded.out).map(([k, id]) => [k, { id, shown: r.shown.includes(id) || [...(r.other.text.match(/\bo_[a-f0-9]{12}\b/g) ?? [])].includes(id) }]));
  trace.receiver = { agent: receiver, session: r.id, sessionStart: r.start, injectedOnPrompt: r.injected || "(nothing)" };
  trace.found = { query: RECEIVER_QUERY, firstLine: r.search.text.split("\n")[1] ?? "", lessonShown: r.shown.includes(good.id), lessonFirst: (r.search.text.split("\n")[1] ?? "").includes(good.id), lessonsShown: r.shown, memoryTokens: tokens(r.search.text) };
  trace.opened = { id: good.id, evidence: r.fetch.text, memoryTokens: tokens(r.fetch.text) };
  trace.unrelatedQuery = { query: "berth booking crosses midnight invoice month", unrelatedShown: r.other.text.includes(seeded.unrelated), portalLessonShown: r.other.text.includes(good.id) };
  trace.keptOut = keptOut;
  trace.used = { inProjectBefore: r.usedBefore, inWorkAfter: r.usedAfter, by: "stand-in (scripted): applied the reference fix after opening the lesson" };

  // ---- grade on a clean copy: the project's own tests, the giver's hidden tests and the receiver's
  const grade = mkdtempSync(join(tmpdir(), "snout-lessons-grade-"));
  cpSync(w.ws, grade, { recursive: true, filter: (src) => !/[\\/](\.git|\.snout|\.codex|\.agents|__pycache__)([\\/]|$)/.test(src) });
  for (const t of SPEC.grade.baseTests) cpSync(join(HERE, "base", t), join(grade, t));
  for (const t of [...SPEC.grade.giverTests, ...SPEC.grade.receiverTests]) cpSync(join(HERE, t), join(grade, "tests", t.split("/").pop()));
  rmSync(join(grade, "tests", "test_export_invoices.py"), { force: true });
  const final = pytest(grade);
  trace.result = { solved: final.ok, tests: final.line };
  trace.recallLog = readFileSync(join(w.ws, ".snout", "recall.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((x) => `${x.kind}${x.kind === "inject" ? ` (would-show ${x.items?.length ?? 0} note${x.items?.length === 1 ? "" : "s"}; added to the prompt: ${x.injected})` : ""}${x.asked ? ` "${String(x.asked).slice(0, 50)}"` : ""}${x.shown ? ` → ${x.shown.length} shown` : ""}${x.session ? ` (${String(x.session).slice(0, 14)})` : ""}`);
  rmSync(grade, { recursive: true, force: true });
  return trace;
}

const traces = [direction("claude", "codex"), direction("codex", "claude")];
const ok = (t) => t.saved.length === 2 && t.saved.some((s) => s.check === "verified") && t.saved.some((s) => s.check === "pending")
  && /can't be approved/.test(t.review.approveUnbacked) && /^Approved /.test(t.review.approved)
  && t.found.lessonFirst && t.opened.evidence.includes(QUOTE) && Object.values(t.keptOut).every((k) => !k.shown)
  && t.unrelatedQuery.unrelatedShown && !t.unrelatedQuery.portalLessonShown && !t.used.inProjectBefore && t.used.inWorkAfter && t.result.solved && t.receiver.injectedOnPrompt === "(nothing)";

for (const t of traces) {
  const cut = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
  console.log(`\n${t.direction} · ${t.project}`);
  console.log(`  giver (${t.giver.agent}, ${t.giver.session.slice(0, 18)}): tests ${t.giver.tests.before} → ${t.giver.tests.after}`);
  console.log("  saved (proposals):");
  for (const s of t.saved) console.log(`    ${s.id} [${s.basis}; ${s.check}] "${cut(s.lesson, 90)}"\n      applies when: ${s.applies} · from ${s.agent}, ${s.date}, project ${s.project.slice(0, 12)}\n      record: ${s.record ? cut(s.record, 120) : "nothing: the user never typed those words"}`);
  console.log(`  review: ${t.review.approveUnbacked}`);
  console.log(`          ${t.review.approved}`);
  console.log(`          after: ${t.review.afterReview.join(" · ")}`);
  console.log(`  receiver (${t.receiver.agent}): session-start line: ${t.receiver.sessionStart ? `"${cut(t.receiver.sessionStart, 110)}"` : "(none)"}; added to its prompt: ${t.receiver.injectedOnPrompt}`);
  console.log(`  found: search "${t.found.query}" → ${t.found.lessonShown ? "approved lesson shown" : "lesson NOT shown"}${t.found.lessonFirst ? ", first" : ""}; lessons shown: ${t.found.lessonsShown.join(", ") || "none"} (${t.found.memoryTokens} tokens)`);
  console.log(`         ${cut(t.found.firstLine, 230)}`);
  console.log(`  opened: fetch ${t.opened.id} (${t.opened.memoryTokens} tokens), evidence quotes the user: ${t.opened.evidence.includes(QUOTE)}`);
  console.log(`  kept out: ${Object.entries(t.keptOut).map(([k, v]) => `${k} ${v.shown ? "SHOWN" : "out"}`).join(" · ")}`);
  console.log(`  unrelated question ("${t.unrelatedQuery.query}"): its own lesson shown ${t.unrelatedQuery.unrelatedShown}, the portal lesson shown ${t.unrelatedQuery.portalLessonShown}`);
  console.log(`  used: format in the project before: ${t.used.inProjectBefore}; in the receiver's work: ${t.used.inWorkAfter} (${t.used.by})`);
  console.log(`  result: ${t.result.solved ? "solved" : "NOT solved"} · ${t.result.tests}`);
  console.log(`  recall log: ${t.recallLog.join(" · ")}`);
  console.log(`  check: ${ok(t) ? "PASS" : "FAIL"}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ranAt: new Date().toISOString(), standIn: true, traces: traces.map((t) => ({ ...t, pass: ok(t) })) }, null, 1));
for (const t of traces) rmSync(t.workspace, { recursive: true, force: true });
process.exit(traces.every(ok) ? 0 : 1);
