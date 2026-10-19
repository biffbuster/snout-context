#!/usr/bin/env node
/**
 * Public-task A/B: SWE-bench Verified issues, run by a real headless Claude Code with Snout off
 * and with Snout enforcing, graded by the official SWE-bench harness. Protocol, fixed before any
 * run: docs/benchmark-protocol.md.
 *
 * The agent works on a host copy of the task image's /testbed; `python` and `pytest` on its
 * PATH run inside the same image with that copy mounted. After every session its diff is saved
 * as a prediction; `--grade` hands each arm's predictions to `swebench.harness.run_evaluation`.
 * Snout plays no part in grading.
 *
 * Needs Docker and a Python env with `swebench` (SWE_PY; macOS default ~/opt/anaconda3/envs/swebench/bin/python,
 * Windows default .snout/heldout/venv3 with swebench 3.0.17). On Windows the agent's shell is Git Bash and
 * session workspaces live under ~/.snout-bench/swe-work (see workBase).
 *
 * Usage:
 *   node bench/swe.mjs --select                     # seeded draw → bench/swe-tasks.json
 *   node bench/swe.mjs --n 2 --model haiku          # run every task × arm × n, then grade
 *   node bench/swe.mjs --n 1 --tasks django__django-11099 --arms enforce   # smoke
 *   node bench/swe.mjs --grade bench/ab-results/swe-<ts>.json
 *   node bench/swe.mjs --summarize bench/ab-results/swe-<ts>.json
 *   node bench/swe.mjs --n 1 --arms off,enforce,map --tasks a,b   # repo map on its own (arm "map")
 *   node bench/swe.mjs --select-memory               # memory pilot draw → bench/swe-memory-tasks.json
 *   SWE_TASKS_FILE=bench/swe-memory-tasks.json node bench/swe.mjs --arms plain,enforce,memory   # memory pilot
 *   node bench/swe.mjs --resume bench/ab-results/swe-<ts>.json --n 2 --arms off,map   # rerun infra rows, finish the plan
 *   options: --jobs 2  --budget 2.00 (per session)  --max-spend 40 (whole run)  --keep  --api (bill ANTHROPIC_API_KEY from .env.local)  --min-mem-gb 5.5
 *
 * Docker is checked before the run and after every session: a starved Docker VM (2 GB) wedges
 * the engine, so `python` hangs and sessions measure the hang instead of the agent.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootstrap } from "./long.mjs";
import { reliabilityLines, costLines, ledgerFacts, peakContext, mapFacts } from "./stats.mjs";
import { stamp } from "./stamp.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const N = Number(args.n ?? 1);
const MODEL = typeof args.model === "string" ? args.model : "haiku";
/** --api: bill ANTHROPIC_API_KEY from .env.local instead of the Claude login (real billed cost, no plan usage). */
const API_KEY = args.api ? (readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), ".env.local"), "utf8").split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY=")) ?? "").slice("ANTHROPIC_API_KEY=".length).trim() : null;
if (args.api && !API_KEY) throw new Error("--api: no ANTHROPIC_API_KEY in .env.local");
const ARMS = (typeof args.arms === "string" ? args.arms : "off,enforce").split(",");
const BUDGET = String(args.budget ?? "2.00");
const MAX_SPEND = args["max-spend"] ? Number(args["max-spend"]) : 0; // total for the run; halts, resumable
// SWE_FAKE_AGENT=1: bench/fake-claude.mjs stands in for Claude Code (free dry run of everything around the agent).
const FAKE = process.env.SWE_FAKE_AGENT === "1";
const API_REFUSED = /credit balance|billing|invalid.*api.key|authentication|rate.limit|overloaded|\b(401|403|429|529)\b/i;
const JOBS = Number(args.jobs ?? 2);
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SNOUT_BIN = process.env.SNOUT_BIN || join(REPO, "dist/snout.mjs");
/**
 * SNOUT_COMMIT with SNOUT_BIN and SNOUT_LIB: a frozen copy of a committed build, so work can go on in
 * the repo while a run is under way. Both files must be byte-identical to that commit's dist/.
 */
const SNOUT_LIB = process.env.SNOUT_LIB || join(REPO, "dist/lib.mjs");
const FROZEN_COMMIT = process.env.SNOUT_COMMIT || "";
const { gateEntries, squeezeEntries } = await import(pathToFileURL(SNOUT_LIB).href);
/** Windows: Claude Code runs Bash through Git Bash and Docker runs Linux containers; see SHIM and sweArgs. */
const WIN = process.platform === "win32";
const SWE_PY = process.env.SWE_PY || (WIN ? join(REPO, ".snout/heldout/venv3/Scripts/python.exe") : join(homedir(), "opt/anaconda3/envs/swebench/bin/python"));
/** Claude Code's own executable: on Windows the npm shim is a .cmd that spawn() can't start. */
const CLAUDE = process.env.CLAUDE_BIN || (WIN ? join(process.env.APPDATA ?? "", "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe") : "claude");
/**
 * swebench 3.0.17 on Windows: it imports the POSIX-only `resource` module (unused when grading
 * prebuilt images) and writes the Linux eval script with Path.write_text, which would add CRLF.
 * `-m module args` becomes `-c <prelude + run module> args`.
 */
const WIN_PRELUDE = [
  "import sys, types, runpy, pathlib",
  "sys.modules.setdefault('resource', types.ModuleType('resource'))",
  "_write = pathlib.Path.write_text",
  "def _lf(self, data, *a, **k):",
  "    k.setdefault('newline', chr(10))",
  "    return _write(self, data, *a, **k)",
  "pathlib.Path.write_text = _lf",
  "",
].join("\n");
function sweArgs(argv) {
  if (!WIN) return argv;
  if (argv[0] === "-m") return ["-c", `${WIN_PRELUDE}sys.argv[0] = ${JSON.stringify(argv[1])}\nrunpy.run_module(${JSON.stringify(argv[1])}, run_name="__main__")\n`, ...argv.slice(2)];
  if (argv[0] === "-c") return ["-c", WIN_PRELUDE + argv[1], ...argv.slice(2)];
  return argv;
}
/**
 * With --api, every session runs against an empty Claude Code config folder: none of the operator's
 * own settings, plugins, skills, connectors, memory or history can reach either arm. (Plan login
 * lives in the user's config, so without --api the sessions use it as is.)
 */
