// Section reads: a whole-file Read of a long doc returns its opening and a map of its
// headings; a long log returns its tail and where errors are. Ranged reads and instruction
// files are never cut.
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

function project() {
  const root = mkdtempSync(join(tmpdir(), "snout-longdoc-"));
  mkdirSync(join(root, ".snout"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".claude/skills/deploy"), { recursive: true });
  const para = "This paragraph explains one part of the system in enough words to look like real documentation. ".repeat(4);
  const sections = ["Overview", "Install", "Configuration", "Billing <script>alert(1)</script>", "Refunds", "Troubleshooting"];
  const doc = sections.map((s, i) => `## ${s}\n\n${Array.from({ length: 40 }, () => para).join("\n\n")}\n\n\`\`\`sh\n# not a heading ${i}\n\`\`\``).join("\n\n");
  writeFileSync(join(root, "docs/guide.md"), `# Guide\n\n${doc}\n`);
  writeFileSync(join(root, "CLAUDE.md"), `# Rules\n\n${doc}\n`);
  writeFileSync(join(root, ".claude/skills/deploy/notes.md"), `# Deploy\n\n${doc}\n`);
  writeFileSync(join(root, "docs/short.md"), "# Short\n\nTiny.\n");
  const log = Array.from({ length: 3000 }, (_, i) => (i === 1200 ? "ERROR payment webhook failed: timeout" : `2026-10-02T10:00:${String(i % 60).padStart(2, "0")} info request ${i} served in 12ms`)).join("\n") + "\n";
  writeFileSync(join(root, "server.log"), log);
  return root;
}

function pre(root, file, extra = {}, env = { SNOUT_MODE: "enforce" }) {
  const r = spawnSync(process.execPath, [CLI, "pre-tool"], {
    input: JSON.stringify({ session_id: "ld", cwd: root, tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: join(root, file), ...extra } }),
    encoding: "utf8", env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : undefined;
}

test("a long doc read whole returns its opening plus a section map with line numbers", () => {
  const root = project();
  const out = pre(root, "docs/guide.md");
  assert.equal(out.permissionDecision, "allow");
  assert.equal(out.updatedInput.offset, 1);
  assert.ok(out.updatedInput.limit <= 60);
  assert.match(out.additionalContext, /long document/);
  assert.match(out.additionalContext, /## Install L\d+/);
  assert.match(out.additionalContext, /## Troubleshooting L\d+/);
  assert.doesNotMatch(out.additionalContext, /not a heading/, "comments inside code fences are not headings");
  assert.doesNotMatch(out.additionalContext, /[<>]/, "heading text is reduced to a safe character set");
});

test("ranged reads, short docs, instruction files and observe mode are never cut", () => {
  const root = project();
  assert.equal(pre(root, "docs/guide.md", { offset: 200, limit: 400 })?.updatedInput, undefined, "a ranged read comes back as asked");
  assert.equal(pre(root, "docs/short.md")?.updatedInput, undefined);
  assert.equal(pre(root, "CLAUDE.md")?.updatedInput, undefined, "instructions are followed whole");
  assert.equal(pre(root, ".claude/skills/deploy/notes.md")?.updatedInput, undefined, "skills too");
  assert.equal(pre(root, "docs/guide.md", {}, { SNOUT_MODE: "observe" })?.updatedInput, undefined);
  writeFileSync(join(root, ".snout/config.json"), JSON.stringify({ longDocs: false }));
  assert.equal(pre(root, "docs/guide.md")?.updatedInput, undefined, "longDocs: false turns it off");
});

test("a long log returns its last lines and where earlier errors are", () => {
  const root = project();
  const out = pre(root, "server.log");
  assert.ok(out.updatedInput.offset > 2800, JSON.stringify(out.updatedInput));
  assert.equal(out.updatedInput.offset + out.updatedInput.limit - 1, 3000, "through the last line");
  assert.match(out.additionalContext, /long log/);
  assert.match(out.additionalContext, /L1201/);
  assert.doesNotMatch(out.additionalContext, /webhook/, "log text never reaches the note, only line numbers");
});

test("a file over Claude Code's 256 KB read limit is left to its own refusal, with no saving recorded", () => {
  const root = project();
  const big = Array.from({ length: 4000 }, (_, i) => `2026-10-02T10:00:00Z INFO GET /api/orders 200 ${i}ms user=u_${i % 500} trace=${"x".repeat(20)}`).join("\n") + "\n";
  assert.ok(big.length > 256 * 1024);
  writeFileSync(join(root, "big.log"), big);
  assert.equal(pre(root, "big.log"), undefined, "no window: Claude Code refuses the whole read itself");
  assert.ok(pre(root, "big.log", { offset: 3900, limit: 50 }) === undefined, "a ranged read still passes");
  const whole = JSON.parse(readFileSync(join(root, ".snout/ledger.jsonl"), "utf8").split("\n")[0]);
  assert.equal(whole.decision, "allow");
  assert.equal(whole.tokensAvoidedEst, 0, "nothing withheld: none of it was going to reach the context");
  assert.ok(!whole.trimmed);
});

test("a ranged read of a file over the size cap goes ahead (PointFive C1)", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "snout-ranged-"));
  mkdirSync(join(root, "logs"));
  const line = "2026-07-04T09:00:00Z INFO api ok request_id=r1 something happened here\n";
  writeFileSync(join(root, "logs/prod.log"), line.repeat(25_000)); // ~1.8 MB
  const cli = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "pre-tool"], {
    input: JSON.stringify({ session_id: "s", cwd: root, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "u", tool_input: { file_path: join(root, "logs/prod.log"), offset: 16990, limit: 400 } }),
    encoding: "utf8", env: { ...process.env, SNOUT_MODE: "enforce" },
  });
  const out = JSON.parse(r.stdout || "{}");
  const decision = out.hookSpecificOutput?.permissionDecision;
  assert.ok(decision === undefined || decision === "allow", `ranged read was ${decision}: ${out.hookSpecificOutput?.permissionDecisionReason ?? ""}`);
});
