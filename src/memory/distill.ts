/**
 * Memory that writes itself: at the end of each turn, the session's card (memory.ts) is turned
 * into observations (store.ts) by fixed rules. No model, nothing sent anywhere.
 *
 *   a test run that passed      command      "Run the tests with: <command>", in general form
 *   a tool the machine lacks    gotcha       "<tool> is not installed here ..."
 *   a test command too slow     gotcha       "<command> runs past the agent's tool time limit ..."
 *   a standing instruction      preference   the user's own words, kept once said in two sessions
 *
 * An instruction is often about the task at hand ("don't push yet", "as part of this step"), and a
 * note is injected into every later session. So an instruction tied to the moment is never saved,
 * and any other one waits as a proposal until a second session repeats it.
 *
 * Everything goes into the user's private store: the same person's next session, in Claude Code
 * or Codex, starts with it, and nobody else sees it until they share it (`snout memory share <id>`).
 * Saving the same thing again is a no-op (store ids are content hashes), and a newer passing test
 * command supersedes the old one, so the store holds what is true now. A command run in another
 * folder (`cd ../other-repo && ...`) is that folder's, not this project's, and is never saved.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sharedWords, terms, wordForms, type Card } from "./memory.js";
import { acceptObservation, addObservation, archiveObservation, listObservations, markSuperseded, proposeObservation, reactivateObservation, supersedeObservation, type NewObservation, type Observation, type Stores } from "./store.js";
import { PASSED } from "../compact/memory.js";
import { coveredBy, restoreObservation, UNUSED } from "./quality.js";
import { onPath } from "../util/path.js";

/** The tool a "not installed" gotcha names, or null for any other observation. */
export const missingTool = (o: { kind: string; tags?: string[]; text: string }): string | null =>
  o.kind === "gotcha" && o.tags?.includes("missing") ? (/^(\S+) is not installed/.exec(o.text)?.[1] ?? null) : null;

/**
 * Archives this project's private "not installed" gotchas whose tool is now on PATH: once the
 * user installs it, the note would tell the agent not to call a tool that works. Shared ones are
 * left alone (another machine may still lack it). Returns what was archived.
 */
