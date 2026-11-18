// A session cut off mid-work (Esc, a crash, a closed terminal, a hook that ends it) never reaches its
// last Stop, so Snout has no card for it, or an older one; the daily import is off here. The next
// session's first prompt records it (catchUpSession), so the left-off note still says where it stopped.
// Found by the pickup pilot (2026-11-18): two of six second sessions got no note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { catchUpSession, claudeSlug } from "../dist/lib.mjs";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
const RESUME = "An earlier session started fixing the rounding bug here and was stopped before it finished. Continue where it left off and finish the fix.";

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "snout-catchup-")));
  const cfg = mkdtempSync(join(tmpdir(), "snout-catchup-cfg-"));
  const home = mkdtempSync(join(tmpdir(), "snout-catchup-claude-"));
  const codex = mkdtempSync(join(tmpdir(), "snout-catchup-codex-"));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "ana@example.com");
  mkdirSync(join(root, ".snout"));
  mkdirSync(join(root, "app"));
  for (const f of ["price.py", "tax.py"]) writeFileSync(join(root, "app", f), "x = 1\n");
  git("add", "-A");
  git("-c", "user.name=T", "commit", "-qm", "init");
  const env = { ...process.env, SNOUT_CONFIG_DIR: cfg, CLAUDE_CONFIG_DIR: home, CODEX_HOME: codex, CLAUDE_PROJECT_DIR: root, SNOUT_MODE: "enforce", SNOUT_IMPORT: "off" };
  delete env.CI;
  delete env.SNOUT_TOKEN;
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", input: JSON.stringify({ cwd: root, ...input }), env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : {};
  };
  /** A Claude Code session that edits files; its transcript where Claude Code keeps it. Stop runs only when asked. */
  const claude = (session, edits, { stop = false } = {}) => {
    const dir = join(home, "projects", claudeSlug(root));
    mkdirSync(dir, { recursive: true });
    const t = join(dir, `${session}.jsonl`);
    run(["prompt-submit"], { session_id: session, prompt: "Fix the rounding bug in app/price.py." });
    const rows = [{ type: "user", cwd: root, timestamp: new Date().toISOString(), message: { content: "Fix the rounding bug in app/price.py." } }];
    edits.forEach((rel, i) => {
      writeFileSync(join(root, rel), `x = ${i + 2}\n`);
      rows.push({ type: "assistant", cwd: root, message: { content: [{ type: "tool_use", id: `e${i}`, name: "Edit", input: { file_path: join(root, rel) } }] } });
      rows.push({ type: "user", cwd: root, message: { content: [{ type: "tool_result", tool_use_id: `e${i}`, content: "ok" }] } });
    });
    writeFileSync(t, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    if (stop) run(["stop"], { session_id: session, transcript_path: t });
    return t;
  };
  const ask = (prompt = RESUME) => run(["prompt-submit"], { session_id: `next-${Math.random()}`, prompt }).hookSpecificOutput?.additionalContext ?? "";
  return { root, cfg, home, codex, env, run, claude, ask };
}

test("a Claude Code session cut off before its Stop: the next session's first prompt still says where it stopped", () => {
  const p = project();
  p.claude("cut-1", ["app/price.py"]);
  const note = p.ask();
  assert.match(note, /where the last session in this repo left off \(claude/);
  assert.match(note, /It was asked: "Fix the rounding bug in app\/price\.py\."/);
  assert.match(note, /Its changes not committed yet: app\/price\.py/);
});

test("a session whose card is older than its transcript (it went on after a Stop, then was cut off) is recorded again", () => {
  const p = project();
  const t = p.claude("cut-2", ["app/price.py"], { stop: true });
  // It went on and changed another file, then was cut off: the transcript is newer than the card.
  const rows = readFileSync(t, "utf8");
  writeFileSync(join(p.root, "app", "tax.py"), "x = 9\n");
  writeFileSync(t, rows + [
    { type: "assistant", cwd: p.root, message: { content: [{ type: "tool_use", id: "e9", name: "Edit", input: { file_path: join(p.root, "app", "tax.py") } }] } },
    { type: "user", cwd: p.root, message: { content: [{ type: "tool_result", tool_use_id: "e9", content: "ok" }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const later = new Date(Date.now() + 60_000);
  utimesSync(t, later, later);
  const files = /Its changes not committed yet: (.*)/.exec(p.ask())?.[1].split(", ").sort();
  assert.deepEqual(files, ["app/price.py", "app/tax.py"], "the edit after its Stop is in the note");
});

test("a Codex session cut off before its Stop is picked up by Claude Code", () => {
  const p = project();
  const session = "0b9e2a8c-1f2d-4c3b-9a7e-5d6c7b8a9f01";
  const dir = join(p.codex, "sessions", "2026", "11", "18");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(p.root, "app", "price.py"), "x = 5\n");
  const rows = [
    { type: "session_meta", timestamp: new Date().toISOString(), payload: { id: session, cwd: p.root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the rounding bug in app/price.py." }] } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "p0", input: "*** Begin Patch\n*** Update File: app/price.py\n*** End Patch" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p0", output: "ok" } },
  ];
  writeFileSync(join(dir, `rollout-2026-11-18T08-00-00-${session}.jsonl`), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const note = p.ask();
  assert.match(note, /left off \(codex/);
  assert.match(note, /app\/price\.py/);
});

test("nothing is written for the session asking, or for a session whose card is current", () => {
  const p = project();
  p.claude("done-1", ["app/price.py"], { stop: true });
  const snout = join(p.root, ".snout");
  const env = { ...p.env };
  assert.equal(catchUpSession(p.root, snout, "done-1", env), null, "its own transcript is not caught up");
  // A current card is left as it is; only an older one is written again.
  const t = join(p.home, "projects", claudeSlug(p.root), "done-1.jsonl");
  const earlier = new Date(Date.now() - 60_000);
  utimesSync(t, earlier, earlier);
  assert.equal(catchUpSession(p.root, snout, "someone-else", env), null);
  assert.equal(catchUpSession(mkdtempSync(join(tmpdir(), "snout-catchup-empty-")), snout, "x", env), null, "a project with no transcripts");
});

test("files a session changed through the shell count as its changes; a file left dirty before it started does not", () => {
  const p = project();
  // Dirty before the session started: someone else's change.
  writeFileSync(join(p.root, "app", "tax.py"), "x = 7\n");
  const before = new Date(Date.now() - 10 * 60_000);
  utimesSync(join(p.root, "app", "tax.py"), before, before);
  const dir = join(p.home, "projects", claudeSlug(p.root));
  mkdirSync(dir, { recursive: true });
  const t = join(dir, "shell-1.jsonl");
  const started = new Date(Date.now() - 1000).toISOString();
  p.run(["prompt-submit"], { session_id: "shell-1", prompt: "Fix the rounding bug in app/price.py." });
  // A script rewrites the file: no Edit call names it (the pickup pilot, caddy-8393).
  writeFileSync(join(p.root, "app", "price.py"), "x = 3\n");
  const rows = [
    { type: "user", cwd: p.root, timestamp: started, message: { content: "Fix the rounding bug in app/price.py." } },
    { type: "assistant", cwd: p.root, message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "python - <<'E'\np='app/price.py'\nopen(p,'w').write('x = 3\n')\nE" } }] } },
    { type: "user", cwd: p.root, message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "" }] } },
  ];
  writeFileSync(t, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const files = /Its changes not committed yet: (.*)/.exec(p.ask())?.[1].split(", ");
  assert.deepEqual(files, ["app/price.py"]);
});
