/**
 * The on-demand gate's own reading of a test run (bench/ondemand-gate.mjs): did it pass? Written
 * apart from Snout's parser (src/compact/memory.ts), so the gate does not grade Snout by Snout's
 * own rule. Each runner by its success and failure lines over the whole output, as its exit status
 * would say: a failure anywhere fails the run, even above a last line that reads "ok".
 *
 *   runVerdict(command, output) → "pass" | "fail" | "unknown"
 *
 * "unknown": the output shows neither (a runner not listed, nothing run, `[no test files]`); the
 * gate counts that as unverified.
 */

const RUNNERS = [
  // go test: `ok  <pkg>  0.4s` per package; `--- FAIL: TestX`, `FAIL <pkg>`, a panic or a build failure fails it.
  { name: "go", command: /\bgo test\b/, fail: /^(?:--- FAIL\b|FAIL\b|panic:)|\[build failed\]|\[setup failed\]/m, pass: /^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)/m },
  { name: "cargo", command: /\bcargo (?:test|nextest)\b/, fail: /test result: FAILED|error(?:\[E\d+\])?: could not compile|^error\[E\d+\]/m, pass: /test result: ok\./ },
  { name: "deno", command: /\bdeno test\b/, fail: /\| [1-9]\d* failed\b|^FAILED\b|\bFAILED \|/m, pass: /^ok \| \d+ passed \| 0 failed\b/m },
  { name: "node", command: /\bnode --test\b/, fail: /^ℹ fail [1-9]/m, pass: /^ℹ fail 0\s*$/m },
  { name: "tox", command: /\btox\b/, fail: /: (?:FAIL|ERROR)\b|evaluation failed/, pass: /^\s*\S+: OK\b|congratulations/m },
  { name: "pytest", command: /\bpytest\b/, fail: /\b[1-9]\d* (?:failed|errors?)\b|^(?:FAILED|ERROR)\b/m, pass: /\b\d+ passed\b/ },
  { name: "unittest", command: /\bunittest\b|manage\.py test\b|runtests\.py\b/, fail: /^FAILED \(/m, pass: /^OK\b/m },
  { name: "rspec", command: /\brspec\b/, fail: /\d+ examples?, [1-9]\d* failures?/, pass: /\d+ examples?, 0 failures/ },
  { name: "phpunit", command: /\bphpunit\b/, fail: /^FAILURES!|^ERRORS!/m, pass: /^OK \(\d+ tests?/m },
  { name: "mocha", command: /\bmocha\b/, fail: /\b[1-9]\d* failing\b/, pass: /\b\d+ passing\b/ },
  // vitest and jest, and package scripts that run one: "Tests  31 passed (31)", "Tests: 24 passed, 24 total".
  { name: "js", command: /\b(?:vitest|jest|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test\b|bun test)\b/, fail: /\b[1-9]\d* failed\b|^\s*FAIL\b|^ℹ fail [1-9]/m, pass: /\bTests?:?\s+\d+ passed\b|^ℹ fail 0\s*$|\b\d+ pass\b/m },
];

export function runVerdict(command, output) {
  const runner = RUNNERS.find((r) => r.command.test(command));
  if (!runner) return "unknown";
  if (runner.fail.test(output)) return "fail";
  return runner.pass.test(output) ? "pass" : "unknown";
}

/** Spaces and tabs as one space: what a stored result line keeps of the output it came from. */
export const squeeze = (s) => s.replace(/[ \t]+/g, " ").trim();