const CLEAN_HOME = API_KEY ? join(homedir(), ".snout-bench", "claude-home") : null;
const DATASET = "SWE-bench/SWE-bench_Verified";
const MIN_MEM_GB = Number(args["min-mem-gb"] ?? 5.5);
const SESSION_LIMIT_MS = 30 * 60_000;
// SWE_TASKS_FILE: a one-off task list (e.g. a single issue from a long chain) instead of the pilot draw.
const TASKS_FILE = process.env.SWE_TASKS_FILE || join(REPO, "bench/swe-tasks.json");

// ------------------------------------------------------------------ selection (protocol: seed, eligibility, cap)

// --seed, --count and --per-repo change the draw (the 2026-10-14 confirmation: 20261014, 80, 20).
const SEED = Number(args.seed ?? 20261006);
const COUNT = Number(args.count ?? 15);
const PER_REPO = Number(args["per-repo"] ?? 5);

/**
 * Every issue an earlier run touched, so a new draw is held out: the task manifests in bench/ and
 * every task named in the results under bench/ab-results/ (published and local).
 */
// Offline evals (sessioneval, recalleval, mapeval-heldout) score every issue without running
// an agent on it, so they do not use a task up.
function usedTasks() {
  const used = new Set();
  const scan = (v) => {
    if (Array.isArray(v)) return v.forEach(scan);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "instance_id" || k === "task" || k === "instanceId") && typeof x === "string" && x.includes("__")) used.add(x);
      else scan(x);
    }
  };
  const files = [join(REPO, "bench/swe-tasks.json"), join(REPO, "bench/codex-heldout-tasks.json")];
  const results = join(REPO, "bench/ab-results");
  if (existsSync(results)) for (const f of readdirSync(results)) if (f.endsWith(".json") && !/^(sessioneval|recalleval|mapeval-heldout)-/.test(f)) files.push(join(results, f));
  for (const f of files) { try { scan(JSON.parse(readFileSync(f, "utf8"))); } catch { /* not JSON */ } }
  return used;
}
const ELIGIBLE = new Set(["django/django", "sympy/sympy", "sphinx-doc/sphinx", "pydata/xarray", "pytest-dev/pytest", "pylint-dev/pylint", "psf/requests", "mwaskom/seaborn", "pallets/flask"]);

