#!/usr/bin/env node
/**
 * The clean-library control: one code-understanding task on a real, installed TypeScript
 * library (sindresorhus/ky, ~100 tracked files, node_modules and a built distribution/ present),
 * Snout off vs. on, reporting TOTAL tokens and
 * dollar cost with pass/fail (how Snout's own A/B counts).
 *
 *   node bench/library.mjs --repo <path to an installed ky checkout> [--n 3] [--model haiku]
 *
 * Graded against the source: default retry limit 2; default retried status codes
 * 408, 413, 429, 500, 502, 503, 504.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateEntries, squeezeEntries } from "../dist/lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1]?.startsWith("--") ? true : arr[i + 1] ?? true]] : a), []));
const REPO = args.repo;
const N = Number(args.n ?? 3);
const MODEL = typeof args.model === "string" ? args.model : "haiku";
const SNOUT_BIN = process.env.SNOUT_BIN || new URL("../dist/snout.mjs", import.meta.url).pathname;
if (!REPO || !existsSync(join(REPO, "source"))) throw new Error("--repo must point at an installed ky checkout");

const PROMPT = "In this repository (the ky HTTP client), what is the default retry limit, and which HTTP status codes does ky retry by default? Write the limit on the first line of ANSWER.txt and the status codes, comma-separated, on the second line.";
const CODES = [408, 413, 429, 500, 502, 503, 504];

function check(dir) {
  const f = join(dir, "ANSWER.txt");
  if (!existsSync(f)) return false;
  const [l1 = "", l2 = ""] = readFileSync(f, "utf8").trim().split("\n");
  return /\b2\b/.test(l1) && CODES.every((c) => l2.includes(String(c)));
}

function workspace(arm) {
  const dir = mkdtempSync(join(tmpdir(), `snout-lib-${arm}-`));
  cpSync(REPO, dir, { recursive: true, filter: (src) => !src.includes(`${REPO}/.git/`) });
  const post = { type: "command", command: `node "${SNOUT_BIN}" post-tool`, timeout: 10, async: true };
  const hooks = { PostToolUse: [{ matcher: "Read|NotebookRead|Bash|Grep|Glob|WebFetch|WebSearch|mcp__.*", hooks: [post] }] };
  if (arm === "enforce") {
    hooks.PreToolUse = gateEntries(SNOUT_BIN);
    hooks.PostToolUse.push(...squeezeEntries(SNOUT_BIN));
  }
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2));
  return dir;
}

const dirs = { off: workspace("off"), enforce: workspace("enforce") };
const rows = [];
for (let i = 0; i < N; i++) {
  for (const arm of ["off", "enforce"]) {
    const dir = dirs[arm];
    rmSync(join(dir, "ANSWER.txt"), { force: true });
    rmSync(join(dir, ".snout"), { recursive: true, force: true });
    process.stderr.write(`[${rows.length + 1}/${N * 2}] ${arm} ... `);
    const r = spawnSync("claude", [
      "-p", PROMPT, "--output-format", "json", "--model", MODEL,
      "--setting-sources", "project", "--strict-mcp-config", "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Write", "Grep", "Glob", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(head:*)", "Bash(find:*)",
      "--max-budget-usd", "0.80",
    ], { cwd: dir, encoding: "utf8", timeout: 15 * 60_000, env: { ...process.env, SNOUT_MODE: arm === "enforce" ? "enforce" : "observe" }, maxBuffer: 64 * 1024 * 1024 });
    let out = {};
    try { out = JSON.parse(r.stdout); } catch { out = {}; }
    const u = out.usage ?? {};
    const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    let withheld = 0;
    try {
      for (const l of readFileSync(join(dir, ".snout/ledger.jsonl"), "utf8").split("\n")) {
        if (!l) continue;
        const row = JSON.parse(l);
        if (row.decision !== "allow" && !row.observedOnly) withheld += row.tokensAvoidedEst || 0;
      }
    } catch { /* no ledger: nothing withheld */ }
    const row = { arm, pass: check(dir), totalTokens: total, costUsd: out.total_cost_usd ?? 0, turns: out.num_turns ?? 0, withheld };
    rows.push(row);
    process.stderr.write(`${row.pass ? "pass" : "FAIL"} · ${Math.round(total / 1000)}k total tokens · $${row.costUsd.toFixed(3)} · ${row.turns} turns${withheld ? ` · ~${Math.round(withheld / 1000)}k withheld` : ""}\n`);
  }
}
for (const d of Object.values(dirs)) rmSync(d, { recursive: true, force: true });

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
const off = rows.filter((r) => r.arm === "off"), on = rows.filter((r) => r.arm === "enforce");
const pct = (a, b) => (b ? `${a <= b ? "-" : "+"}${Math.abs((1 - a / b) * 100).toFixed(1)}%` : "n/a");
console.log(`\nky library task, ${MODEL}, n=${N}`);
console.log(`  total tokens   ${pct(sum(on, "totalTokens"), sum(off, "totalTokens"))}  (median ${Math.round(med(off.map((r) => r.totalTokens)) / 1000)}k → ${Math.round(med(on.map((r) => r.totalTokens)) / 1000)}k)`);
console.log(`  cost           ${pct(sum(on, "costUsd"), sum(off, "costUsd"))}  ($${sum(off, "costUsd").toFixed(3)} → $${sum(on, "costUsd").toFixed(3)})`);
console.log(`  turns (median) ${med(off.map((r) => r.turns))} → ${med(on.map((r) => r.turns))}`);
console.log(`  passing        off ${off.filter((r) => r.pass).length}/${off.length} · on ${on.filter((r) => r.pass).length}/${on.length}`);
mkdirSync(new URL("./ab-results/", import.meta.url).pathname, { recursive: true });
writeFileSync(new URL(`./ab-results/library-${Date.now()}.json`, import.meta.url).pathname, JSON.stringify({ model: MODEL, n: N, rows }, null, 2));
