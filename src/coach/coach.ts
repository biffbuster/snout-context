/**
 * The prompt coach: a scope check on the prompt that starts a task.
 *
 * A prompt is ~100 tokens; the session it starts can be millions. What makes a session
 * expensive is exploration: a prompt that names no file, no expected behaviour and no way
 * to check the result sends the agent reading around to find out. So the coach does not
 * shorten or rewrite prompts. It checks three things an agent otherwise has to discover,
 * and when a task-like prompt is missing them, it shows the USER a one-line tip. The agent
 * never sees the tip, and nothing is blocked.
 *
 *   target    which file, function, command or error the task is about
 *   behavior  what should happen, or what goes wrong now
 *   verify    how to check it: a test, a command, a reproduction
 *
 * Rules run locally, free, in well under a millisecond. With `coach: "jev"` and a
 * TYPESAFE_API_KEY, TypeSafe's Jev model answers the same three questions instead; the
 * prompt text is then sent to api.typesafe.ai, which is why that is opt-in.
 */
import { spawnSync } from "node:child_process";

export type CoachMode = "off" | "tip" | "jev";
export type Missing = "target" | "behavior" | "verify";

export interface Coaching {
  /** Worth coaching at all: a task request, not a reply, a question or a slash command. */
  taskLike: boolean;
  words: number;
  target: boolean;
  behavior: boolean;
  verify: boolean;
  /** 0–1: how much of what the agent needs to know the prompt already says. */
  score: number;
  missing: Missing[];
  /** The line shown to the user, or null when the prompt is fine or not a task. */
  tip: string | null;
  source: "rules" | "jev";
}

const TASK = /\b(fix|add|implement|build|create|make|refactor|debug|update|change|write|remove|delete|improve|optimi[sz]e|migrate|rename|support|handle|investigate|clean ?up|speed up|port|convert|rewrite|finish|wire|hook up)\b/i;
/** Replies inside a running task: the agent already has the context. */
const FOLLOW_UP = /^(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks?|thank you|continue|go( ahead)?|do it|proceed|next|again|looks good|lgtm|that|it|this|now|also|and|then|same|please)\b/i;