function rng(seed) {
  let s = seed % 2147483647;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/**
 * The build under test, recorded with every run: the commit, the bundle's hash, Claude Code's
 * version and the config mode. With SNOUT_COMMIT, both bundles must equal that commit's dist/; a
 * published number must name the exact build that ran, so uncommitted src/ or dist/ changes stop
 * the run unless --allow-dirty (smoke runs and dry runs only).
 */
export function frozenBuild() {
  const frozen = {
    snoutCommit: FROZEN_COMMIT || sh("git", ["rev-parse", "HEAD"], { cwd: REPO }).stdout.trim(),
    snoutDirty: FROZEN_COMMIT ? false : sh("git", ["status", "--porcelain", "src", "dist"], { cwd: REPO }).stdout.trim() !== "",
    ...(FROZEN_COMMIT ? { frozenCopy: SNOUT_BIN } : {}),
    snoutDistSha256: createHash("sha256").update(readFileSync(SNOUT_BIN)).digest("hex"),
    claudeCode: FAKE ? "stand-in (SWE_FAKE_AGENT=1)" : sh(CLAUDE, ["--version"]).stdout.trim(),
    claudeConfig: CLEAN_HOME ? "isolated (empty CLAUDE_CONFIG_DIR, API key)" : "operator login",
  };
  if (FROZEN_COMMIT) for (const [file, inRepo] of [[SNOUT_BIN, "dist/snout.mjs"], [SNOUT_LIB, "dist/lib.mjs"]]) {
    const committed = spawnSync("git", ["show", `${FROZEN_COMMIT}:${inRepo}`], { cwd: REPO, maxBuffer: 256 << 20 });
    if (committed.status !== 0 || !readFileSync(file).equals(committed.stdout)) throw new Error(`SNOUT_COMMIT: ${file} is not ${FROZEN_COMMIT}'s ${inRepo}`);
  }
  if (frozen.snoutDirty && !args["allow-dirty"]) throw new Error("src/ or dist/ has uncommitted changes: commit them so the recorded commit is the build under test (or pass --allow-dirty for a smoke run)");
  return frozen;
}

/** Gold patches for a dry run with the stand-in agent; never written into task files the agent could see. */
let GOLD = null;
function goldPatch(id) {
  if (!GOLD) {
    const r = spawnSync(SWE_PY, sweArgs(["-c", `
import json
from swebench.harness.utils import load_swebench_dataset
print(json.dumps({d["instance_id"]: d["patch"] for d in load_swebench_dataset(${JSON.stringify(DATASET)}, "test")}))
`]), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
    GOLD = JSON.parse(r.stdout);
  }
  return GOLD[id] ?? "";
}

function select() {
  const dump = spawnSync(SWE_PY, sweArgs(["-c", `
import json
from swebench.harness.utils import load_swebench_dataset
ds = load_swebench_dataset(${JSON.stringify(DATASET)}, "test")
keep = ("instance_id", "repo", "base_commit", "problem_statement", "difficulty", "image")
print(json.dumps([{k: d[k] for k in keep} for d in ds]))
`]), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error(dump.stderr.slice(-2000));
  const all = JSON.parse(dump.stdout).sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const used = usedTasks();
  const pool = all.filter((t) => ELIGIBLE.has(t.repo) && t.difficulty !== ">4 hours" && !used.has(t.instance_id));
  const rand = rng(SEED);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const perRepo = {};
  const picked = [];
  for (const t of pool) {
    if (picked.length === COUNT) break;
    if ((perRepo[t.repo] ?? 0) >= PER_REPO) continue;
    perRepo[t.repo] = (perRepo[t.repo] ?? 0) + 1;
    picked.push(t);
  }
  writeFileSync(TASKS_FILE, JSON.stringify({ dataset: DATASET, seed: SEED, count: COUNT, perRepo: PER_REPO, excludedUsed: [...used].sort(), eligible: pool.length, tasks: picked }, null, 2) + "\n");
  console.log(`${picked.length} of ${pool.length} eligible (seed ${SEED}) → ${TASKS_FILE}`);
  for (const t of picked) console.log(`  ${t.instance_id.padEnd(34)} ${t.difficulty}`);
}

/** Every Verified issue with its date and its fix's files, for the memory pilot's draw and seeding. */
let ISSUES = null;
export function issues() {
  if (!ISSUES) {
    const r = spawnSync(SWE_PY, sweArgs(["-c", `
import json, re
from swebench.harness.utils import load_swebench_dataset
ds = load_swebench_dataset(${JSON.stringify(DATASET)}, "test")
keep = ("instance_id", "repo", "base_commit", "problem_statement", "difficulty", "image", "created_at")
print(json.dumps([{**{k: d[k] for k in keep}, "gold": sorted(set(re.findall(r"^diff --git a/(\\S+) b/", d["patch"], re.M)))} for d in ds]))
`]), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
    ISSUES = JSON.parse(r.stdout);
  }
  return ISSUES;
}

/**
 * The memory pilot's draw (bench/memseed.mjs seeds the memory arm). Held out like --select. Of COUNT
 * tasks, all but RELATED_OFF have related prior work: an earlier issue of the same repository whose
 * fix touched a file this fix touches (the case memory is for); the rest have none, to check that
 * memory costs nothing when nothing in it applies. Each task needs 10 or more earlier issues.
 */
function selectMemory() {
  const all = issues().sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const used = usedTasks();
  const count = Number(args.count ?? 20), unrelatedCount = Number(args.unrelated ?? 4), perRepo = Number(args["per-repo"] ?? 6);
  const earlier = (t) => all.filter((d) => d.repo === t.repo && d.created_at < t.created_at);
  const related = (t) => earlier(t).some((d) => d.gold.some((f) => t.gold.includes(f)));
  const pool = all.filter((t) => ELIGIBLE.has(t.repo) && t.difficulty !== ">4 hours" && !used.has(t.instance_id) && earlier(t).length >= 10);
  const rand = rng(Number(args.seed ?? 20261016));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const perRepoN = {}, picked = [];
  const want = { related: count - unrelatedCount, unrelated: unrelatedCount };
  for (const t of pool) {
    const kind = related(t) ? "related" : "unrelated";
    if (want[kind] === 0 || (perRepoN[t.repo] ?? 0) >= perRepo) continue;
    want[kind]--;
    perRepoN[t.repo] = (perRepoN[t.repo] ?? 0) + 1;
    const { gold, ...task } = t;
    picked.push({ ...task, priorWork: kind, earlierIssues: earlier(t).length });
  }
  const file = join(REPO, "bench/swe-memory-tasks.json");
  writeFileSync(file, JSON.stringify({ dataset: DATASET, seed: Number(args.seed ?? 20261016), count, unrelated: unrelatedCount, perRepo, excludedUsed: [...used].sort(), eligible: pool.length, tasks: picked }, null, 2) + "\n");
  console.log(`${picked.length} of ${pool.length} eligible → ${file}`);
  for (const t of picked) console.log(`  ${t.instance_id.padEnd(34)} ${t.priorWork.padEnd(9)} ${String(t.earlierIssues).padStart(4)} earlier  ${t.difficulty}`);
}

// ------------------------------------------------------------------ docker health

/** Benchmark containers left behind: stuck in Created or still running after their session ended. */
function leftovers(label = "snout-swe") {
  const r = sh("docker", ["ps", "-aq", "--filter", `label=${label}`], { timeout: 60_000 });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function removeContainers(ids) {
  if (ids.length) sh("docker", ["rm", "-f", ...ids], { timeout: 120_000 });
}

/** A container must start, run and exit within a minute; a wedged engine accepts commands and never runs them. */
function dockerHealthy(image) {
  const r = sh("docker", ["run", "--rm", "--label", "snout-swe=probe", image, "true"], { timeout: 60_000 });
  return r.status === 0;
}

function preflight(images) {
  const info = sh("docker", ["info", "--format", "{{.MemTotal}}"], { timeout: 30_000 });
  if (info.status !== 0) throw new Error(`docker not responding: ${(info.stderr || "timed out").trim()}`);
  const gb = Number(info.stdout.trim()) / 1024 ** 3;
  if (gb < MIN_MEM_GB) throw new Error(`Docker VM has ${gb.toFixed(1)} GB RAM; SWE sessions need ≥ ${MIN_MEM_GB} GB or the engine wedges (Docker Desktop → Settings → Resources; or --min-mem-gb)`);
  // SWE_SHARED_DOCKER=1: other runners share this Docker, so their live containers are not leftovers.
  if (!process.env.SWE_SHARED_DOCKER) {
    const stale = leftovers();
    if (stale.length) { console.error(`removing ${stale.length} leftover benchmark container(s)`); removeContainers(stale); }
    if (leftovers().length) throw new Error("leftover benchmark containers could not be removed: the Docker engine is wedged; restart Docker Desktop");
  }
  if (!dockerHealthy(images[0])) throw new Error("a test container did not run within 60 s: restart Docker Desktop");
}

// ------------------------------------------------------------------ workspace

const GIT_BASH = process.env.CLAUDE_CODE_GIT_BASH_PATH || "C:/Program Files/Git/bin/bash.exe";
const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function ensureImage(image) {
  if (sh("docker", ["image", "inspect", image]).status === 0) return;
  // Registry hiccups (TLS handshake timeouts) are common over a long pull list: retry with a pause.
  let r;
  for (let i = 0; i < 4; i++) {
    r = sh("docker", ["pull", "-q", image], { timeout: 30 * 60_000 });
    if (r.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000 * (i + 1));
  }
  throw new Error(`pull ${image}: ${r.stderr}`);
}

/**
 * `python`, `python3` and `pytest` for the agent: each runs in the session's own container of the
 * task image, in the matching directory, so the agent types ordinary commands. Nothing is
 * bind-mounted: Docker Desktop's macOS file sharing hangs under this load (reads from the mount
 * never return, `python` freezes at 0% CPU), so before every call the files the agent changed,
 * added or deleted since the baseline are copied into the container's own /testbed.
 * Scripts outside the repo (\`python /tmp/repro.py\`, or a scratch folder the agent cd'd into) are
 * copied to the same path in the container too. After the command, repository files it changed
 * inside the container (an agent's \`python - <<EOF\` script that edits source) are copied back, so
 * the patch holds every edit; new untracked files a command creates there stay in the container.
 */
const CONDA = "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && ";
/** Repository files a command changed inside the container: tracked files that differ from the baseline. */
const GIT_CHANGED = `docker exec "$c" sh -c 'cd /testbed && git -c core.quotepath=off diff --name-only --no-renames --diff-filter=ACMT HEAD'`;
/** GNU tar (Git Bash) has no --no-mac-metadata; macOS bsdtar needs it to keep ._ files out. */
const TAR_C = WIN ? "tar -cf -" : "COPYFILE_DISABLE=1 tar --no-mac-metadata -cf -";
/**
 * Under Git Bash, MSYS would rewrite /testbed in arguments to docker.exe into a Windows path, so that
 * is turned off; and Windows-form paths the agent passes (C:/x, C:\x) become the POSIX form that the
 * container links to /testbed.
 */
const WIN_ARGS = WIN ? String.raw`export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"
for a in "$@"; do shift; case "$a" in [A-Za-z]:[\\/]*) a="$(cygpath -u "$a" 2>/dev/null || printf %s "$a")" ;; esac; set -- "$@" "$a"; done
` : "";
const SHIM = (entry, { activate = CONDA, before = "", changed = GIT_CHANGED } = {}) => `#!/bin/sh
${WIN_ARGS}here="$(pwd -P)"
# The task checkout: the nearest folder up from here with a .swe-task file (it names the container),
# else the one .current points to (a chain of tasks in one session), else the folder above .bin.
d="$here"; while [ "$d" != / ] && [ ! -f "$d/.swe-task" ]; do d="$(dirname "$d")"; done
top="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ -f "$d/.swe-task" ]; then root="$d"; elif [ -f "$top/.current" ]; then root="$(cat "$top/.current")"; else root="$top"; fi
c="$(cat "$root/.swe-task")"
# Copy a host file or small folder outside the repo to the same path in the container.
put() { [ -e "$1" ] || return 0; d="$(dirname "$1")"; b="$(basename "$1")"; [ "$(du -sk "$1" | cut -f1)" -le 20000 ] || return 1
  ${TAR_C} -C "$d" "$b" | docker exec -i "$c" sh -c 'mkdir -p "$1" && tar -xf - -C "$1" --warning=no-unknown-keyword' _ "$d"; }
case "$here" in
  "$root"|"$root"/*) wd="/testbed\${here#"$root"}" ;;
  *) case "$root" in
       "$here"/*) wd="$here" ;; # a folder above the checkout (a chain's root): linked in the container too
       *) if put "$PWD"; then wd="$PWD"; else wd=/testbed; fi ;;
     esac ;;
esac
for a in "$@"; do case "$a" in -*) ;; *) [ -f "$a" ] || continue; f="$(cd "$(dirname "$a")" && pwd -P)/$(basename "$a")"
  case "$f" in "$root"/*) ;; *) case "$a" in /*) put "$a" ;; *) put "$PWD/$a" ;; esac ;; esac ;; esac; done
(
  cd "$root" || exit 1
  list=.swe-synced
  { cat "$list" 2>/dev/null; git -c core.quotepath=off diff --name-only --no-renames HEAD; git -c core.quotepath=off ls-files --others --exclude-standard; } | sort -u > "$list.$$" && mv "$list.$$" "$list"
  present="$(mktemp)"; gone="$(mktemp)"
  while IFS= read -r f; do if [ -e "$f" ]; then printf '%s\\n' "$f" >> "$present"; else printf '%s\\n' "$f" >> "$gone"; fi; done < "$list"
  [ -s "$present" ] && ${TAR_C} -T "$present" | docker exec -i "$c" tar -xf - -C /testbed --warning=no-unknown-keyword
  [ -s "$gone" ] && tr '\\n' '\\0' < "$gone" | docker exec -i "$c" sh -c 'cd /testbed && xargs -0 rm -rf --'
  rm -f "$present" "$gone"
)
${before}docker exec -i -w "$wd" "$c" bash -c '${activate}exec ${entry} "$@"' ${entry} "$@"
rc=$?
back="$(mktemp)"
${changed} > "$back" 2>/dev/null
[ -s "$back" ] && tr '\\n' '\\0' < "$back" | docker exec -i "$c" sh -c 'cd /testbed && xargs -0 tar -cf -' | (cd "$root" && tar -xf - 2>/dev/null)
rm -f "$back"
exit $rc
`;

/** The session's container: the image's own /testbed, with the host workspace paths linked to it so absolute paths work. */
/**
 * Where session workspaces go. Not the Windows temp folder: Git Bash shows it as /tmp, so a path the
 * agent writes as C:/... (converted to /c/...) would not match the /tmp/... form the container links.
 */
export function workBase() {
  if (!WIN) return tmpdir();
  const base = join(homedir(), ".snout-bench", "swe-work");
  mkdirSync(base, { recursive: true });
  return base;
}

/** A host path as Git Bash shows it (C:\Users\x is /c/Users/x): the form the agent's shell, and so the container's links, use. */
const posixPath = (p) => (WIN ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p);

function startContainer(image, dir, label = basename(dir)) {
  const name = `snout-swe-${dir.split(/[\\/]/).slice(-2).join("-").replace(/[^\w.-]/g, "_")}`;
  const r = sh("docker", ["run", "-d", "--name", name, "--label", `snout-swe=${label}`, "--entrypoint", "sleep", image, "infinity"], { timeout: 120_000 });
  if (r.status !== 0) throw new Error(`start container: ${r.stderr}`);
  const real = WIN ? posixPath(dir) : sh("realpath", [dir]).stdout.trim();
  const links = [...new Set(WIN ? [real] : [dir, real])].map((p) => `mkdir -p "${p.replace(/\/[^/]+$/, "")}" && ln -s /testbed "${p}"`).join(" && ");
  const l = sh("docker", ["exec", name, "sh", "-c", links], { timeout: 60_000 });
  if (l.status !== 0) throw new Error(`link workspace paths: ${l.stderr}`);
  writeFileSync(join(dir, ".swe-task"), name);
}

/**
 * A host copy of the task image's /testbed at base_commit, committed as "baseline" so the saved diff
 * is the agent's alone, plus the task's own container. `label` groups containers for cleanup.
 */
export function prepareCheckout(task, dir, label) {
  ensureImage(task.image);
  mkdirSync(dir, { recursive: true });
  const cid = sh("docker", ["create", task.image]).stdout.trim();
  // Windows can't create symlinks without Developer Mode, and `docker cp` stops at the first one (Django's
  // docs have several). There the tree comes over as a tar stream; whatever symlinks it could not make,
  // git then writes in its own symlinks=false form (a small file holding the target), as a checkout would.
  const cp = WIN
    ? sh(GIT_BASH, ["-c", `docker cp "${cid}:/testbed" - | tar -xf - -C "${posixPath(dir)}" --strip-components=1 2>/dev/null; test -d "${posixPath(dir)}/.git"`], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } })
    : sh("docker", ["cp", `${cid}:/testbed/.`, dir]);
  sh("docker", ["rm", cid]);
  if (cp.status !== 0) throw new Error(`copy /testbed: ${cp.stderr}`);
  const git = (...a) => sh("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", ...a], { cwd: dir });
  // Windows Git would rewrite line endings and see every file's mode as changed: the patch must be byte-exact.
  if (WIN) for (const [k, v] of [["core.autocrlf", "false"], ["core.filemode", "false"], ["core.symlinks", "false"]]) git("config", k, v);
  if (WIN) {
    const links = git("ls-files", "-s").stdout.split("\n").filter((l) => l.startsWith("120000 ")).map((l) => l.split("\t")[1]);
    for (let i = 0; i < links.length; i += 200) git("checkout", "--", ...links.slice(i, i + 200));
  }
  // The images add one empty "SWE-bench" commit on top of base_commit.
  if (![git("rev-parse", "HEAD").stdout.trim(), git("rev-parse", "HEAD^").stdout.trim()].includes(task.base_commit)) throw new Error(`${task.instance_id}: /testbed is not at base_commit`);
  appendFileSync(join(dir, ".git/info/exclude"), "\n/.bin/\n/.claude/\n/.snout/\n/.mcp.json\n/.swe-task\n/.swe-synced*\n__pycache__/\n*.pyc\n.pytest_cache/\n");
  // Anything the image left uncommitted becomes the baseline, so the saved diff is the agent's alone.
  git("add", "-A");
  git("commit", "-q", "--no-verify", "--allow-empty", "-m", "baseline");
  startContainer(task.image, dir, label);
}

/**
 * `python`, `python3` and `pytest` shims for the agent, in `dir`/.bin. Another harness can name other
 * tools, how to enter the container's environment, and which files to copy back (bench/nl2repo.mjs).
 */
export function writeShims(dir, tools = [["python", "python"], ["python3", "python"], ["pytest", "pytest"]], env = {}) {
  mkdirSync(join(dir, ".bin"), { recursive: true });
  for (const [name, entry] of tools) {
    writeFileSync(join(dir, ".bin", name), SHIM(entry, env));
    chmodSync(join(dir, ".bin", name), 0o755);
  }
}

/** Claude Code hooks and Snout config for an arm, in `dir` (the agent's working directory). */
export function armSettings(dir, arm) {
  // "plain": Claude Code with no Snout at all, not even observe-mode recording: the baseline a
  // skeptic would set up themselves.
  if (arm === "plain") {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks: {} }, null, 2));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    return;
  }
  const post = { type: "command", command: `node "${SNOUT_BIN}" post-tool`, timeout: 10, async: true };
  const hooks = { PostToolUse: [{ matcher: "Read|NotebookRead|Bash|Grep|Glob|WebFetch|WebSearch|mcp__.*", hooks: [post] }] };
  if (arm === "enforce" || arm === "map" || arm === "memory") {
    hooks.SessionStart = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" session-start`, timeout: 10 }] }];
    hooks.PreToolUse = gateEntries(SNOUT_BIN);
    hooks.PostToolUse.push(...squeezeEntries(SNOUT_BIN));
    hooks.PreCompact = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" pre-compact`, timeout: 10 }] }];
  }
  // "map" is enforce plus repo-map suggestions on the prompt, to measure the map on its own.
  if (arm === "map") hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" prompt-submit`, timeout: 10 }] }];
  // "memory" is enforce plus the memory lifecycle: recall on the prompt, a card at every Stop. Its
  // workspace starts with the team's earlier sessions on this repository (bench/memseed.mjs).
  if (arm === "memory") {
    hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" prompt-submit`, timeout: 10 }] }];
    hooks.Stop = [{ hooks: [{ type: "command", command: `node "${SNOUT_BIN}" stop`, timeout: 30 }] }];
  }
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  mkdirSync(join(dir, ".snout"), { recursive: true });
  writeFileSync(join(dir, ".snout/config.json"), JSON.stringify({ mode: arm === "off" ? "observe" : "enforce", memory: arm === "memory", ...(arm === "map" ? { repoMap: true } : {}) }) + "\n");
}

