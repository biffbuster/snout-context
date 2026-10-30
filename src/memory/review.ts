/**
 * Lessons a person reviews. The loop: a session's evidence → a short proposed lesson → a person's
 * review → an approved lesson in this project's memory → found by Claude Code or Codex when they
 * search (memory/tools.ts).
 *
 * A lesson is proposed on one of three grounds, and the session's own record has to show it before
 * it can be approved (checkProposals, at that session's Stop):
 *   test        a test run in that session passed (the record's test result);
 *   decision    the user gave it: the quoted words are in what the user typed that session;
 *   correction  the user corrected the work (quoted, as above), and it was resolved: a test run
 *               passed, or a commit was made.
 * Each one keeps its source session, its evidence, its date, its project and where it applies.
 * Nothing approves a lesson but a person: `snout memory approve`, or a replacement they write
 * themselves. An agent saying the user agreed is not an approval.
 *
 * An approved lesson reaches an agent when it searches. It is added to a prompt only with automatic
 * notes on (`snout memory notes on`, off by default), and then only when it fits the task on strong
 * evidence (facts.ts fittingLessons); a proposal never is (`verified` leaves lessons out).
 */
import { PASSED } from "../compact/memory.js";
import { safeText } from "../util/safe.js";
import { addObservation, find, listObservations, markSuperseded, write, type LessonBasis, type Observation, type ObsKind, type Stores } from "./store.js";
import { coveredBy, nearDuplicate } from "./quality.js";

export const BASES: LessonBasis[] = ["test", "decision", "correction"];
export const LESSON_CHARS = 240;
const MIN_QUOTE = 12;
/** Shapes of secrets a lesson must never carry (as lessons.ts). */
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})|(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}/i;
const one = (s: string) => s.replace(/\s+/g, " ").trim();

export interface LessonProposal {
  text: string;
  basis: LessonBasis;
  /** Where it holds: the task, file or situation. Required: a lesson with no conditions reads as a rule for everything. */
  applies: string;
  /** For a decision or a correction, the user's own words; for a test, the command that passed. */
  evidence: string;
  kind?: ObsKind;
  files?: string[];
  session: string | null;
  agent: string | null;
  /** The project's instruction files (quality.ts): a lesson they already state is not proposed. */
  instructions?: string;
}

/** Saves an agent's lesson as a proposal: private, never recalled, waiting for its record to back it. */
export function proposeLesson(s: Stores, user: string | null, p: LessonProposal, now = new Date()): Observation {
  const text = one(p.text);
  if (text.length < MIN_QUOTE) throw new Error("a lesson needs a sentence: what to do or avoid, and why");
  if (text.length > LESSON_CHARS) throw new Error(`keep a lesson under ${LESSON_CHARS} characters`);
  if (!BASES.includes(p.basis)) throw new Error(`basis must be one of ${BASES.join(", ")}: a test that passed, a decision the user gave, or a correction the user made`);
  const applies = one(p.applies);
  if (applies.length < 6) throw new Error("say where the lesson applies (applies_when): the task, file or situation");
  const evidence = one(p.evidence);
  if (p.basis !== "test" && evidence.length < MIN_QUOTE) throw new Error("quote the user's own words that gave the decision or the correction (evidence)");
  if (SECRET.test(`${text} ${evidence}`)) throw new Error("that looks like it holds a secret; a lesson never does");
  if (!p.session) throw new Error("no session on record here yet to check the lesson against");
  // Already said by an instruction file the agent loads, or by a lesson on record (quality.ts).
  if (p.instructions && coveredBy({ text, tags: [] }, p.instructions)) throw new Error("the project's instruction file (CLAUDE.md or AGENTS.md) already says this; agents load that file themselves");
  const same = nearDuplicate(s, { text, lesson: true, applies });
  if (same) return same;
  const kind = p.kind ?? (p.basis === "decision" ? "decision" : p.basis === "test" ? "command" : "gotcha");
  return addObservation(s, user, {
    kind, text, scope: "private", status: "proposed", via: "lesson", session: p.session, agent: p.agent, files: p.files, tags: ["lesson"], evidence,
    lesson: { basis: p.basis, applies, check: "pending" },
  }, now);
}

