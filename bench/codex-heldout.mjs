#!/usr/bin/env node
/** Windows Codex SWE-bench pilot: isolated image checkouts, trusted root hooks, no commits. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, "bench/codex-heldout-tasks.json"), "utf8"));
const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, i, all) =>
  value.startsWith("--") ? [...out, [value.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : out, []));
const n = Number(args.n ?? 1);
const timeoutMinutes = Number(args["timeout-min"] ?? 30);
const arms = String(args.arms ?? "off,enforce").split(",");
const ids = String(args.tasks ?? manifest.tasks.map((task) => task.instance_id).join(",")).split(",");
if (!Number.isInteger(n) || n < 1 || n > 10 || !Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60 || arms.some((arm) => !["off", "enforce"].includes(arm))) throw new Error("invalid run options");
const tasks = ids.map((id) => {
  const task = manifest.tasks.find((candidate) => candidate.instance_id === id);
  if (!task) throw new Error(`task not in frozen manifest: ${id}`);
  return task;
});
const workBase = join(ROOT, "bench/heldout-workspaces");
const resultBase = join(ROOT, ".snout/heldout/runs");
const cli = process.env.CODEX_CLI_JS ?? join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js");
const now = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `run-${now}`;
mkdirSync(workBase, { recursive: true });
mkdirSync(resultBase, { recursive: true });
const outDir = join(resultBase, runId);
mkdirSync(outDir);

function call(command, argv, options = {}) {
  const run = spawnSync(command, argv, {
    cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (run.status !== 0 || run.error) throw new Error(`${command} ${argv.slice(0, 5).join(" ")} failed: ${run.error?.message ?? (run.stderr || run.stdout).slice(-1200)}`);
  return run.stdout.trim();
}
function fileTail(path, start) {
  if (!existsSync(path)) return "";
  const data = readFileSync(path);
  return data.subarray(start).toString("utf8");
}
function safeId(id) { return id.replace(/[^a-z0-9-]/gi, "-").toLowerCase(); }
function preflight() {
  if (call("git", ["branch", "--show-current"]) !== "codex/integration") throw new Error("expected codex/integration branch");
  if (!existsSync(cli)) throw new Error(`Codex CLI JavaScript entry not found: ${cli}`);
  const version = call(process.execPath, [cli, "--version"]);
  if (!version.includes(manifest.codexCliVersion)) throw new Error(`Codex CLI changed: ${version}`);
  const digest = createHash("sha256").update(readFileSync(join(ROOT, "dist/snout.mjs"))).digest("hex");
  if (digest !== manifest.snoutBundleSha256) throw new Error("Snout bundle changed since task freeze");
  if (call("git", ["check-ignore", "-v", "bench/heldout-workspaces/hook-probe.txt"]).includes(".git/info/exclude") === false) throw new Error("held-out workspace needs local .git/info/exclude entry");
  const bytes = Number(call("docker", ["info", "--format", "{{.MemTotal}}"]))
  if (bytes < 8 * 1024 ** 3) throw new Error("Docker engine has less than 8 GiB memory");
  for (const task of tasks) call("docker", ["image", "inspect", task.imagePinned]);
  return version;
}
function copyTask(task, dir, name) {
  if (task.repo === "matplotlib/matplotlib") {
    // Windows cannot create Unix symlinks without privilege. Preserve regular-file
    // targets for tests, then represent tracked symlinks as Git-compatible stubs.
    const archive = join(ROOT, ".snout/heldout/matplotlib-testbed.tar");
    if (!existsSync(archive)) {
      call("docker", ["create", "--name", name, "--entrypoint", "bash", task.imagePinned,
        "-lc", "tar -chf /tmp/testbed.tar -C /testbed ."]);
      try {
        call("docker", ["start", "-a", name], { timeout: 10 * 60_000 });
        call("docker", ["cp", `${name}:/tmp/testbed.tar`, archive], { timeout: 10 * 60_000 });
      } finally { call("docker", ["rm", name]); }
    }
    call("tar", ["-xf", archive, "-C", dir], { timeout: 10 * 60_000 });
    call("git", ["-C", dir, "config", "core.symlinks", "false"]);
    const links = call("git", ["-C", dir, "ls-files", "-s"]).split(/\r?\n/)
      .filter((line) => line.startsWith("120000 ")).map((line) => line.split("\t")[1]);
    for (const path of links) {
      const target = spawnSync("git", ["-C", dir, "show", `HEAD:${path}`], { cwd: ROOT });
      if (target.status !== 0) throw new Error(`cannot read symlink stub ${path}`);
      // Dereferenced tar stores the link and its target as one hardlink inode.
      // Unlink first, or writing the Git stub would overwrite the target file too.
      if (path.startsWith("/") || path.includes("..") || path.includes(":")) throw new Error(`unsafe link path ${path}`);
      unlinkSync(join(dir, path));
      writeFileSync(join(dir, path), target.stdout);
    }
  } else {
    call("docker", ["create", "--name", name, task.imagePinned]);
    try { call("docker", ["cp", `${name}:/testbed/.`, dir], { timeout: 10 * 60_000 }); }
    finally { call("docker", ["rm", name]); }
  }
  call("git", ["-C", dir, "config", "core.filemode", "false"]);
  call("git", ["-C", dir, "config", "core.autocrlf", "false"]);
  call("git", ["-C", dir, "config", "core.longpaths", "true"]);
  const parent = call("git", ["-C", dir, "rev-parse", "HEAD^"]);
  if (parent !== task.base_commit) throw new Error(`task image base commit mismatch: ${task.instance_id}`);
  const dirty = call("git", ["-C", dir, "status", "--porcelain", "--ignore-submodules=dirty"]);
  if (dirty) throw new Error(`copied task checkout is dirty before agent run: ${dirty.slice(0, 300)}`);
}
function parseEvents(events) {
  let input = 0, cached = 0, output = 0, turns = 0, inSessionPytestPassed = false;
  const tests = [];
  let final = "", error = "";
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "turn.completed" && event.usage) {
      turns++;
      input += event.usage.input_tokens ?? 0;
      cached += event.usage.cached_input_tokens ?? 0;
      output += event.usage.output_tokens ?? 0;
    }
    if (event.type === "item.completed" && event.item?.type === "command_execution") {
      const command = String(event.item.command ?? "");
      if (/\b(?:pytest|python(?:3)?\s+-m\s+pytest)\b/.test(command)) {
        tests.push({ command, exitCode: event.item.exit_code });
        if (event.item.exit_code === 0) inSessionPytestPassed = true;
      }
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") final = event.item.text ?? final;
    if (event.type === "error" || event.type === "turn.failed") error = String(event.message ?? event.error?.message ?? event.type);
  }
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output,
    effectiveTokensProxy: Math.round(input - cached + 0.1 * cached + output), turns,
    inSessionPytestPassed, tests, final, error };
}
async function runCodexWithBridge(argv, env, queue, container, timeoutMs) {
  return await new Promise((resolveRun) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, env, timeout: timeoutMs, windowsHide: true });
    child.stdin.end();
    const stdout = [], stderr = [], served = new Set();
    let spawnError;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { spawnError = error; });
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      try {
        for (const name of readdirSync(queue).filter((name) => /^request-[0-9a-f-]+\.json$/.test(name))) {
          if (served.has(name)) continue;
          served.add(name);
          const request = JSON.parse(readFileSync(join(queue, name), "utf8"));
          const responseName = name.replace(/^request-/, "response-");
          let result;
          if (!/^(python|python3|pytest)$/.test(request.tool ?? "") || !Array.isArray(request.args) ||
              request.args.length > 100 || request.args.some((arg) => typeof arg !== "string")) {
            result = { status: 2, stderr: "invalid held-out bridge request\n" };
          } else {
            const run = spawnSync("docker", ["exec", "-i", "-w", "/testbed", container,
              "bash", "-lc", 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && exec "$@"',
              "snout-bridge", request.tool, ...request.args], {
              cwd: ROOT, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
            });
            result = { status: run.status ?? 124, stdout: run.stdout ?? "", stderr: run.stderr ?? run.error?.message ?? "" };
          }
          const target = join(queue, responseName);
          writeFileSync(`${target}.tmp`, JSON.stringify(result));
          renameSync(`${target}.tmp`, target);
        }
      } catch (error) { stderr.push(Buffer.from(`bridge supervisor: ${error}\n`)); }
      finally { busy = false; }
    }, 100);
    child.on("close", (code, signal) => {
      clearInterval(timer);
      resolveRun({ status: code, signal, stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"), error: spawnError });
    });
  });
}

async function runOne(task, arm, repeat, rootStatus) {
  const stem = `${safeId(task.instance_id)}-${arm}-${repeat}`;
  const dir = join(workBase, `${runId}-${stem}`);
  const container = `snout-codex-${safeId(runId + stem)}`.slice(0, 100);
  mkdirSync(dir);
  console.log(`Preparing ${task.instance_id} ${arm} ${repeat}/${n}`);
  copyTask(task, dir, `${container}-copy`);
  const hostPath = resolve(dir);
  call("docker", ["run", "-d", "--name", container, "--mount", `type=bind,source=${hostPath},target=/testbed`, "--entrypoint", "sleep", task.imagePinned, "infinity"]);
  const queue = join(outDir, `${stem}.bridge`);
  mkdirSync(queue);
  const hooksPath = join(ROOT, ".snout/hooks.jsonl");
  const ledgerPath = join(ROOT, ".snout/ledger.jsonl");
  const hooksStart = existsSync(hooksPath) ? statSync(hooksPath).size : 0;
  const ledgerStart = existsSync(ledgerPath) ? statSync(ledgerPath).size : 0;
  const prompt = manifest.promptTemplate.replace("{task_dir}", relative(ROOT, dir).replaceAll("/", "\\"))
    .replace("{task_dir}", relative(ROOT, dir).replaceAll("/", "\\"))
    .replace("{problem_statement}", task.problem_statement);
  const env = { ...process.env, SNOUT_MODE: arm === "enforce" ? "enforce" : "observe",
    SNOUT_HELDOUT_CONTAINER: container, SNOUT_HELDOUT_QUEUE: queue, PATH: `${join(ROOT, "bench/codex-heldout-bin")};${process.env.PATH ?? ""}` };
  let result;
  try {
    console.log(`Running Codex ${stem}`);
    result = await runCodexWithBridge([cli, "exec", "-C", ROOT, "-m", manifest.codexModel,
      "-s", "workspace-write", "-c", "windows.sandbox=unelevated", "--json", prompt],
      env, queue, container, timeoutMinutes * 60_000);
  } finally {
    call("docker", ["rm", "-f", container]);
  }
  writeFileSync(join(outDir, `${stem}.jsonl`), result.stdout ?? "");
  writeFileSync(join(outDir, `${stem}.stderr.txt`), result.stderr ?? result.error?.message ?? "");
  const hooks = fileTail(hooksPath, hooksStart);
  const ledger = fileTail(ledgerPath, ledgerStart);
  writeFileSync(join(outDir, `${stem}.hooks.jsonl`), hooks);
  writeFileSync(join(outDir, `${stem}.ledger.jsonl`), ledger);
  const untracked = call("git", ["-C", dir, "ls-files", "--others", "--exclude-standard"]);
  if (untracked) call("git", ["-C", dir, "add", "-N", "--", ...untracked.split(/\r?\n/).filter(Boolean)]);
  const patch = call("git", ["-C", dir, "diff", "--ignore-submodules=dirty", "--binary", "HEAD", "--"]);
  const changedFiles = call("git", ["-C", dir, "diff", "--name-status", "--ignore-submodules=dirty", "HEAD", "--"])
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...paths] = line.split("\t");
      return { status, path: paths.at(-1) };
    });
  const modifiedExistingTests = changedFiles.filter(({ status, path }) =>
    status !== "A" && /(?:^|\/)(?:test|tests)(?:\/|_)|(?:^|\/)test_[^/]+\.py$/.test(path));
  writeFileSync(join(outDir, `${stem}.patch`), patch + (patch ? "\n" : ""));
  const after = call("git", ["status", "--porcelain"]);
  const rootScopeClean = after === rootStatus;
  const hookEvents = hooks.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
  const ledgerEvents = ledger.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
  const parsed = parseEvents(result.stdout ?? "");
  const bridgeTests = readdirSync(queue).filter((name) => /^request-[0-9a-f-]+\.json$/.test(name)).flatMap((name) => {
    const request = JSON.parse(readFileSync(join(queue, name), "utf8"));
    if (request.tool !== "pytest" && !(["python", "python3"].includes(request.tool) &&
      request.args?.[0] === "-m" && request.args?.[1] === "pytest")) return [];
    const responsePath = join(queue, name.replace(/^request-/, "response-"));
    const response = existsSync(responsePath) ? JSON.parse(readFileSync(responsePath, "utf8")) : null;
    return [{ args: request.args, status: response?.status ?? null,
      passed: response?.status === 0 && /\b[1-9]\d* passed\b/.test(response.stdout ?? "") }];
  });
  const row = { instanceId: task.instance_id, arm, repeat, checkout: dir, image: task.imagePinned,
    codexExit: result.status, timedOut: result.error?.code === "ETIMEDOUT", rootScopeClean,
    hookEvents: hookEvents.length, sessionStart: hookEvents.some((event) => event.event === "session-start"),
    preTool: hookEvents.filter((event) => event.event === "pre-tool").length,
    postTool: hookEvents.filter((event) => event.event === "post-tool").length,
    denials: ledgerEvents.filter((event) => event.decision === "deny").length,
    trims: ledgerEvents.filter((event) => event.trimmed).length,
    patchBytes: Buffer.byteLength(patch), changedFiles, modifiedExistingTests,
    scopeOkay: modifiedExistingTests.length === 0, ...parsed, bridgeTests,
    inSessionPytestPassed: bridgeTests.some((test) => test.passed) };
  console.log(`${stem}: exit ${row.codexExit}; hooks ${row.hookEvents}; pytest ${row.inSessionPytestPassed}; patch ${row.patchBytes} B`);
  return row;
}
const cliVersion = preflight();
const rootStatus = call("git", ["status", "--porcelain"]);
const report = { runId, startedAt: new Date().toISOString(), purpose: "local smoke or paired held-out pilot; external grade separate",
  manifest: "bench/codex-heldout-tasks.json", cliVersion, model: manifest.codexModel,
  arms, repeats: n, timeoutMinutes, rows: [] };
const reportPath = join(outDir, "report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
for (const task of tasks) for (let repeat = 1; repeat <= n; repeat++) for (const arm of arms) {
  try { report.rows.push(await runOne(task, arm, repeat, rootStatus)); }
  catch (error) { report.rows.push({ instanceId: task.instance_id, arm, repeat, infrastructureError: String(error) }); console.error(String(error)); }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
report.finishedAt = new Date().toISOString();
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(reportPath);
if (report.rows.some((row) => row.infrastructureError || row.codexExit !== 0 || !row.sessionStart || !row.rootScopeClean || !row.scopeOkay || !row.inSessionPytestPassed)) process.exitCode = 1;
