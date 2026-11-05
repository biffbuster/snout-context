#!/usr/bin/env node
/** Free, frozen diagnostic of opt-in approved lessons through both real prompt hooks. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { approveLesson, checkProposals, proposeLesson, storesFor, userPrincipal } from "../dist/lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..");
const setAt = process.argv.indexOf("--set");
const set = setAt < 0 ? "cases" : process.argv[setAt + 1];
if (!/^[a-z][a-z0-9-]*$/.test(set ?? "")) throw new Error("--set needs a simple name");
const CASES = join(HERE, `lesson-delivery-${set}.json`);
const FREEZE = join(HERE, `lesson-delivery-${set}-freeze.json`);
const CLI = join(REPO, "dist", "snout.mjs");
const files = [`bench/lesson-delivery-${set}.json`, "bench/lesson-delivery-safety.mjs", "dist/snout.mjs", "dist/lib.mjs"];
const hash = (path) => createHash("sha256").update(readFileSync(join(REPO, path))).digest("hex");
const hashes = () => Object.fromEntries(files.map((f) => [f, hash(f)]));
const data = JSON.parse(readFileSync(CASES, "utf8"));
const diagnostic = process.argv.includes("--diagnose");
const jsonLines = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
};
if (process.argv.includes("--freeze")) {
  if (diagnostic) throw new Error("--freeze and --diagnose cannot be combined");
  writeFileSync(FREEZE, JSON.stringify({ frozenAt: new Date().toISOString(), criteria: data.criteria, files: hashes() }, null, 2) + "\n");
  console.log("Frozen 40 prompts and the current hook bundle.");
  process.exit(0);
}
if (!diagnostic && !existsSync(FREEZE)) throw new Error("Freeze the cases first: node bench/lesson-delivery-safety.mjs --freeze");
const frozen = diagnostic ? null : JSON.parse(readFileSync(FREEZE, "utf8"));
if (!diagnostic && (JSON.stringify(frozen.files) !== JSON.stringify(hashes()) || JSON.stringify(frozen.criteria) !== JSON.stringify(data.criteria))) throw new Error("Cases, runner, criteria or bundle changed since freeze");

const root = mkdtempSync(join(tmpdir(), "snout-lesson-delivery-"));
const cfg = mkdtempSync(join(tmpdir(), "snout-lesson-config-"));
const report = { frozenAt: frozen?.frozenAt ?? null, diagnostic, build: hashes(), cases: data.prompts.length, criteria: data.criteria, agents: {} };
try {
  const git = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  if (git.status !== 0) throw new Error(`git init: ${git.stderr}`);
  mkdirSync(join(root, ".snout"), { recursive: true });
  const store = storesFor(root, join(root, ".snout"), cfg);
  const who = userPrincipal(root);
  const idFor = new Map();
  for (const l of data.lessons) {
    const session = `seed-${l.id}`;
    const o = proposeLesson(store, who, { text: l.text, basis: l.basis, applies: l.applies, evidence: l.evidence, session, agent: "claude" });
    checkProposals(store, { session, agent: "claude", test: { command: "node --test", result: "# pass 8" }, commits: [] }, l.basis === "decision" ? [l.evidence] : []);
    approveLesson(store, o.id);
    idFor.set(o.id, l.id);
  }
  const env = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: root, SNOUT_MODE: "enforce", SNOUT_MEMORY_NOTES: "1", SNOUT_MEMORY: "1", SNOUT_TOKEN: "", TYPESAFE_API_KEY: "" };
  delete env.CI;
  for (const agent of ["claude", "codex"]) {
    const rows = [];
    for (const c of data.prompts) {
      const session = `delivery-${agent}-${c.id}`;
      const input = JSON.stringify({ cwd: root, session_id: session, hook_event_name: "UserPromptSubmit", prompt: c.text, ...(agent === "codex" ? { model: "stand-in" } : {}) });
      const command = agent === "codex" ? ["hook", "codex", "UserPromptSubmit"] : ["prompt-submit"];
      const result = spawnSync(process.execPath, [CLI, ...command], { cwd: root, input, env, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`${agent}/${c.id}: ${result.stderr || result.stdout}`);
      const logged = jsonLines(join(root, ".snout", "recall.jsonl")).filter((x) => x.kind === "inject" && x.session === session && x.injected).at(-1);
      const shown = [...new Set((logged?.items ?? []).map((id) => idFor.get(id) ?? `unknown:${id}`))];
      let context = "";
      if (result.stdout.trim()) {
        const output = JSON.parse(result.stdout);
        context = output.hookSpecificOutput?.additionalContext ?? "";
      }
      const sourceSeen = shown.every((id) => id.startsWith("unknown:") || context.includes(data.lessons.find((l) => l.id === id)?.text ?? ""));
      rows.push({ id: c.id, target: c.target, shown, tokens: logged?.tokensEst ?? 0, sourceSeen,
        correct: c.target === null ? shown.length === 0 : shown.includes(c.target), wrong: shown.some((id) => id !== c.target) });
    }
    const answerable = rows.filter((r) => r.target !== null);
    const silent = rows.filter((r) => r.target === null);
    const deliveredTokens = rows.filter((r) => r.shown.length).map((r) => r.tokens).sort((a, b) => a - b);
    const median = deliveredTokens.length ? deliveredTokens[Math.floor(deliveredTokens.length / 2)] : 0;
    const score = { answered: answerable.filter((r) => r.correct).length, answerable: answerable.length,
      silent: silent.filter((r) => r.correct).length, unanswerable: silent.length,
      wrong: rows.filter((r) => r.wrong).length, maxItems: Math.max(...rows.map((r) => r.shown.length)), medianDeliveredTokens: median,
      allSourcesSeen: rows.every((r) => r.sourceSeen) };
    score.pass = score.answered / score.answerable >= data.criteria.minAnswerRate && score.wrong <= data.criteria.maxWrong
      && score.silent === score.unanswerable && score.maxItems <= data.criteria.maxItemsPerPrompt
      && score.medianDeliveredTokens <= data.criteria.maxMedianTokens && score.allSourcesSeen;
    report.agents[agent] = { score, rows };
    console.log(`${agent}: ${score.answered}/${score.answerable} answered; ${score.silent}/${score.unanswerable} silent; ${score.wrong} wrong; ${median} median delivered tokens; ${score.pass ? "PASS" : "FAIL"}`);
  }
} finally {
  // Windows hook children can leave a temporary config directory inaccessible to this
  // process. Keep the score and report the cleanup failure instead of losing the result.
  for (const path of [root, cfg]) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (e) { (report.cleanup ??= []).push({ path, error: e.code ?? String(e) }); }
  }
}
const output = join(REPO, "bench", "ab-results", `lesson-delivery-${set}${diagnostic ? "-diagnostic" : ""}-${Date.now()}.json`);
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(output);
for (const [agent, value] of Object.entries(report.agents)) for (const row of value.rows.filter((r) => r.wrong || !r.correct)) {
  console.log(`${agent}/${row.id}: expected ${row.target ?? "none"}, shown ${row.shown.join(",") || "none"}`);
}
if (report.cleanup?.length) console.log(`Temporary cleanup needs attention: ${report.cleanup.length} path(s)`);
if (Object.values(report.agents).some((x) => !x.score.pass)) process.exitCode = 1;
