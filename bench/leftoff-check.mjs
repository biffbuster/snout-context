#!/usr/bin/env node
/**
 * Free, offline check of "where the last session left off" (src/memory/memory.ts leftOff), the note a
 * new session's first prompt gets, before any paid run:
 *
 * 1. Continuity: for each direction of spec-leftoff.json, the receiver's first prompt against its
 *    giver's record and the project as the giver left it (its git history plus the snapshot), from the
 *    continuity results: is the note shown, does it carry the decision (the spec's recordPattern), and
 *    its size. A control's prompt names a file the giver left unfinished but asks for something else:
 *    the note should be shown there only because of the file name, never because the prompt asks to continue.
 * 2. Unrelated prompts: how often a prompt that continues nothing still reads as asking to continue
 *    (asksToContinue), on SWE-bench Verified's issue texts and the recall-gate prompt sets. A gate
 *    prompt it fires on is listed, since some of those prompts do ask to continue.
 *
 *   node bench/leftoff-check.mjs [results files: default, the spec's giversFrom] [--show]
 *
 * Reads dist/lib.mjs (npm run build first). Makes no network or model calls.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asksToContinue, estimateTokens, leftOff, MEMORY_BUDGET, workCards, workingState } from "../dist/lib.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const SPEC = JSON.parse(readFileSync(join(REPO, "bench/handoff/spec-leftoff.json"), "utf8"));
const runs = join(homedir(), ".snout-bench", "handoff-runs");
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, windowsHide: true, ...o });

// ---------- 1. Continuity ----------
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const givers = (files.length ? files : SPEC.giversFrom).flatMap((f) => {
  const saved = JSON.parse(readFileSync(resolve(REPO, f), "utf8"));
  return saved.directions.map((d) => ({ runId: saved.runId, d }));
});
const rows = [];
for (const spec of SPEC.directions) {
  const hit = givers.find((g) => g.d.id === (spec.giverFrom ?? spec.id));
  const dir = hit && join(runs, hit.runId, hit.d.id);
  if (!dir || !existsSync(join(dir, "store", "snout"))) { rows.push({ id: spec.id, missing: true }); continue; }
  // The project as the giver left it: its history, then its working tree on top.
  const ws = mkdtempSync(join(tmpdir(), "snout-leftoff-"));
  try {
    sh("git", ["clone", "-q", "-b", hit.d.snapshot.history.branch, join(dir, "history.bundle"), ws]);
    cpSync(join(dir, "snapshot"), ws, { recursive: true });
    const note = leftOff(workCards(join(dir, "store", "snout"), 2), { ...workingState(ws), prompt: spec.receiverPrompt });
    const decision = new RegExp(spec.recordPattern, "i");
    rows.push({ id: spec.id, control: !!spec.control, continues: asksToContinue(spec.receiverPrompt), shown: !!note, decision: decision.test(note), tokens: note ? estimateTokens(Buffer.byteLength(note), "x.md") : 0, note });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}
if (rows.length) {
  const size = (r) => `~${r.tokens} tokens${r.tokens > MEMORY_BUDGET ? " (OVER the prompt budget: not shown)" : ""}`;
  console.log("1. Continuity: the receiver's first prompt against the giver's record and project");
  for (const r of rows.filter((x) => !x.control)) console.log(r.missing ? `  ${r.id.padEnd(30)} run files missing` : `  ${r.id.padEnd(30)} ${r.shown ? "shown" : "NOT shown"}  ${r.decision ? "carries the decision" : "decision MISSING"}  ${size(r)}`);
  const cont = rows.filter((r) => !r.control);
  console.log(`  ${cont.filter((r) => r.shown && r.decision && r.tokens <= MEMORY_BUDGET).length} of ${cont.length} show the note with the decision in it, within the ${MEMORY_BUDGET}-token prompt budget (estimated as prose)`);
  const ctl = rows.filter((r) => r.control);
  if (ctl.length) {
    console.log("  Controls (the prompt names an unfinished file and asks for something else):");
    for (const r of ctl) console.log(r.missing ? `  ${r.id.padEnd(30)} run files missing` : `  ${r.id.padEnd(30)} ${r.shown ? "shown" : "NOT shown"}  ${r.continues ? "the prompt READS AS continuing" : "by the file name alone"}  ${size(r)}`);
    console.log(`  ${ctl.filter((r) => r.shown && !r.continues && r.tokens <= MEMORY_BUDGET).length} of ${ctl.length} show the note by the file name alone, within the budget: each control tests what the note does to unrelated work`);
  }
  console.log("");
  if (process.argv.includes("--show")) for (const r of rows.filter((x) => x.note)) console.log(`--- ${r.id}\n${r.note}\n`);
}

// ---------- 2. Unrelated prompts ----------
const SWE_PY = process.env.SWE_PY || (WIN ? join(REPO, ".snout/heldout/venv3/Scripts/python.exe") : join(homedir(), "opt/anaconda3/envs/swebench/bin/python"));
const PRELUDE = WIN ? "import sys, types\nsys.modules.setdefault('resource', types.ModuleType('resource'))\n" : "";
const swe = sh(SWE_PY, ["-c", `${PRELUDE}import json\nfrom swebench.harness.utils import load_swebench_dataset\nds = load_swebench_dataset("SWE-bench/SWE-bench_Verified", "test")\nprint(json.dumps([{"id": d["instance_id"], "prompt": d["problem_statement"]} for d in ds]))`], { env: { ...process.env, HF_HUB_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" } });
let issues = [];
try { issues = JSON.parse(swe.stdout); } catch { console.log("2. SWE-bench Verified issue texts: not available here (no cached dataset or Python); skipped"); }
if (issues.length) {
  const fired = issues.filter((i) => asksToContinue(i.prompt));
  console.log(`2. Unrelated prompts\n  SWE-bench Verified issue texts: reads as "continue" on ${fired.length} of ${issues.length}`);
  for (const i of fired) {
    const m = /\b(?:continue|resume|pick (?:it )?up|left off|last session|unfinished|carry on|finish\w*)\b/i.exec(i.prompt);
    console.log(`    ${i.id}: …${JSON.stringify(i.prompt.slice(Math.max(0, (m?.index ?? 0) - 50), (m?.index ?? 0) + 50))}…`);
  }
}
const sets = ["", ...readdirSync(join(REPO, "bench/recall-gate")).filter((d) => /^unseen\d*$/.test(d))];
const gate = sets.flatMap((s) => {
  const f = join(REPO, "bench/recall-gate", s, "prompts.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).prompts.map((p) => ({ set: s || "main", ...p })) : [];
});
const gateFired = gate.filter((p) => asksToContinue(p.prompt));
console.log(`  Recall-gate prompts (${sets.length} sets): reads as "continue" on ${gateFired.length} of ${gate.length}; each, to judge by hand:`);
for (const p of gateFired) console.log(`    ${p.set}/${p.id}: ${JSON.stringify(p.prompt.slice(0, 140))}`);