async function makeWorkspace(task, arm) {
  const dir = mkdtempSync(join(workBase(), "snout-swe-"));
  prepareCheckout(task, dir);
  writeShims(dir);
  armSettings(dir, arm);
  let seeded;
  if (arm === "memory") {
    const { seedMemory } = await import("./memseed.mjs");
    const t = issues().find((d) => d.instance_id === task.instance_id);
    seeded = seedMemory({ ...task, created_at: task.created_at ?? t.created_at }, dir, issues(), SNOUT_BIN);
  }
  return { dir, seeded };
}

/**
 * What memory did in a session: the cards it started with, what reached the agent (a brief at the
 * start, recalls on the prompt), which recalled cards came from a Codex session, and the files the
 * briefs named. In any other arm, memory reaching the agent is a harness fault.
 */
function memoryFacts(dir, seeded) {
  const rows = [];
  try { for (const l of readFileSync(join(dir, ".snout/recall.jsonl"), "utf8").split("\n")) if (l.trim()) rows.push(JSON.parse(l)); } catch { /* none */ }
  const recalled = rows.filter((r) => r.kind !== "brief").flatMap((r) => r.cards ?? []);
  const files = new Set();
  for (const id of recalled) {
    try {
      const c = JSON.parse(readFileSync(join(dir, ".snout/memory", `${id.replace(/[^\w.-]/g, "_").slice(0, 80)}.json`), "utf8"));
      for (const f of [...c.changed, ...c.commits.flatMap((k) => k.files)]) files.add(f);
    } catch { /* gone */ }
  }
  return {
    seededClaude: seeded?.claude ?? 0, seededCodex: seeded?.codex ?? 0,
    briefs: rows.filter((r) => r.kind === "brief").length, recalls: rows.filter((r) => r.kind !== "brief").length,
    recalled, recalledCodex: recalled.filter((id) => seeded?.codexSessions?.includes(id)).length,
    memoryTokens: rows.reduce((a, r) => a + (r.tokensEst ?? 0), 0), recalledFiles: [...files],
  };
}

