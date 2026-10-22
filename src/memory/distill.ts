/**
 * Memory that writes itself: at the end of each turn, the session's card (memory.ts) is turned
 * into observations (store.ts) by fixed rules. No model, nothing sent anywhere.
 *
 *   a test run that passed      command      "Run the tests with: <command>"
 *   a tool the machine lacks    gotcha       "<tool> is not installed here ..."
 *   a test command too slow     gotcha       "<command> runs past the agent's tool time limit ..."
 *   a standing instruction      preference   the user's own words
 *
 * Everything goes into the user's private store: the same person's next session, in Claude Code
 * or Codex, starts with it, and nobody else sees it until they share it (`snout memory share <id>`).
 * Saving the same thing again is a no-op (store ids are content hashes), and a newer passing test
 * command supersedes the old one, so the store holds what is true now.
 */
import type { Card } from "./memory.js";
import { addObservation, archiveObservation, listObservations, supersedeObservation, type NewObservation, type Observation, type Stores } from "./store.js";
import { PASSED } from "../compact/memory.js";
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

/** The observations one card supports. Pure: the rules, and nothing else. */
export function distillCard(card: Card): NewObservation[] {
  const base = { scope: "private" as const, via: "distill", session: card.session, agent: card.agent };
  const out: NewObservation[] = [];
  if (card.test && PASSED(card.test.result)) out.push({ ...base, kind: "command", text: `Run the tests with: ${card.test.command}`, tags: ["test"], files: [] });
  for (const tool of card.missing ?? []) out.push({ ...base, kind: "gotcha", text: `${tool} is not installed on this machine: don't call it, or install it first.`, tags: ["missing"] });
  for (const cmd of card.slow ?? []) out.push({ ...base, kind: "gotcha", text: `${cmd} runs past the agent's tool time limit: run a narrower selection of tests.`, tags: ["slow"] });
  for (const rule of card.rules ?? []) if (rule.trim().length >= 8) out.push({ ...base, kind: "preference", text: rule, tags: ["rule"] });
  return out;
}

export interface DistillResult {
  added: Observation[];
  superseded: string[];
}

/**
 * Saves what a card supports. A passing test command different from the one on record replaces
 * it (one current answer to "how do I run the tests here"); everything else only adds.
 */
export function applyDistilled(s: Stores, user: string | null, card: Card, now = new Date(), installed: (tool: string) => boolean = onPath): DistillResult {
  if (!user) return { added: [], superseded: [] }; // an unattended session has no private store to write
  const before = listObservations(s);
  const known = new Set(before.map((o) => o.id));
  const added: Observation[] = [];
  const superseded: string[] = [];
  for (const n of distillCard(card)) {
    const tool = missingTool(n);
    if (tool && installed(tool)) continue; // installed later in the same session

    const current = n.tags?.includes("test") ? before.find((o) => o.status === "active" && o.scope === "private" && o.project === s.project && o.tags.includes("test")) : undefined;
    if (current && current.text !== n.text.replace(/\s+/g, " ").trim()) {
      const next = supersedeObservation(s, user, current.id, n.text, "distill", now);
      if (next && next.id !== current.id) {
        superseded.push(current.id);
        added.push(next);
      }
      continue;
    }
    const o = addObservation(s, user, n, now);
    if (!known.has(o.id)) added.push(o);
  }
  return { added, superseded };
}
