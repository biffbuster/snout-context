// `snout audit ci`: the YAML reader, and AI steps in GitHub Actions with what makes them run too often.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditCi, renderCi, cronPerMonth, parseYaml } from "../dist/lib.mjs";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "snout-ci-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const flags = (s) => s.flags.map((f) => f.code).sort();

test("the YAML reader handles what workflows use", () => {
  const doc = parseYaml([
    "name: Review # trailing comment",
    "on:",
    "  pull_request:",
    "    types: [opened, 'ready_for_review']",
    "  schedule:",
    "    - cron: '0 3 * * 1'",
    "jobs:",
    "  review:",
    "    if: |",
    "      github.event.pull_request.draft == false",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: \"Run: it\"",
    "        run: >-",
    "          echo a",
    "          echo b",
    "        with: { model: opus, n: 3 }",
    "      -",
    "        uses: x/y@v1",
  ].join("\r\n"));
  assert.equal(doc.name, "Review");
  assert.deepEqual(doc.on.pull_request.types, ["opened", "ready_for_review"]);
  assert.equal(doc.on.schedule[0].cron, "0 3 * * 1");
  assert.equal(doc.jobs.review.if, "github.event.pull_request.draft == false\n");
  assert.equal(doc.jobs.review.steps[0].uses, "actions/checkout@v4");
  assert.equal(doc.jobs.review.steps[1].name, "Run: it");
  assert.equal(doc.jobs.review.steps[1].run, "echo a echo b");
  assert.deepEqual(doc.jobs.review.steps[1].with, { model: "opus", n: "3" });
  assert.equal(doc.jobs.review.steps[2].uses, "x/y@v1");
});

test("cron frequency", () => {
  assert.equal(cronPerMonth("0 3 * * 1"), 4);
  assert.equal(cronPerMonth("0 * * * *"), 720);
  assert.equal(cronPerMonth("*/15 9-17 * * 1-5"), 771); // 36 a day on about 21 weekdays
  assert.equal(cronPerMonth("bad"), null);
});

test("an automation review on every push is flagged with each fix; a tidy one is not", () => {
  const root = repo({
    ".github/workflows/review.yml": [
      "on:",
      "  pull_request:",
      "jobs:",
      "  review:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: anthropics/claude-code-action@v1",
      "        with:",
      "          prompt: Review this PR",
      "          claude_args: --model claude-opus-5-5",
    ].join("\n"),
    ".github/workflows/tidy.yml": [
      "on:",
      "  pull_request:",
      "    types: [opened, ready_for_review]",
      "concurrency:",
      "  group: review-${{ github.event.pull_request.number }}",
      "  cancel-in-progress: true",
      "jobs:",
      "  review:",
      "    if: github.event.pull_request.draft == false && github.event.pull_request.user.type != 'Bot'",
      "    steps:",
      "      - uses: anthropics/claude-code-action@v1",
      "        with:",
      "          prompt: Review this PR",
      "          claude_args: '--model claude-sonnet-5-5 --max-turns 12'",
    ].join("\n"),
    ".github/workflows/build.yml": "on: push\njobs:\n  b:\n    steps:\n      - run: npm test\n",
    "CLAUDE.md": "# Rules\n" + "Keep it short. ".repeat(200),
  });
  const a = auditCi(root);
  assert.equal(a.workflows, 3);
  assert.equal(a.steps.length, 2);
  const [review, tidy] = a.steps;
  assert.equal(review.mode, "automation");
  assert.equal(review.model, "claude-opus-5-5");
  assert.deepEqual(flags(review), ["bot-prs", "drafts", "every-push", "no-concurrency", "no-limit", "top-model"]);
  assert.equal(tidy.maxTurns, 12);
  assert.deepEqual(flags(tidy), []);
  assert.ok(a.loadedPerRun.claude > 300);
  const text = renderCi(a);
  assert.match(text, /review\.yml › review/);
  assert.match(text, /fix: concurrency:/);
  assert.match(text, /nothing to change/);
});

test("tag mode answers mentions only; a comment-triggered CLI run without a filter is flagged", () => {
  const root = repo({
    ".github/workflows/claude.yml": "on:\n  issue_comment:\n    types: [created]\njobs:\n  c:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n",
    ".github/workflows/cli.yml": "on: [issue_comment]\njobs:\n  c:\n    timeout-minutes: 20\n    steps:\n      - run: |\n          npx -y @anthropic-ai/claude-code -p \"triage\" --max-budget-usd 1\n",
    ".github/workflows/codex.yml": "on:\n  schedule:\n    - cron: '0 * * * *'\njobs:\n  c:\n    steps:\n      - uses: openai/codex-action@v1\n        with:\n          effort: high\n",
  });
  const a = auditCi(root);
  const by = Object.fromEntries(a.steps.map((s) => [s.workflow, s]));
  assert.equal(by["claude.yml"].mode, "tag");
  assert.deepEqual(flags(by["claude.yml"]), ["no-limit"]);
  assert.equal(by["cli.yml"].via, "cli");
  assert.equal(by["cli.yml"].budgetUsd, 1);
  assert.deepEqual(flags(by["cli.yml"]), ["every-comment"]);
  assert.equal(by["codex.yml"].agent, "codex");
  assert.equal(by["codex.yml"].effort, "high");
  assert.equal(by["codex.yml"].scheduledPerMonth, 720);
  assert.deepEqual(flags(by["codex.yml"]), ["frequent-schedule"]);
});

test("no workflows, no AI steps", () => {
  assert.match(renderCi(auditCi(repo({ "README.md": "hi" }))), /No AI agents run/);
});