const prompt = (task) => `Resolve the GitHub issue below in the repository in the current directory, by editing its source code.

The project's environment is set up: \`python\` and \`pytest\` run inside it${task.repo === "django/django" ? " (Django's own tests run with `python tests/runtests.py app_label`)" : ""}. Do not modify the existing tests.

<issue>
${task.problem_statement}
</issue>`;

// ------------------------------------------------------------------ run

/**
 * Starts Claude Code in `dir` the same way for every harness (this one and swelong.mjs): CLAUDE_BIN,
 * or the stand-in with SWE_FAKE_AGENT=1 (applying `goldPatch`); the shims first on the PATH; the
 * isolated config and the API key with --api. Resolves when the process ends or `limitMs` passes.
 */
export function launchClaude(dir, argv, { env: extra = {}, goldPatch, limitMs = SESSION_LIMIT_MS } = {}) {
  return new Promise((resolve) => {
    // Windows spells it Path: keep one key, or the child may see the PATH without the shims.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"));
    const path = Object.entries(process.env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
    if (CLEAN_HOME) mkdirSync(CLEAN_HOME, { recursive: true });
    const [bin, args] = FAKE ? [process.execPath, [join(REPO, "bench/fake-claude.mjs"), ...argv]] : [CLAUDE, argv];
    const child = spawn(bin, args, { cwd: dir, env: { ...env, ...(FAKE && goldPatch ? { SWE_FAKE_PATCH: goldPatch } : {}), SNOUT_MODE: "", DISABLE_AUTOUPDATER: "1", ...extra, [WIN ? "Path" : "PATH"]: `${join(dir, ".bin")}${delimiter}${path}`, ...(API_KEY ? { ANTHROPIC_API_KEY: API_KEY } : {}), ...(CLEAN_HOME ? { CLAUDE_CONFIG_DIR: CLEAN_HOME } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, limitMs);
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, timedOut }); });
  });
}

