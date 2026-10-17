/**
 * Prior work for the memory arm of bench/swe.mjs: what a team had done on this repository before
 * the issue was filed, written into the workspace's memory the way Snout writes it in real use.
 *
 * The sessions are public SWE-bench Verified trajectories on earlier issues of the same repository
 * (created before this one; never this issue). Each is converted into the transcript format of the
 * agent that would have left it and handed to Snout's own Stop hook, so the cards come from the
 * shipped capture code, not from this script:
 *   claude  Claude Sonnet 4.5's sessions (mini-SWE-agent), as a Claude Code transcript → `snout stop`
 *   codex   GPT-5.2-Codex's sessions (mini-SWE-agent), as a Codex rollout → `snout hook codex Stop`
 * Which agent worked an earlier issue is fixed by a hash of its id, so the team is half Claude Code,
 * half Codex, and a recalled Codex card in a Claude Code session is the cross-agent handoff case.
 *
 * Transcripts are written outside the workspace, so the agent can reach prior work only through
 * Snout's memory. Downloads (~240 MB per agent, free) are cached in TRAJS or the temp folder.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKET = "https://swe-bench-submissions.s3.amazonaws.com";
export const SOURCES = {
  claude: "bash-only/20260217_mini-v2.0.0_claude-4-5-sonnet-high",
  codex: "bash-only/20260219_mini-v2.0.0_gpt-5-2-codex",
};
/** The most recent earlier sessions kept per task: a team's memory is not its whole history. */
export const MAX_SEEDS = 150;
const cacheDir = (sub) => join(process.env.TRAJS || join(tmpdir(), "snout-session-trajs"), sub.replace(/\//g, "__"));

/** The agent that worked an earlier issue: fixed per issue, half and half. */
export const agentOf = (id) => (createHash("sha256").update(id).digest()[0] & 1 ? "codex" : "claude");

/** Downloads the trajectories not cached yet (curl, 16 at a time). */
export function fetchTrajectories(ids, sub) {
  const dir = cacheDir(sub);
  mkdirSync(dir, { recursive: true });
  const want = ids.filter((id) => !existsSync(join(dir, `${id}.json`)));
  for (let i = 0; i < want.length; i += 16) {
    const batch = want.slice(i, i + 16);
    spawnSync("curl", ["-sS", "--parallel", "--max-time", "120", ...batch.flatMap((id) => ["-o", join(dir, `${id}.json`), `${BUCKET}/${sub}/trajs/${id}/${id}.traj.json`])], { stdio: "ignore", timeout: 600_000 });
  }
}

/** One mini-SWE-agent trajectory: the request, each command with its output, the last words, the final patch's files. */
export function readTrajectory(id, sub) {
  let t;
  try { t = JSON.parse(readFileSync(join(cacheDir(sub), `${id}.json`), "utf8")); } catch { return null; }
  const msgs = t.messages ?? [];
  const text = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c) => c.text ?? "").join(" ") : "");
  const steps = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "assistant") continue;
    const said = text(msgs[i]);
    const command = /```(?:bash|sh)?\n([\s\S]*?)```/.exec(said)?.[1]?.trim();
    const next = msgs[i + 1];
    const output = next && (next.role === "tool" || next.role === "user") ? text(next).replace(/^<returncode>\d+<\/returncode>\s*/, "") : "";
    steps.push({ said: said.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim(), command, output: output.slice(0, 4000) });
  }
  const patch = text(msgs.findLast((m) => m.role === "exit")) || t.info?.submission || "";
  const files = [...new Set([...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]))].filter((f) => !/^(reproduce|test_|debug)[^/]*\.py$/.test(f));
  if (!steps.length && !files.length) return null;
  return { steps, files };
}

/** A Claude Code transcript of the session, with the workspace's paths. */
function claudeTranscript(request, traj, dir) {
  const rows = [{ type: "user", message: { content: request } }];
  traj.steps.forEach((s, i) => {
    if (s.said) rows.push({ type: "assistant", message: { content: [{ type: "text", text: s.said }] } });
    if (s.command) {
      rows.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `seed-${i}`, name: "Bash", input: { command: s.command } }] } });
      rows.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `seed-${i}`, content: s.output }] } });
    }
  });
  traj.files.forEach((f, i) => rows.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `seed-edit-${i}`, name: "Edit", input: { file_path: join(dir, f) } }] } }));
  const last = traj.steps.map((s) => s.said).findLast((s) => s.length >= 20);
  if (last) rows.push({ type: "assistant", message: { content: [{ type: "text", text: last }] } });
  return rows;
}

/** A Codex rollout of the session: shell calls with their output, the patch as apply_patch, the last message. */
function codexRollout(request, traj, dir) {
  const rows = [{ type: "session_meta", payload: { cwd: dir } }, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: request }] } }];
  traj.steps.forEach((s, i) => {
    if (s.said) rows.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: s.said }] } });
    if (s.command) {
      rows.push({ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: `seed-${i}`, arguments: JSON.stringify({ command: s.command }) } });
      rows.push({ type: "response_item", payload: { type: "function_call_output", call_id: `seed-${i}`, output: s.output } });
    }
  });
  if (traj.files.length) {
    const patch = `*** Begin Patch\n${traj.files.map((f) => `*** Update File: ${f}`).join("\n")}\n*** End Patch`;
    rows.push({ type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "seed-patch", arguments: JSON.stringify({ input: patch }) } });
  }
  const last = traj.steps.map((s) => s.said).findLast((s) => s.length >= 20);
  if (last) rows.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: last }] } });
  return rows;
}

/**
 * Writes the memory a task's workspace starts with: one card per earlier issue of its repository
 * (the newest MAX_SEEDS), each through Snout's own Stop hook. `issues` is the dataset (instance_id,
 * repo, created_at, problem_statement). Returns what was seeded, by agent.
 */
export function seedMemory(task, dir, issues, snoutBin) {
  const earlier = issues.filter((d) => d.repo === task.repo && d.instance_id !== task.instance_id && d.created_at < task.created_at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-MAX_SEEDS);
  for (const [agent, sub] of Object.entries(SOURCES)) fetchTrajectories(earlier.filter((d) => agentOf(d.instance_id) === agent).map((d) => d.instance_id), sub);
  const scratch = mkdtempSync(join(tmpdir(), "snout-seed-"));
  const seeded = { claude: [], codex: [] };
  try {
    for (const d of earlier) {
      const agent = agentOf(d.instance_id);
      const traj = readTrajectory(d.instance_id, SOURCES[agent]);
      if (!traj) continue;
      const transcript = join(scratch, `${d.instance_id}.jsonl`);
      const rows = agent === "claude" ? claudeTranscript(d.problem_statement, traj, dir) : codexRollout(d.problem_statement, traj, dir);
      writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const session = `seed-${d.instance_id}`;
      const input = JSON.stringify({ cwd: dir, session_id: session, transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "" });
      const argv = agent === "claude" ? [snoutBin, "stop"] : [snoutBin, "hook", "codex", "Stop"];
      const r = spawnSync(process.execPath, argv, { input, encoding: "utf8", env: { ...process.env, SNOUT_MODE: "" }, timeout: 30_000 });
      if (r.status === 0 && existsSync(join(dir, ".snout", "memory", `${session}.json`))) seeded[agent].push(session);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { claude: seeded.claude.length, codex: seeded.codex.length, codexSessions: seeded.codex };
}