const FILE = /(?:^|[\s`'"(])(?:[\w.-]+\/)*[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|c|h|cpp|hpp|scala|sql|sh|ya?ml|toml|json|md|html|css|scss|vue|svelte|proto|graphql|tf|lock)\b/i;
const DIR = /(?:^|\s)(?:\.{0,2}\/)?(?:[\w-]+\/){1,}[\w-]*/;
const BACKTICK = /`[^`\n]{2,}`/;
const IDENT = /\b(?:[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+|[a-z][a-z0-9]*_[a-z0-9_]+)\b/;
const CALL = /\b[A-Za-z_][\w.]*\(\)/;
const LINE = /\b(?:line|L)\s?\d+\b|:\d+(?::\d+)?\b/;
const STACK = /(?:Error|Exception|Traceback|panic):|\bat\s+[\w.<>]+\s+\(/;
const BEHAVIOR = /\b(support(s|ing)?|so it|to show|to return|should|shouldn't|expected?|instead( of)?|returns?|returning|must|so that|currently|but it|when i|whenever|errors?|throws?|fails?|failing|crash(es|ing)?|undefined|null|nan|wrong|broken|incorrect|missing|hangs?|slow|timeout|ignores?|doesn'?t|isn'?t|never|always|equals?)\b/i;
const QUOTED = /"[^"\n]{4,}"|'[^'\n]{6,}'/;
const VERIFY = /\b(tests?|specs?|pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm test|yarn test|make test|passes|passing|pass|verify|reproduce|repro|curl|assert|snapshot|ci|lint|typecheck|build succeeds)\b/i;
const CODE_BLOCK = /```/;

export function scorePrompt(prompt: string): Coaching {
  const text = prompt.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const slash = text.startsWith("/");
  const followUp = words < 10 && FOLLOW_UP.test(text);
  const taskLike = !slash && !followUp && words >= 3 && TASK.test(text);

  const target = FILE.test(text) || DIR.test(text) || BACKTICK.test(text) || IDENT.test(text) || CALL.test(text) || LINE.test(text) || STACK.test(text);
  const behavior = BEHAVIOR.test(text) || QUOTED.test(text) || STACK.test(text);
  const verify = VERIFY.test(text) || CODE_BLOCK.test(text);
  return finish({ taskLike, words, target, behavior, verify, source: "rules" });
}

function finish(c: Omit<Coaching, "score" | "missing" | "tip">): Coaching {
  const score = (c.target ? 0.45 : 0) + (c.behavior ? 0.3 : 0) + (c.verify ? 0.25 : 0);
  const missing: Missing[] = [];
  if (!c.target) missing.push("target");
  if (!c.behavior) missing.push("behavior");
  if (!c.verify) missing.push("verify");
  // The target matters most: without one the agent has to search for it. With a target, a
  // prompt long enough to carry a spec is left alone even if our patterns miss its wording.
  const needsTip = c.taskLike && (!c.target || (!c.behavior && !c.verify && c.words < 12));
  return { ...c, score: Math.round(score * 100) / 100, missing, tip: needsTip ? tipFor(missing) : null };
}

const ASK: Record<Missing, string> = {
  target: "which file or function",
  behavior: "what should happen",
  verify: "how to check it",
};

function tipFor(missing: Missing[]): string {
  const asks = missing.map((m) => ASK[m]);
  const list = asks.length > 1 ? `${asks.slice(0, -1).join(", ")} and ${asks[asks.length - 1]}` : asks[0];
  return `Snout prompt coach: add ${list}, and the agent searches less.`;
}

// --- Jev -------------------------------------------------------------------------------

const QUESTIONS = {
  target: {
    type: "noul",
    instructions: "`prompt` is a request to an AI coding agent. Does it name a specific target for the work: a file, directory, function, class, command, error message or line?",
    criteria: {
      true: "Names at least one concrete thing in the codebase or its output that the agent can go straight to.",
      false: "Describes the work only in general terms, so the agent must search to find where it applies.",
    },
  },
  behavior: {
    type: "noul",
    instructions: "`prompt` is a request to an AI coding agent. Does it say what the correct behaviour should be, or describe what currently goes wrong?",
  },
  verify: {
    type: "noul",
    instructions: "`prompt` is a request to an AI coding agent. Does it say how to check the result: a test to pass, a command to run, or steps that reproduce the problem?",
  },
} as const;

/**
 * Jev's answers to the same three questions. The hook runs synchronously and exits when it
 * returns, so the HTTP call happens in a short-lived child process with a hard timeout;
 * any failure falls back to the rules.
 */
export function scoreWithJev(prompt: string, rules: Coaching, timeoutMs = 2500): Coaching {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key || !rules.taskLike) return rules;
  const body = JSON.stringify({ model: process.env.SNOUT_COACH_MODEL || "jev-latest", state: { prompt: prompt.slice(0, 4000) }, questions: QUESTIONS });
  const url = `${(process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "")}/v1/systemone`;
  const script = `fetch(process.argv[1],{method:"POST",headers:{authorization:"Bearer "+process.env.TYPESAFE_API_KEY,"content-type":"application/json"},body:require("fs").readFileSync(0,"utf8"),signal:AbortSignal.timeout(${timeoutMs - 300})}).then(r=>r.ok?r.text():Promise.reject(r.status)).then(t=>process.stdout.write(t),()=>process.exit(1))`;
  const r = spawnSync(process.execPath, ["-e", script, url], { input: body, encoding: "utf8", timeout: timeoutMs });
  if (r.status !== 0 || !r.stdout) return rules;
  try {
    const a = JSON.parse(r.stdout).answers ?? {};
    const yes = (k: keyof typeof QUESTIONS) => (typeof a[k]?.noul === "number" ? a[k].noul >= 0.5 : null);
    const [t, b, v] = [yes("target"), yes("behavior"), yes("verify")];
    if (t === null || b === null || v === null) return rules;
    return finish({ taskLike: rules.taskLike, words: rules.words, target: t, behavior: b, verify: v, source: "jev" });
  } catch {
    return rules;
  }
}
