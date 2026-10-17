// bench/memseed.mjs: the memory pilot's prior work, written through Snout's own Stop hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/snout.mjs", import.meta.url));

test("earlier issues become cards through each agent's Stop hook; later issues and the task itself never do", async () => {
  // Cached trajectories, so nothing is downloaded.
  process.env.TRAJS = mkdtempSync(join(tmpdir(), "snout-trajs-"));
  const { SOURCES, agentOf, seedMemory } = await import("../bench/memseed.mjs");
  const ids = { claude: [], codex: [] };
  for (let i = 1; ids.claude.length < 2 || ids.codex.length < 2; i++) {
    const id = `acme__lib-${i}`;
    if (ids[agentOf(id)].length < 2) ids[agentOf(id)].push(id);
  }
  const traj = (file) => ({
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Fix the issue." },
      { role: "assistant", content: `Let me look at the parser.\n\n\`\`\`bash\ngrep -n parse ${file}\n\`\`\`` },
      { role: "user", content: "<returncode>0</returncode>\n12:def parse(text):" },
      { role: "assistant", content: "The parser drops trailing commas; the fix keeps them and the tests pass now." },
      { role: "exit", content: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/reproduce.py b/reproduce.py\n` },
    ],
  });
  const [c1, c2] = ids.claude, [x1, x2] = ids.codex;
  const issues = [
    { instance_id: c1, repo: "acme/lib", created_at: "2021-01-01T00:00:00Z", problem_statement: "Trailing commas are dropped by the parser", file: "lib/parse.py" },
    { instance_id: x1, repo: "acme/lib", created_at: "2021-02-01T00:00:00Z", problem_statement: "Config loader ignores the env override", file: "lib/config.py" },
    { instance_id: c2, repo: "acme/lib", created_at: "2022-06-01T00:00:00Z", problem_statement: "Filed after the task", file: "lib/later.py" },
    { instance_id: x2, repo: "other/repo", created_at: "2020-01-01T00:00:00Z", problem_statement: "Another repository", file: "x.py" },
  ];
  for (const d of issues) {
    const dir = join(process.env.TRAJS, SOURCES[agentOf(d.instance_id)].replace(/\//g, "__"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${d.instance_id}.json`), JSON.stringify(traj(d.file)));
  }
  const task = { instance_id: "acme__lib-999", repo: "acme/lib", created_at: "2022-01-01T00:00:00Z" };
  const ws = mkdtempSync(join(tmpdir(), "snout-seedws-"));
  mkdirSync(join(ws, ".snout"));
  writeFileSync(join(ws, ".snout/config.json"), JSON.stringify({ mode: "enforce", memory: true }) + "\n");

  const seeded = seedMemory(task, ws, [...issues, { ...task, problem_statement: "the task" }], CLI);
  assert.deepEqual({ claude: seeded.claude, codex: seeded.codex }, { claude: 1, codex: 1 });
  assert.deepEqual(seeded.codexSessions, [`seed-${x1}`]);
  const cards = readdirSync(join(ws, ".snout/memory")).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(cards, [`seed-${c1}.json`, `seed-${x1}.json`].sort());
  const claude = JSON.parse(readFileSync(join(ws, ".snout/memory", `seed-${c1}.json`), "utf8"));
  const codex = JSON.parse(readFileSync(join(ws, ".snout/memory", `seed-${x1}.json`), "utf8"));
  assert.equal(claude.agent, "claude");
  assert.equal(codex.agent, "codex");
  assert.match(claude.task, /Trailing commas/);
  assert.match(codex.task, /env override/);
  assert.deepEqual(claude.changed, ["lib/parse.py"]);
  assert.deepEqual(codex.changed, ["lib/config.py"]);
  // The agent reaches prior work only through memory: no transcript is left in the workspace.
  assert.deepEqual(readdirSync(ws).sort(), [".snout"]);
});