const words = (t: string) => t.toLowerCase().replace(/[“”"'`’‘]/g, "").replace(/[^\p{L}\p{N}.,;:%$€£-]+/gu, " ").trim();

/** The line the user typed that holds the quoted words (case, quote marks and spacing may differ), or null. */
export function saidByUser(quote: string, said: string[]): string | null {
  const q = words(quote);
  if (q.length < MIN_QUOTE) return null;
  return said.find((t) => words(t).includes(q)) ?? null;
}

/** What checkProposals reads from a session's record. */
export interface RecordView {
  session: string;
  agent?: string;
  test?: { command: string; result: string };
  recovered?: { line: string; command: string };
  commits: { sha: string }[];
}

/**
 * At a session's Stop: its pending proposals that its record now backs become verified, with what
 * the record showed. One it doesn't back stays pending, and can't be approved. `said`: what the
 * user typed in the session (from its transcript), used for the check and not kept.
 */
export function checkProposals(s: Stores, card: RecordView, said: string[], now = new Date()): Observation[] {
  const passed = card.test && PASSED(card.test.result) ? card.test : null;
  const out: Observation[] = [];
  for (const o of listObservations(s)) {
    if (o.status !== "proposed" || o.lesson?.check !== "pending" || o.source.session !== card.session || o.project !== s.project) continue;
    let checked: string | null = null;
    if (o.lesson.basis === "test") {
      // A passing run backs only the command the proposal actually cites. Otherwise an
      // unrelated passing test could make a false lesson appear verified.
      if (passed && one(o.source.evidence ?? "") === one(passed.command)) checked = `${passed.command} → ${passed.result}${card.recovered ? `, after "${card.recovered.line}" from ${card.recovered.command}` : ""}`;
    } else {
      const quote = o.source.evidence ?? "";
      const resolved = o.lesson.basis === "decision" || !!passed || card.commits.length > 0;
      if (saidByUser(quote, said) && resolved) checked = `the user said "${quote}"${o.lesson.basis === "correction" ? (passed ? `; then ${passed.command} → ${passed.result}` : "; then a commit") : ""}`;
    }
    if (!checked) {
      if (!o.source.agent && card.agent) write(s, { ...o, source: { ...o.source, agent: card.agent } });
      continue;
    }
    // The MCP server isn't told which agent called it; the session's record is.
    const next = { ...o, source: { ...o.source, agent: o.source.agent ?? card.agent ?? null }, lesson: { ...o.lesson, check: "verified" as const, checked }, updated: now.toISOString() };
    write(s, next);
    out.push(next);
  }
  return out;
}

/** An approved lesson: active, and approved by a person. */
export const approved = (o: Observation) => o.status === "active" && o.lesson?.review?.verdict === "approved";

/** This project's proposals, the checked ones first, then the newest. */
export function proposals(s: Stores): Observation[] {
  return listObservations(s).filter((o) => o.status === "proposed" && o.lesson && o.project === s.project)
    .sort((a, b) => Number(b.lesson!.check === "verified") - Number(a.lesson!.check === "verified") || (a.updated < b.updated ? 1 : -1));
}

/** This project's lessons in every state: proposed, approved, rejected and replaced. */
export const lessons = (s: Stores) => listObservations(s).filter((o) => o.lesson && o.project === s.project);

const lessonOf = (s: Stores, id: string) => { const o = find(s, id); return o?.lesson ? o : null; };

/**
 * A person approves a proposal: from then on a search may show it. Only one its record backs.
 * `replaces`: an approved lesson it takes the place of, which is kept as superseded.
 */
export function approveLesson(s: Stores, id: string, opts: { replaces?: string; note?: string } = {}, now = new Date()): Observation {
  const o = lessonOf(s, id);
  if (!o) throw new Error(`No lesson ${safeText(id, 20)}.`);
  if (o.status !== "proposed") throw new Error(`${o.id} is ${o.status === "active" ? "approved already" : o.status}.`);
  if (o.lesson!.check !== "verified") throw new Error(`${o.id}: its session's record doesn't show the evidence yet (${o.lesson!.basis}), so it can't be approved. Edit it, reject it, or wait for that session's next turn.`);
  const old = opts.replaces ? lessonOf(s, opts.replaces) : null;
  if (opts.replaces && (!old || !approved(old))) throw new Error(`${safeText(opts.replaces, 20)} is not an approved lesson; nothing was approved.`);
  const next: Observation = { ...o, status: "active", tags: [...new Set([...o.tags, "accepted"])].slice(0, 8), lesson: { ...o.lesson!, review: { verdict: "approved", at: now.toISOString(), ...(opts.note ? { note: opts.note } : {}) } }, updated: now.toISOString() };
  write(s, next);
  if (old) markSuperseded(s, old.id, next.id, now);
  return find(s, next.id)!;
}

/** A person rejects a proposal: kept on disk as rejected, never recalled. */
export function rejectLesson(s: Stores, id: string, note?: string, now = new Date()): Observation {
  const o = lessonOf(s, id);
  if (!o || o.status !== "proposed") throw new Error(`No proposal ${safeText(id, 20)}.`);
  const next: Observation = { ...o, status: "archived", lesson: { ...o.lesson!, review: { verdict: "rejected", at: now.toISOString(), ...(note ? { note: one(note) } : {}) } }, updated: now.toISOString() };
  write(s, next);
  return next;
}

/** A person rewords a proposal or its conditions before deciding. It stays a proposal, with the same evidence and check. */
export function editLesson(s: Stores, id: string, change: { text?: string; applies?: string }, now = new Date()): Observation {
  const o = lessonOf(s, id);
  if (!o || o.status !== "proposed") throw new Error(`No proposal ${safeText(id, 20)}.`);
  const text = one(change.text ?? "") || o.text;
  const applies = one(change.applies ?? "") || o.lesson!.applies;
  if (text.length > LESSON_CHARS) throw new Error(`keep a lesson under ${LESSON_CHARS} characters`);
  const next: Observation = { ...o, text, lesson: { ...o.lesson!, applies, edited: true }, updated: now.toISOString() };
  write(s, next);
  return next;
}

/**
 * A person writes the replacement for an approved lesson: approved as written, with the old one's
 * evidence and (unless given) conditions; the old one is kept as superseded.
 */
export function replaceLesson(s: Stores, user: string | null, id: string, text: string, applies?: string, now = new Date()): Observation {
  const old = lessonOf(s, id);
  if (!old || !approved(old)) throw new Error(`No approved lesson ${safeText(id, 20)}.`);
  if (one(text).length > LESSON_CHARS) throw new Error(`keep a lesson under ${LESSON_CHARS} characters`);
  const n = addObservation(s, user, {
    kind: old.kind, text, scope: old.scope, status: "active", via: "lesson", session: old.source.session, agent: old.source.agent, files: old.source.files, tags: ["lesson", "accepted"], evidence: old.source.evidence,
    lesson: { ...old.lesson!, applies: one(applies ?? "") || old.lesson!.applies, edited: true, review: { verdict: "approved", at: now.toISOString() } },
  }, now);
  if (n.id === old.id) return old;
  markSuperseded(s, old.id, n.id, now);
  return find(s, n.id)!;
}

const GROUND: Record<LessonBasis, string> = { test: "a test that passed", decision: "a decision the user gave", correction: "a correction the user made" };

/** Where a lesson came from, in a few words: its ground, session, agent and date, and when a person approved it. */
export function lessonCite(o: Observation): string {
  const l = o.lesson!;
  return `${GROUND[l.basis]}; session:${o.source.session ?? "?"}, ${o.source.agent ?? "agent"}, ${(o.source.ts || o.created).slice(0, 10)}${l.review?.verdict === "approved" ? `; approved ${l.review.at.slice(0, 10)}` : ""}`;
}

/** One lesson for a person reviewing it: every field it was asked to carry. */
export function lessonDetail(o: Observation, project = o.project): string {
  const l = o.lesson!;
  const state = o.status === "proposed" ? (l.check === "verified" ? "proposed, evidence checked" : "proposed, evidence not on record yet")
    : approved(o) ? `approved ${l.review!.at.slice(0, 10)}` : o.status === "superseded" ? `replaced by ${o.supersededBy}` : l.review?.verdict === "rejected" ? `rejected ${l.review.at.slice(0, 10)}` : o.status;
  return [
    `${o.id}  ${o.kind}  ${state}${l.edited ? " (edited by you)" : ""}`,
    `  lesson:   ${safeText(o.text, LESSON_CHARS)}`,
    `  applies:  ${safeText(l.applies, 200)}`,
    `  ground:   ${GROUND[l.basis]}`,
    `  evidence: ${o.source.evidence ? `"${safeText(o.source.evidence, 200)}"` : "(none given)"}`,
    `  record:   ${l.checked ? safeText(l.checked, 260) : "nothing yet: the session's record doesn't show it"}`,
    `  source:   session:${o.source.session ?? "?"} · ${o.source.agent ?? "agent"} · ${(o.source.ts || o.created).slice(0, 10)} · project ${project}`,
    o.source.files.length ? `  files:    ${o.source.files.join(", ")}` : null,
    o.supersedes ? `  replaces: ${o.supersedes}` : null,
    l.review?.note ? `  note:     ${safeText(l.review.note, 200)}` : null,
  ].filter(Boolean).join("\n");
}