export function retireInstalled(s: Stores, installed: (tool: string) => boolean = onPath, now = new Date()): Observation[] {
  const out: Observation[] = [];
  for (const o of listObservations(s)) {
    const tool = missingTool(o);
    if (!tool || o.status !== "active" || o.scope !== "private" || o.project !== s.project || !installed(tool)) continue;
    const a = archiveObservation(s, o.id, now);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Whether a tool counts as installed for this project: on PATH, or installed by the project itself
 * (`node_modules/.bin`, or a dependency in package.json). A bare `vitest` that the shell can't find
 * is still the project's own vitest, run through npx or a script; it is not missing.
 */
export function installedFor(projectDir: string, onPathFn: (tool: string) => boolean = onPath): (tool: string) => boolean {
  const read = (f: string) => { try { return readFileSync(join(projectDir, f), "utf8"); } catch { return ""; } };
  return (tool) => {
    if (onPathFn(tool)) return true;
    if (["", ".cmd", ".ps1"].some((ext) => existsSync(join(projectDir, "node_modules", ".bin", tool + ext)))) return true;
    try {
      const pkg = JSON.parse(read("package.json") || "{}") as Record<string, unknown>;
      if (["dependencies", "devDependencies", "optionalDependencies"].some((k) => typeof pkg[k] === "object" && pkg[k] !== null && tool in (pkg[k] as object))) return true;
    } catch { /* not JSON: no Node dependencies to read */ }
    return pythonProvides(tool, read) || rustProvides(tool, read);
  };
}

/**
 * Python: a dependency the project declares (pyproject.toml, setup.cfg, requirements*.txt, Pipfile),
 * which runs as `python -m <tool>` or inside tox or a virtualenv even when the shell can't find it.
 */
function pythonProvides(tool: string, read: (f: string) => string): boolean {
  const name = tool.toLowerCase().replace(/[-_.]+/g, "[-_.]");
  const listed = new RegExp(`(?:^|["'\\s,\\[])${name}\\s*(?:[<>=!~;\\[,"'\\s]|$)`, "im");
  return ["pyproject.toml", "setup.cfg", "requirements.txt", "requirements-dev.txt", "dev-requirements.txt", "Pipfile"].some((f) => listed.test(read(f)));
}

/** Rust: the tools rustup installs with cargo, which `cargo fmt` and `cargo clippy` run though the shell can't find them. */
const RUSTUP_TOOLS = new Set(["rustc", "rustdoc", "rustfmt", "cargo-fmt", "cargo-clippy", "clippy-driver"]);
const rustProvides = (tool: string, read: (f: string) => string): boolean => RUSTUP_TOOLS.has(tool) && read("Cargo.toml") !== "";

/**
 * A command that runs in another folder: a `cd` to a named place outside the project (`../field-test`,
 * an absolute path, `~`, or a shell variable such as `"$SCRATCH"`). Inside the project, the card
 * already has the cd relative (`cd web`); a bare `cd ..` or `cd ../..` is the shell going back up
 * from a subfolder, and is dropped from the saved command rather than refused (generalTestCommand).
 */
export const runsElsewhere = (command: string): boolean =>
  [...command.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("[^"]*"|'[^']*'|\S+)/g)].some(({ 1: raw }) => {
    const t = raw!.replace(/^["']|["']$/g, "");
    if (/^(?:\.\.[\\/]?)+$/.test(t)) return false;
    return /^(?:\.\.[\\/]|[\\/~]|[A-Za-z]:)/.test(t) || /[$%]/.test(t);
  });

/**
 * Archives this project's private test-command and slow-test notes that run in another folder: saved
 * before runsElsewhere existed, they would send every session to another project's tests.
 */
export function retireElsewhere(s: Stores, now = new Date()): Observation[] {
  const out: Observation[] = [];
  for (const o of listObservations(s)) {
    if (o.status !== "active" || o.scope !== "private" || o.project !== s.project || !(o.tags.includes("test") || o.tags.includes("slow"))) continue;
    if (!runsElsewhere(o.text.replace(/^Run the tests with: /, ""))) continue;
    const a = archiveObservation(s, o.id, now);
    if (a) out.push(a);
  }
  return out;
}

/** Language toolchains: a passing run replaces the test command on record only within its own. */
const TOOLCHAINS: [string, RegExp][] = [
  ["go", /\bgo test\b/],
  ["rust", /\bcargo\b/],
  ["python", /\b(?:py\.?test|tox|nox|unittest|manage\.py|runtests\.py|python3?|uv run)\b/],
  ["js", /\b(?:npm|pnpm|yarn|bun|npx|node|deno|vitest|jest|mocha|c8)\b/],
  ["ruby", /\b(?:rspec|rake|bundle exec)\b/],
  ["php", /\b(?:phpunit|composer)\b/],
];

/**
 * Where a test command runs: the folder its `cd` steps lead to from the project root, and its
 * language's toolchain ("" when unknown).
 */
export function testPlace(command: string): { folder: string; toolchain: string } {
  const segments = command.split(" && ").map((s) => s.trim());
  const folder = segments.filter((s) => /^cd\s/.test(s)).map((s) => s.slice(3).trim().replace(/^\.[\\/]/, "").replace(/[\\/]+$/, "")).join("/") || ".";
  const run = segments.filter((s) => !/^cd\s/.test(s)).join(" && ");
  return { folder, toolchain: TOOLCHAINS.find(([, re]) => re.test(run))?.[0] ?? "" };
}

/**
 * Whether one test command can replace another: the same folder and the same toolchain (an
 * unknown one matches any). In a project with an API in Python and a web app in TypeScript,
 * `cd api && pytest -q` and `cd web && pnpm vitest run` are two answers, not one replacing the
 * other; `npm test` → `npx vitest run` in one folder still replaces.
 */
export function sameTestPlace(a: string, b: string): boolean {
  const x = testPlace(a.replace(/^Run the tests with: /, "")), y = testPlace(b.replace(/^Run the tests with: /, ""));
  return x.folder === y.folder && (x.toolchain === y.toolchain || !x.toolchain || !y.toolchain);
}

/** Wording that says a note replaces an earlier one ("Dates are now stored as ...", "no longer", "instead of"). */
export const REPLACES = /\b(?:now|no longer|instead of|replac(?:e|es|ed|ing)|switched|moved to|from now on)\b/i;
const REPLACEABLE = new Set(["decision", "convention", "preference", "fact"]);

/**
 * A note that says it replaces an earlier one retires that one: the same kind, scope and project,
 * still active, sharing three or more words with it. "Dates are now stored as epoch milliseconds"
 * retires "Dates are stored as UTC ISO strings", so a session is never given both. Returns the
 * notes it retired; `snout memory list --all` still shows them.
 */
export function replaceOlder(s: Stores, o: Observation, now = new Date()): Observation[] {
  if (o.status !== "active" || !REPLACEABLE.has(o.kind) || !REPLACES.test(o.text)) return [];
  const mine = wordForms(terms(o.text));
  const out: Observation[] = [];
  for (const old of listObservations(s)) {
    if (old.id === o.id || old.status !== "active" || old.kind !== o.kind || old.scope !== o.scope || old.project !== o.project || old.created > o.created) continue;
    if (sharedWords(terms(old.text), mine) < 3) continue;
    const r = markSuperseded(s, old.id, o.id, now);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Wording that makes an instruction lasting: "always", "never", "from now on", "in this project".
 * Saying a request again doesn't: "Run the tests and fix it." in two sessions is two tasks.
 */
const STANDING = /\b(?:always|never|whenever|every ?time|each time|from now on|going forward|by default|(?:do not|don'?t) ever|in (?:this|the|our) (?:project|repo|repository|codebase))\b/i;
export const standing = (text: string): boolean => STANDING.test(text);

/** Words that tie an instruction to the task at hand rather than to how the user always works. */
const ONE_OFF = /\b(?:yet|for now|right now|as part of|if needed|next|today|tomorrow|tonight|this (?:step|task|time|session|run|turn|pr|branch|checkout|commit|change|issue|folder|file|one))\b|^then\b/i;
export const oneOff = (text: string): boolean => ONE_OFF.test(text);

/** The word that starts the test run itself: `go test`, `npm test`, `pytest`, `node --test`, `runtests.py`. */
const RUNNER = /^(?:py\.?test|jest|vitest|mocha|rspec|phpunit|tox|unittest|test(?::[\w:-]+)?|--test|runtests\.py|(?:run[-_])?tests?(?:[-_]\w+)?\.(?:m?[jt]s|sh|py))$/;
/** Flags that pick the tests of one task (`-run TestX`, `-k name`, `-t "adds"`): dropped with their value. */
const SELECT = /^(?:-run|-k|-t|-g|--grep|--testNamePattern|--test-name-pattern|--testPathPattern|--filter|--deselect|-bench)$/;
/** Flags whose value is the next word and is part of how tests run here (`-tags integration`, `-p 1`). */
const VALUE = /^(?:-tags|-p|-parallel|-timeout|-count|-n|-m|-c|-e|-r|-j|--config|--require|--reporter|--parallel|--settings|--maxfail|--features|--jobs|--project|--env|--pool|--workspace|--package)$/;

/**
 * A passing test command in the form that holds for the next task: the runner, its flags and
 * environment, and a `cd` into a subproject stay; the tests one task picked (names, files,
 * packages, Django labels) become a placeholder. Measured on the Hugo product test, where
 * `go test ./tpl/... ./hugolib -run "Defer"` from one issue was the note the next issue started with.
 * The whole project (`./...`, `.`) and a glob over the suite (`test/*.test.mjs`) are not a selection and stay.
 */
export function generalTestCommand(command: string): string {
  // `cd ../..` back to the root from a folder the shell was left in says nothing about the next task.
  const segments = command.split(" && ").filter((s) => !/^cd\s+(?:\.\.(?:[\\/]|\s|$)|[\\/~]|[A-Za-z]:)/.test(s.trim()));
  return segments.map((segment) => {
    const words = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const start = words.findIndex((w) => RUNNER.test(w.split(/[\\/]/).pop()!));
    // A runner's name as another flag's value (`--chains pytest`) is not the run; `python -m pytest` is.
    if (start < 0 || (/^-/.test(words[start - 1] ?? "") && words[start - 1] !== "-m")) return segment;
    const kept = words.slice(0, start + 1);
    let dropped = false;
    for (let i = start + 1; i < words.length; i++) {
      const w = words[i]!;
      if (SELECT.test(w)) { i++; continue; }
      if (SELECT.test(w.split("=")[0]!) && w.includes("=")) continue;
      if (w.startsWith("-")) { kept.push(w); if (VALUE.test(w) && i + 1 < words.length) kept.push(words[++i]!); continue; }
      // The whole project, a glob over the suite, or a runner's own subcommand (`vitest run`).
      if (w === "./..." || w === "." || w.includes("*") || (i === start + 1 && /^(?:run|watch)$/.test(w))) { kept.push(w); continue; }
      if (!dropped) kept.push(/^go$/.test(words[start - 1] ?? "") ? "<packages>" : "<tests>");
      dropped = true;
    }
    while (kept[kept.length - 1] === "--") kept.pop();
    return kept.join(" ");
  }).join(" && ");
}

/** The observations one card supports. Pure: the rules, and nothing else. */
export function distillCard(card: Card): NewObservation[] {
  const base = { scope: "private" as const, via: "distill", session: card.session, agent: card.agent };
  const out: NewObservation[] = [];
  if (card.test && PASSED(card.test.result) && !runsElsewhere(card.test.command)) out.push({ ...base, kind: "command", text: `Run the tests with: ${generalTestCommand(card.test.command)}`, tags: ["test"], files: [], evidence: `${card.test.command} → ${card.test.result}` });
  for (const tool of card.missing ?? []) out.push({ ...base, kind: "gotcha", text: `${tool} is not installed on this machine: don't call it, or install it first.`, tags: ["missing"], ...(card.missingEvidence?.[tool] ? { evidence: card.missingEvidence[tool]!.trim() } : {}) });
  for (const cmd of card.slow ?? []) if (!runsElsewhere(cmd)) out.push({ ...base, kind: "gotcha", text: `${cmd} runs past the agent's tool time limit: run a narrower selection of tests.`, tags: ["slow"] });
  for (const rule of card.rules ?? []) if (rule.trim().length >= 8 && !oneOff(rule)) out.push({ ...base, kind: "preference", text: rule, tags: ["rule"], status: "proposed" });
  return out;
}

/**
 * Once per session start: instructions saved before they had to be repeated. One tied to the moment
 * is archived; any other goes back to a proposal, and comes back when a later session repeats it.
 */
export function retireOneOff(s: Stores, now = new Date()): Observation[] {
  const out: Observation[] = [];
  for (const o of listObservations(s)) {
    if (o.status !== "active" || o.scope !== "private" || o.kind !== "preference" || o.source.via !== "distill" || o.tags.includes("accepted")) continue;
    // Repeated and worded as lasting stays; a task request promoted only because it was said twice goes back.
    if (o.tags.includes("repeated") && standing(o.text)) continue;
    const next = oneOff(o.text) ? archiveObservation(s, o.id, now) : proposeObservation(s, o.id, now);
    if (next) out.push(next);
  }
  return out;
}

export interface DistillResult {
  added: Observation[];
  superseded: string[];
}

/**
 * Saves what a card supports. A passing test command different from the one on record for the
 * same folder and toolchain replaces it (one current answer to "how do I run the tests here", per
 * part of a project in several languages); everything else only adds.
 */
export function applyDistilled(s: Stores, user: string | null, card: Card, now = new Date(), installed: (tool: string) => boolean = onPath, instructions = ""): DistillResult {
  if (!user) return { added: [], superseded: [] }; // an unattended session has no private store to write
  const before = listObservations(s);
  const known = new Set(before.map((o) => o.id));
  const added: Observation[] = [];
  const superseded: string[] = [];
  for (const n of distillCard(card)) {
    const tool = missingTool(n);
    if (tool && installed(tool)) continue; // installed later in the same session
    if (coveredBy({ text: n.text, tags: n.tags ?? [] }, instructions)) continue; // CLAUDE.md or AGENTS.md already says it (quality.ts)

    const current = n.tags?.includes("test") ? before.find((o) => o.status === "active" && o.scope === "private" && o.project === s.project && o.tags.includes("test") && sameTestPlace(o.text, n.text)) : undefined;
    if (current && current.text !== n.text.replace(/\s+/g, " ").trim()) {
      const next = supersedeObservation(s, user, current.id, n.text, "distill", now, { session: n.session, agent: n.agent, evidence: n.evidence });
      if (next && next.id !== current.id) {
        superseded.push(current.id);
        added.push(next);
      }
      continue;
    }
    const o = addObservation(s, user, n, now);
    if (!known.has(o.id)) added.push(o);
    // Archived for going unused (quality.ts), and seen again: current again.
    else if (o.status === "archived" && o.tags.includes(UNUSED)) {
      const back = restoreObservation(s, o.id, now, n.status === "proposed" ? "proposed" : "active");
      if (back) added.push(back);
    }
    // No test command is current (a store left by an A, B, A loop before this was fixed): the one just run is.
    else if (!current && n.tags?.includes("test") && o.status === "superseded") {
      const back = reactivateObservation(s, o.id, now);
      if (back) added.push(back);
    }
    // The same instruction from a second session, worded as lasting: now it is how this user works.
    // A task request said twice ("Run the tests and fix it.") is still a task request.
    else if (o.status === "proposed" && n.tags?.includes("rule") && o.source.session !== card.session && standing(n.text)) {
      const kept = acceptObservation(s, o.id, now, ["repeated"]);
      if (kept) added.push(kept);
    }
  }
  return { added, superseded };
}
