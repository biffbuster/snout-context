#!/usr/bin/env node
/**
 * Keeps a benchmark machine clean. Benchmarks leave agent transcripts, per-issue grading logs,
 * containers and multi-GB task images behind; left alone they filled Docker's disk (2026-10-09).
 * Only benchmark leftovers are touched, and nothing while a benchmark is running.
 *
 *   node scripts/bench-clean.mjs            # dry run: list what would go
 *   node scripts/bench-clean.mjs --apply    # delete
 *
 * Removes:
 * - benchmark agent transcripts (~/.claude/projects/*snout-swe-*, *snout-long-*) older than 14 days
 *   that no results file in bench/ab-results references (those back published numbers);
 * - per-issue grading logs older than 2 days (verdicts are already in the results files);
 * - stopped benchmark containers;
 * - SWE-bench task images, only when Docker's disk is over 70% full (they can be pulled again).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RESULTS = join(REPO, "bench/ab-results");
const DAY = 86_400_000;
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const gone = (what, n) => console.log(`${APPLY ? "removed" : "would remove"} ${n} ${what}`);

// pgrep is POSIX only; on Windows (no pgrep) this check is skipped.
if ((sh("pgrep", ["-f", "bench/(swe|swelong)\\.mjs"]).stdout ?? "").trim()) {
  console.log("a benchmark is running; nothing touched");
  process.exit(0);
}

// Transcripts referenced by any kept results file.
const keep = new Set();
for (const f of existsSync(RESULTS) ? readdirSync(RESULTS).filter((f) => f.endsWith(".json")) : []) {
  try {
    const s = JSON.parse(readFileSync(join(RESULTS, f), "utf8"));
    for (const r of [...(s.rows ?? []), ...(s.excluded ?? [])]) if (r?.transcript) keep.add(dirname(r.transcript));
  } catch {}
}
const projects = join(homedir(), ".claude/projects");
let n = 0;
for (const d of existsSync(projects) ? readdirSync(projects) : []) {
  if (!/snout-(swe|long)-/.test(d)) continue;
  const p = join(projects, d);
  if (keep.has(p) || Date.now() - statSync(p).mtimeMs < 14 * DAY) continue;
  if (APPLY) rmSync(p, { recursive: true, force: true });
  n++;
}
gone("benchmark transcript folders", n);

n = 0;
for (const g of existsSync(RESULTS) ? readdirSync(RESULTS).filter((f) => f.endsWith("-grading")) : []) {
  for (const e of readdirSync(join(RESULTS, g), { withFileTypes: true })) {
    const p = join(RESULTS, g, e.name);
    if (!e.isDirectory() || Date.now() - statSync(p).mtimeMs < 2 * DAY) continue;
    if (APPLY) rmSync(p, { recursive: true, force: true });
    n++;
  }
}
gone("grading log folders", n);

if (sh("docker", ["info"]).status === 0) {
  const stale = sh("docker", ["ps", "-aq", "--filter", "label=snout-swe", "--filter", "status=exited", "--filter", "status=created"]).stdout.split("\n").filter(Boolean);
  if (APPLY && stale.length) sh("docker", ["rm", "-f", ...stale]);
  gone("stopped benchmark containers", stale.length);
  const df = sh("docker", ["run", "--rm", "--privileged", "--pid=host", "alpine", "nsenter", "-t", "1", "-m", "--", "df", "/var/lib"]).stdout;
  const used = Number(df.match(/(\d+)%/)?.[1] ?? 0);
  const images = sh("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"]).stdout.split("\n").filter((i) => i.startsWith("swebench/"));
  if (used > 70) {
    if (APPLY && images.length) sh("docker", ["rmi", ...images]);
    gone(`SWE-bench images (Docker disk ${used}% full)`, images.length);
  } else console.log(`kept ${images.length} SWE-bench images (Docker disk ${used}% full)`);
}
