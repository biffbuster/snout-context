/**
 * Lessons the agent writes itself. The fixed rules (distill.ts) keep what they were written for:
 * a passing test command, a missing tool. What a session actually figured out (the setting the
 * tests need, the file a bug was really in) is clearest to the model that just did it. So when a
 * session got past a failure, Snout asks it once, at Stop, for one line starting `Lesson:`, and
 * keeps that line as a proposal (memory/review.ts): checked against the session's record, and
 * recalled only once the user approves it.
 *
 * Only then: a session that met no failure is asked nothing and costs nothing. Opt-in
 * (`memoryLessons`), private to the user who ran it, never shared on its own.
 */
import type { Card } from "./memory.js";
import { safeText } from "../util/safe.js";

const MAX_LESSONS = 2;
const MAX_CHARS = 240;
/** Shapes of secrets a lesson must never carry: keys, tokens, passwords in a line meant to be reused. */
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})|(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}/i;

/** What the agent is asked, or null when the session got past nothing. `known`: notes already kept, not to be repeated. */
export function lessonQuestion(card: Card, known: string[]): string | null {
  const r = card.recovered;
  if (!r) return null;
  const lines = [
    `Snout memory: this session hit a failure and got past it (\`${safeText(r.command, 120)}\`: ${safeText(r.line, 160)}).`,
    "Before you finish, leave the next session in this repo what it would need to skip that: reply with one line starting `Lesson:` that names the exact command, file or setting and why, in under 200 characters, then ` When: ` and where it applies. The user reviews it before any session sees it. Don't change any files.",
  ];
  if (known.length) lines.push(`Already kept, don't repeat: ${known.slice(0, 8).map((k) => `"${safeText(k, 120)}"`).join("; ")}.`);
  lines.push("If nothing is worth keeping, reply `Lesson: none`.");
  return lines.join("\n");
}

/** The lessons in the agent's reply: up to two `Lesson:` lines, none of "none", no secrets. */
export function parseLessons(reply: string): string[] {
  const out: string[] = [];
  for (const part of reply.split(/\bLesson:\s*/i).slice(1)) {
    const text = part.split(/\n/)[0]!.replace(/[`*_]+$/g, "").trim().slice(0, MAX_CHARS);
    if (text.length < 12 || /^none\b/i.test(text) || SECRET.test(text)) continue;
    if (!out.some((t) => t.toLowerCase() === text.toLowerCase())) out.push(text);
    if (out.length >= MAX_LESSONS) break;
  }
  return out;
}
