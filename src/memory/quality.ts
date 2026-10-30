/**
 * What may enter the store, on top of the rules that make each note (distill.ts) and each lesson
 * (review.ts), and what leaves it:
 *
 *   covered    an instruction file (CLAUDE.md, AGENTS.md) already says it: the agent loads that file
 *              itself, so a note repeating it only costs tokens. A test command is covered when the
 *              file writes the command out; any other note when one paragraph of the file holds
 *              nearly all of its words (COVERED, in any of their forms).
 *   duplicate  a note on record says nearly the same (DUPLICATE of the larger one's words in common):
 *              the one on record stands, and the new one is not written.
 *   unused     archived at session start, kept on disk: a proposal nobody reviewed in PROPOSAL_DAYS,
 *              or a note a rule saved that no session was shown, fitted or opened in UNUSED_DAYS. A
 *              note the user wrote, asked for or accepted, and a lesson they approved, never decays.
 *              A rule that sees the same note again brings it back (distill.ts).
 *
 * Every note keeps its provenance as saved (store.ts `source`: the session, agent, time and the
 * record a rule saw); `verification` names the rule that let it be shown.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { terms, variants, wordForms } from "./memory.js";
import { archiveObservation, listObservations, write, type Observation, type Stores } from "./store.js";

/** The instruction files an agent loads on its own. */
export const INSTRUCTION_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md"];
export const COVERED = 0.8;
export const DUPLICATE = 0.8;
export const PROPOSAL_DAYS = 30;
export const UNUSED_DAYS = 90;
/** The tag a note archived for disuse carries, so the rule that saved it can bring it back. */
export const UNUSED = "unused";
const DAY = 86_400_000;
const norm = (s: string) => s.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

export function instructionText(projectDir: string): string {
  return INSTRUCTION_FILES.map((f) => { try { return readFileSync(join(projectDir, f), "utf8"); } catch { return ""; } }).join("\n\n");
}

/** A file's paragraphs and list items, each a unit a note could repeat; a long one in sentences. */
function units(instructions: string): string[] {
  return instructions.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.|#{1,6})\s)/)
    .flatMap((p) => (p.length > 600 ? p.split(/(?<=[.!?])\s+/) : [p]))
    .map((p) => p.trim()).filter(Boolean);
}

/** The share of a's words that b has, in any of their forms. */
function overlap(a: string[], b: Set<string>): number {
  const mine = [...new Set(a)];
  return mine.length ? mine.filter((w) => variants(w).some((v) => b.has(v))).length / mine.length : 0;
}

/** Whether an instruction file already says what this note says. */
export function coveredBy(o: Pick<Observation, "text" | "tags">, instructions: string): boolean {
  if (!instructions.trim()) return false;
  const text = norm(instructions);
  if (o.tags?.includes("test")) {
    const command = norm(o.text.replace(/^Run the tests with: /, ""));
    return command.length >= 4 && text.includes(command);
  }
  if (text.includes(norm(o.text))) return true;
  const words = terms(o.text);
  if (new Set(words).size < 3) return false;
  return units(instructions).some((u) => overlap(words, wordForms(terms(u))) >= COVERED);
}