function runClaude(dir, text, goldPatch) {
  const argv = [
    "-p", text,
    "--output-format", "json",
    "--model", MODEL,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--mcp-config", join(dir, ".mcp.json"),
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Grep", "Glob", "Bash(python:*)", "Bash(python3:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git show:*)",
    "--max-budget-usd", BUDGET,
  ];
  return launchClaude(dir, argv, { goldPatch });
}

async function runOne(task, arm, rep) {
  const started = Date.now();
  let dir, seeded;
  try { ({ dir, seeded } = await makeWorkspace(task, arm)); } catch (e) { return { task: task.instance_id, arm, rep, infra: String(e.message).slice(0, 300) }; }
  const gold = `${dir}.gold.patch`;
  if (FAKE) writeFileSync(gold, goldPatch(task.instance_id));
  const r = await runClaude(dir, prompt(task), gold);
  if (FAKE) { process.stderr.write(r.stderr); rmSync(gold, { force: true }); }
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { out = { is_error: true, result: (r.stderr || r.stdout || "").slice(0, 300) }; }
  const u = out.usage ?? {};
  const facts = ledgerFacts(join(dir, ".snout/ledger.jsonl"));
  const peak = peakContext(out.session_id, CLEAN_HOME ? join(CLEAN_HOME, "projects") : undefined);
  const mf = mapFacts(join(dir, ".snout"));
  sh("git", ["add", "-A"], { cwd: dir });
  const patch = sh("git", ["diff", "--cached", "HEAD"], { cwd: dir }).stdout;
  const row = {
    task: task.instance_id, arm, rep,
    error: out.is_error ? String(out.result ?? out.subtype ?? "error").slice(0, 200) : undefined,
    uncached: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    turns: out.num_turns ?? 0,
    costUsd: (out.total_cost_usd ?? 0) + facts.jevUsd,
    withheld: facts.withheld, byRule: facts.byRule,
    followUps: facts.followUps, followUpTokens: facts.followUpTokens, jevUsd: facts.jevUsd,
    peak: peak?.peak,
    ...(arm === "map" ? { map: mf } : {}),
    memory: memoryFacts(dir, seeded),
    readPaths: readPaths(join(dir, ".snout/ledger.jsonl")),
    patch,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  const left = leftovers(`snout-swe=${basename(dir)}`);
  removeContainers(left);
  if (r.timedOut) row.infra = `session hit the ${SESSION_LIMIT_MS / 60_000}-minute limit`;
  // Memory must reach the memory arm and nothing else.
  else if (arm !== "memory" && (row.memory.recalls || row.memory.briefs)) { row.infra = "memory reached a non-memory arm"; row.memoryLeak = true; }
  // Did it even happen: a Snout arm whose session ran but left no ledger rows had no Snout in it.
  else if (arm !== "plain" && !row.error && facts.rows === 0) { row.infra = "Snout recorded nothing: its hooks did not run"; row.snoutMissing = true; }
  else if (leftovers(`snout-swe=${basename(dir)}`).length) row.infra = "session container could not be removed (Docker hang)";
  if (!dockerHealthy(task.image)) { row.infra = `Docker unhealthy after the session${row.infra ? `; ${row.infra}` : ""}`; row.dockerDown = true; }
  if (!args.keep) rmSync(dir, { recursive: true, force: true });
  else row.dir = dir;
  return row;
}

// ------------------------------------------------------------------ grade (official harness)

function grade(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const work = join(REPO, "bench/ab-results", `${saved.runId}-grading`);
  mkdirSync(work, { recursive: true });
  const groups = {};
  for (const r of saved.rows) if (!r.infra) (groups[`${r.arm}-${r.rep}`] ??= []).push(r);
  for (const [key, rows] of Object.entries(groups)) {
    const model = `snout-${key}`;
    const preds = join(work, `${model}.jsonl`);
    writeFileSync(preds, rows.map((r) => JSON.stringify({ instance_id: r.task, model_name_or_path: model, model_patch: r.patch })).join("\n") + "\n");
    const ids = rows.filter((r) => r.patch.trim()).map((r) => r.task);
    if (ids.length) {
      console.error(`grading ${model}: ${ids.length} patch(es)`);
      // The grader writes test logs in the locale encoding unless told otherwise; on Windows that is
      // cp1252, and a test that prints a non-Latin character crashes the instance (2026-10-15 dry run).
      const g = sh(SWE_PY, sweArgs(["-m", "swebench.harness.run_evaluation", "--dataset_name", DATASET, "--predictions_path", preds, "--instance_ids", ...ids, "--max_workers", String(JOBS), "--run_id", saved.runId, "--report_dir", work]), { cwd: work, env: { ...process.env, PYTHONUTF8: "1" }, stdio: ["ignore", "inherit", "inherit"], timeout: 4 * 3600_000 });
      if (g.status !== 0) throw new Error(`grader exited ${g.status} for ${model}`);
    }
    const reportFile = join(work, `${model}.${saved.runId}.json`);
    const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : { resolved_ids: [] };
    const resolved = new Set(report.resolved_ids ?? []);
    for (const r of rows) r.resolved = resolved.has(r.task);
  }
  saved.graded = { at: new Date().toISOString(), dataset: DATASET, swebench: sh(SWE_PY, sweArgs(["-c", "import swebench;print(swebench.__version__)"])).stdout.trim() };
  writeFileSync(file, JSON.stringify(saved, null, 2));
}

// ------------------------------------------------------------------ summary

function summarize(saved) {
  const rows = saved.rows.filter((r) => !r.infra);
  const sum = (rs, k) => rs.reduce((x, r) => x + (r[k] ?? 0), 0);
  const pct = (a, b) => (b > 0 ? `${a <= b ? "−" : "+"}${Math.abs((1 - a / b) * 100).toFixed(1)}%` : "n/a");
  const tasks = [...new Set(rows.map((r) => r.task))];
  console.log(`\nSWE-bench Verified A/B, claude ${saved.model}, n=${saved.n}, ${tasks.length} tasks\n`);
  console.log("  task                                arm       resolved   input tok   output   turns     cost   kept out");
  for (const t of tasks) for (const a of ["plain", "off", "enforce", "map", "memory"]) {
    const rs = rows.filter((r) => r.task === t && r.arm === a);
    if (!rs.length) continue;
    const avg = (k) => sum(rs, k) / rs.length;
    const res = rs.some((r) => r.resolved !== undefined) ? `${rs.filter((r) => r.resolved).length}/${rs.length}` : "?";
    console.log(`  ${t.padEnd(35)} ${a.padEnd(9)} ${res.padStart(8)} ${String(Math.round(avg("inputTokens"))).padStart(11)} ${String(Math.round(avg("outputTokens"))).padStart(8)} ${avg("turns").toFixed(1).padStart(7)}   $${avg("costUsd").toFixed(3)} ${String(Math.round(avg("withheld"))).padStart(9)}`);
  }
  for (const [base, arm] of [["plain", "enforce"], ["off", "enforce"], ["off", "map"], ["enforce", "map"], ["plain", "memory"], ["enforce", "memory"]]) compareArms(rows, tasks, base, arm, sum, pct);
  memorySummary(rows);
  const infra = saved.rows.filter((r) => r.infra);
  if (infra.length) console.log(`  infrastructure failures (excluded): ${infra.map((r) => `${r.task}/${r.arm}/${r.rep}`).join(", ")}`);
}

function compareArms(rows, tasks, base, arm, sum, pct) {
  const paired = tasks.filter((t) => [base, arm].every((a) => rows.some((r) => r.task === t && r.arm === a)));
  const off = rows.filter((r) => r.arm === base && paired.includes(r.task));
  const on = rows.filter((r) => r.arm === arm && paired.includes(r.task));
  if (!off.length || !on.length) return;
  console.log(`\n  ${arm} vs ${base} (${paired.length} tasks run in both)\n`);
  console.log(`  cost            ${pct(sum(on, "costUsd"), sum(off, "costUsd"))}   ($${sum(off, "costUsd").toFixed(2)} → $${sum(on, "costUsd").toFixed(2)})`);
  const ci = bootstrap(off, on, "costUsd");
  if (ci) console.log(`  cost 95% CI     ${ci}   (bootstrap over tasks, then runs within each task)`);
  console.log(`  input tokens    ${pct(sum(on, "inputTokens"), sum(off, "inputTokens"))}`);
  const ciIn = bootstrap(off, on, "inputTokens");
  if (ciIn) console.log(`  input 95% CI    ${ciIn}`);
  console.log(`  output tokens   ${pct(sum(on, "outputTokens"), sum(off, "outputTokens"))}`);
  console.log(`  turns           ${pct(sum(on, "turns"), sum(off, "turns"))}`);
  for (const l of costLines(off, on, sum)) console.log(l);
  if (rows.some((r) => r.resolved !== undefined)) {
    for (const l of reliabilityLines(off, on, (r) => r.resolved, [base, arm])) console.log(l);
    console.log(`  resolved        ${base} ${off.filter((r) => r.resolved).length}/${off.length} · ${arm} ${on.filter((r) => r.resolved).length}/${on.length}   (official SWE-bench harness)`);
    const lost = paired.filter((t) => off.filter((r) => r.task === t).every((r) => r.resolved) && !on.some((r) => r.task === t && r.resolved));
    const gained = paired.filter((t) => on.filter((r) => r.task === t).every((r) => r.resolved) && !off.some((r) => r.task === t && r.resolved));
    if (lost.length) console.log(`  resolved in every ${base} run, no ${arm} run: ${lost.join(", ")}`);
    if (gained.length) console.log(`  resolved in every ${arm} run, no ${base} run: ${gained.join(", ")}`);
  }
  const m = on.filter((r) => r.map);
  if (m.length) {
    const t = (k) => m.reduce((x, r) => x + r.map[k], 0);
    console.log(`  repo map        ${t("suggestions")} suggestion(s), ~${Math.round(t("suggestedTokens") / 1000)}k tokens; agent opened ${t("opened")} of ${t("suggested")} suggested files`);
  }
}

/** Paths the agent read, from the ledger: to count reads of files a brief named that the fix didn't need. */
function readPaths(ledgerFile) {
  const out = new Set();
  try { for (const l of readFileSync(ledgerFile, "utf8").split("\n")) { if (!l.trim()) continue; const r = JSON.parse(l); if (r.path && r.tool !== "Bash") out.add(r.path); } } catch { /* none */ }
  return [...out];
}

/**
 * The memory arm on its own: how often memory reached the agent, how often from a Codex session,
 * whether the files it named were the ones the fix needed, and reads it sent the agent on that the
 * fix didn't need (wrong-memory follow-ups). Gold files come from the dataset, after the run.
 */
function memorySummary(rows) {
  const mem = rows.filter((r) => r.arm === "memory" && r.memory);
  if (!mem.length) return;
  const gold = new Map(issues().map((d) => [d.instance_id, d.gold]));
  const n = mem.length;
  const reached = mem.filter((r) => r.memory.recalls > 0);
  const useful = reached.filter((r) => r.memory.recalledFiles.some((f) => gold.get(r.task)?.includes(f)));
  const wrongReads = mem.reduce((a, r) => a + r.memory.recalledFiles.filter((f) => r.readPaths?.includes(f) && !gold.get(r.task)?.includes(f)).length, 0);
  const t = (k) => mem.reduce((a, r) => a + (r.memory[k] ?? 0), 0);
  console.log(`\n  memory arm (${n} sessions): started with ${Math.round(t("seededClaude") / n)} Claude Code + ${Math.round(t("seededCodex") / n)} Codex cards on average`);
  console.log(`    brief at start ${mem.filter((r) => r.memory.briefs).length}/${n} · recall on the prompt ${reached.length}/${n} · from a Codex session ${mem.filter((r) => r.memory.recalledCodex).length}/${n} · ~${Math.round(t("memoryTokens") / n)} memory tokens per session`);
  console.log(`    recalls naming a file the fix needed ${useful.length}/${reached.length} · reads of recalled files the fix didn't need: ${wrongReads}`);
  const leaks = rows.filter((r) => r.arm !== "memory" && (r.memory?.recalls || r.memory?.briefs));
  if (leaks.length) console.log(`    MEMORY LEAK into ${leaks.length} non-memory session(s)`);
}

// ------------------------------------------------------------------ main

async function main() {
  if (args.select) return select();
  if (args["select-memory"]) return selectMemory();
  if (typeof args.grade === "string") { grade(args.grade); return summarize(JSON.parse(readFileSync(args.grade, "utf8"))); }
  if (typeof args.summarize === "string") return summarize(JSON.parse(readFileSync(args.summarize, "utf8")));
  if (!existsSync(TASKS_FILE)) throw new Error("no bench/swe-tasks.json: run --select first");
  const all = JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks;
  const only = typeof args.tasks === "string" ? new Set(args.tasks.split(",")) : null;
  const tasks = only ? all.filter((t) => only.has(t.instance_id)) : all;
  // --resume: infra rows move to `excluded` (kept for the record) and are run again with whatever the plan still lacks.
  const resumed = typeof args.resume === "string" ? JSON.parse(readFileSync(args.resume, "utf8")) : null;
  if (resumed && (resumed.model !== MODEL || resumed.n !== N)) throw new Error(`--resume: file is model ${resumed.model} n ${resumed.n}; pass the same --model and --n`);
  const excluded = [...(resumed?.excluded ?? []), ...(resumed?.rows ?? []).filter((r) => r.infra)];
  const rows = (resumed?.rows ?? []).filter((r) => !r.infra);
  const have = new Set(rows.map((r) => `${r.task}|${r.arm}|${r.rep}`));
  const plan = [];
  // Arm order rotates by task and rep: the session that runs second can read the first one's cached
  // system prompt, so a fixed order would hand that discount to the same arm every time.
  for (let rep = 0; rep < N; rep++) tasks.forEach((t, i) => {
    const k = (i + rep) % ARMS.length;
    for (const a of [...ARMS.slice(k), ...ARMS.slice(0, k)]) if (!have.has(`${t.instance_id}|${a}|${rep}`)) plan.push([t, a, rep]);
  });
  const runId = resumed?.runId ?? `swe-${Date.now()}`;
  const outFile = resumed ? args.resume : join(REPO, "bench/ab-results", `${runId}.json`);
  mkdirSync(join(REPO, "bench/ab-results"), { recursive: true });
  const frozen = frozenBuild();
  if (resumed && resumed.frozen.snoutCommit !== frozen.snoutCommit) throw new Error("--resume: a different Snout commit than the run started with");
  if (resumed && resumed.frozen.snoutDistSha256 !== frozen.snoutDistSha256) throw new Error("--resume: dist/snout.mjs changed since this run started; the arms would not be the same Snout");
  const save = () => writeFileSync(outFile, JSON.stringify({ runId, model: MODEL, n: N, measuredAt: resumed?.measuredAt ?? new Date().toISOString(), ...stamp(), ...(resumed ? { resumedAt: [...(resumed.resumedAt ?? []), new Date().toISOString()] } : {}), frozen, rows, ...(excluded.length ? { excluded } : {}) }, null, 2));
  console.error(`${plan.length} session(s): ${tasks.length} task(s) × ${ARMS.length} arm(s) × ${N}, model ${MODEL}, cap $${BUDGET}, ${JOBS} at a time → ${outFile}`);
  let next = 0, done = 0, halted = null;
  const worker = async () => {
    while (next < plan.length && !halted) {
      const [t, a, rep] = plan[next++];
      let row = await runOne(t, a, rep);
      if (row.infra && !row.dockerDown) row = { ...(await runOne(t, a, rep)), retried: true }; // protocol: one rerun
      if (row.snoutMissing) halted ??= `Snout recorded nothing in ${t.instance_id} · ${a} · rep ${rep}: the hooks are not running, so the Snout arm would be plain Claude Code. Fix the install, then --resume ${outFile}`;
      if (row.dockerDown) halted = `Docker became unhealthy after ${t.instance_id} · ${a} · rep ${rep}; restart Docker Desktop, then --resume ${outFile}`;
      rows.push(row);
      // Money guards: a total cap, and a stop when the API refuses work (no credit, bad key, limits).
      const spent = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      if (MAX_SPEND && spent >= MAX_SPEND) halted ??= `spent $${spent.toFixed(2)}, at the --max-spend cap of $${MAX_SPEND}; raise it and --resume ${outFile}`;
      const last = rows.slice(-3);
      if (last.length === 3 && last.every((r) => API_REFUSED.test(r.error ?? ""))) halted ??= `the API refused 3 sessions in a row (${last[2].error}); fix it, then --resume ${outFile}`;
      save(); // after every session, so an interrupted run keeps what it measured
      done++;
      process.stderr.write(`[${done}/${plan.length}] ${t.instance_id} · ${a} · rep ${rep}: ${row.infra ? `INFRA ${row.infra}` : `${Math.round(row.inputTokens / 1000)}k in · ${row.turns} turns · $${row.costUsd.toFixed(3)}${row.withheld ? ` · ~${Math.round(row.withheld / 1000)}k kept out` : ""}${row.patch.trim() ? "" : " · NO PATCH"}${row.error ? ` · ${row.error}` : ""}`}\n`);
    }
  };
  // Pull every image first, so pulls don't count against session time.
  for (const t of tasks) ensureImage(t.image);
  preflight(tasks.map((t) => t.image));
  await Promise.all(Array.from({ length: JOBS }, worker));
  console.log(`\nSessions: ${outFile}`);
  if (halted) { console.error(halted); process.exit(2); }
  if (!args["no-grade"]) grade(outFile);
  summarize(JSON.parse(readFileSync(outFile, "utf8")));
}

export { selectMemory, sh, sweArgs, ensureImage, preflight, leftovers, removeContainers, dockerHealthy, grade, startContainer, goldPatch, SWE_PY, DATASET, SNOUT_BIN, REPO, FAKE, CLEAN_HOME, API_REFUSED };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(1); });