const numbers = (s: string) => [...new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? [])].sort().join(" ");
const negated = (s: string) => /\b(?:not|never|no|don'?t|doesn'?t|isn'?t|without|instead)\b/i.test(s);

/**
 * How alike two notes are: the share of words in common, of the one with more. Two notes with
 * different numbers, or one negated and one not, say different things whatever their words
 * ("rent is 40 euros", "rent is 45 euros"): 0.
 */
export function likeness(a: string, b: string): number {
  if (numbers(a) !== numbers(b) || negated(a) !== negated(b)) return 0;
  const wa = [...new Set(terms(a))], wb = [...new Set(terms(b))];
  if (wa.length < 3 || wb.length < 3) return 0;
  const [small, large] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const forms = wordForms(large);
  return small.filter((w) => variants(w).some((v) => forms.has(v))).length / large.length;
}

/** A rule's own notes (test commands, missing tools, slow tests) are compared by their rules, not their words. */
const RULED = ["test", "missing", "slow"];

/**
 * The note on record, active or waiting for review, that says nearly what this text says, in the
 * same project and scope: a lesson only against lessons (a rejected one included, so a lesson the
 * user turned down isn't proposed again in other words), any other note against notes.
 */
export function nearDuplicate(s: Stores, n: { text: string; scope?: string; lesson?: boolean; applies?: string }): Observation | null {
  const scope = n.scope ?? "private";
  const said = n.lesson ? `${n.text} ${n.applies ?? ""}` : n.text;
  return listObservations(s).find((o) => {
    if (o.scope !== scope || (o.project !== s.project && o.project !== "*") || o.tags.some((t) => RULED.includes(t))) return false;
    if (!!o.lesson !== !!n.lesson) return false;
    const live = o.status === "active" || o.status === "proposed" || (o.lesson?.review?.verdict === "rejected");
    return live && likeness(said, o.lesson ? `${o.text} ${o.lesson.applies}` : o.text) >= DUPLICATE;
  }) ?? null;
}

/**
 * What let a note be shown, in a few words: the rule that saw its record, or the person. "not
 * verified" for an agent's proposal nobody has accepted.
 */
export function verification(o: Observation): string {
  if (o.lesson) return o.lesson.review?.verdict === "approved" ? "approved by the user" : o.lesson.review?.verdict === "rejected" ? "rejected by the user" : o.lesson.check === "verified" ? "backed by its session's record, not yet reviewed" : "not verified";
  if (o.tags.includes("test")) return "a passing test run";
  if (o.tags.includes("missing")) return "a command-not-found error";
  if (o.tags.includes("slow")) return "a test run past the tool time limit";
  if (o.tags.includes("repeated")) return "the user said it in two sessions";
  if (o.source.via === "manual") return "written by the user";
  if (o.source.via === "mcp:user-asked") return "the user asked for it";
  if (o.tags.includes("accepted") || (o.source.via.startsWith("mcp") && o.status === "active")) return "accepted by the user";
  return "not verified";
}

/** The last time each note was shown, fitted to a prompt or opened, from this project's recall.jsonl. */
export function lastUses(snoutDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw = "";
  try { raw = readFileSync(join(snoutDir, "recall.jsonl"), "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.includes("o_")) continue;
    try {
      const r = JSON.parse(line) as { ts?: string; items?: unknown; shown?: unknown };
      const ids = [...(Array.isArray(r.items) ? r.items : []), ...(Array.isArray(r.shown) ? r.shown : [])].filter((x): x is string => typeof x === "string");
      for (const id of ids) if (r.ts && (out.get(id) ?? "") < r.ts) out.set(id, r.ts);
    } catch { /* a torn line: skipped */ }
  }
  return out;
}

/** The person's own notes, and lessons they approved, never decay. */
const keptByPerson = (o: Observation) =>
  o.source.via === "manual" || o.source.via === "mcp:user-asked" || o.tags.includes("accepted") || o.lesson?.review?.verdict === "approved";

/**
 * Once per session start: archives this project's proposals nobody reviewed in PROPOSAL_DAYS, and
 * notes a rule saved that went unused for UNUSED_DAYS (lastUses). Only private ones: a shared
 * note is the team's to retire. Returns what was archived.
 */
export function retireUnused(s: Stores, used: Map<string, string>, now = new Date()): Observation[] {
  const out: Observation[] = [];
  for (const o of listObservations(s)) {
    if (o.scope !== "private" || o.project !== s.project || keptByPerson(o)) continue;
    // A proposal counts from when it was made: its check at Stop changes it, and is not a review.
    const last = o.status === "proposed" ? o.created : [o.updated, used.get(o.id) ?? ""].sort().at(-1)!;
    const age = (now.getTime() - Date.parse(last)) / DAY;
    const due = o.status === "proposed" ? age > PROPOSAL_DAYS : o.status === "active" && age > UNUSED_DAYS;
    if (!due) continue;
    const a = archiveObservation(s, o.id, now);
    if (!a) continue;
    const tagged = { ...a, tags: [...a.tags.filter((t) => t !== UNUSED).slice(0, 7), UNUSED] };
    write(s, tagged);
    out.push(tagged);
  }
  return out;
}

/**
 * A note archived as unused, back: by the user (`snout memory restore`), or by the rule that saved it
 * seeing it again, as what that rule makes (a standing instruction comes back a proposal).
 */
export function restoreObservation(s: Stores, id: string, now = new Date(), status: "active" | "proposed" = "active"): Observation | null {
  const o = listObservations(s).find((x) => x.id === id || (id.length >= 6 && x.id.startsWith(id)));
  if (!o || o.status !== "archived" || !o.tags.includes(UNUSED)) return null;
  const next: Observation = { ...o, status, tags: o.tags.filter((t) => t !== UNUSED), updated: now.toISOString() };
  write(s, next);
  return next;
}
