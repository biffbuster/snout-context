/**
 * One way to judge whether a record answers a question, shared by the three paths that look things
 * up: the notes a prompt gets (facts.ts), `snout recall` (memory.ts) and `snout_memory_search`
 * (tools.ts). Each path keeps its own ranking; this decides what counts as evidence, and how strong.
 *
 *   strong   the question names a path the record is about, or a code name the record contains,
 *            or, in a question of one or two words, one of the record's own folders, files or
 *            programs by its word (nameForms), or shares two of its words with it (one, when it
 *            has only one); with the optional
 *            local model (semantic.ts), also a very close meaning alone (MEANING_ALONE), and the
 *            one record among those sharing a word that is clearly closest in meaning (closestInMeaning)
 *   weak     one shared word: enough for a search the agent asked for, never for a note it didn't
 *   none     nothing in common
 *
 * Words match in any of their forms ("logging" meets "logs", "stored" meets "store"), never as a
 * shorter word they don't come from ("theme" never meets "them").
 */

/**
 * The forms a word may have without its ending, itself included: "dates" → date; "retried" → retry; "stored" → stor,
 * store; "storage" → stor, store; "logging" → log; "boxes" → box; "sizes" → size; "caches" → cache.
 */
export function variants(w: string): string[] {
  const out = new Set([w]);
  const add = (s: string) => { if (s.length >= 3) out.add(s); };
  if (w.endsWith("ies")) add(`${w.slice(0, -3)}y`);
  else if (w.endsWith("ied")) add(`${w.slice(0, -3)}y`);
  // "-es" after s, x, z, ch or sh is either the ending ("boxes", "matches") or an "e" of the word's
  // own plus "s" ("sizes", "cases", "caches"): both forms, since spelling alone can't tell them apart.
  else if (/(?:s|x|z|ch|sh)es$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  else if (/[^s]s$/.test(w)) add(w.slice(0, -1));
  for (const base of [...out]) {
    const m = /^([a-z0-9_]{3,}?)(?:ing|ed|age)$/.exec(base);
    if (!m) continue;
    const root = m[1]!;
    add(root);
    add(`${root}e`);
    // logg(ing) → log, runn(ing) → run; a doubled l or s is the word's own (install, pass).
    if (/([b-df-hj-np-tv-z])\1$/.test(root) && !/(?:ll|ss)$/.test(root)) add(root.slice(0, -1));
  }
  return [...out];
}

/** Every form of every word in a list, for matching against. */
export const wordForms = (words: string[]): Set<string> => new Set(words.flatMap(variants));

/**
 * Every word any path's tokenizer could take from a text, stop words included, in every form: what
 * the local index stores (sqlite.ts), so a lookup there finds whatever a scan would. Covers the
 * search words (letters, digits, underscores) and recall's terms (also camelCase and snake_case parts).
 */
export function indexForms(text: string): string[] {
  const words = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}|\b[A-Za-z]\d\b/g)) {
    words.add(m[0].toLowerCase());
    for (const p of m[0].split(/_|(?<=[a-z0-9])(?=[A-Z])/)) if (p.length >= 3) words.add(p.toLowerCase());
  }
  return [...wordForms([...words])];
}

/** The words of a list, each counted once in whatever form: "user" and "users" are one word. */
export function distinctWords(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const vs = variants(w);
    if (vs.some((v) => seen.has(v))) continue;
    for (const v of vs) seen.add(v);
    out.push(w);
  }
  return out;
}

/** How many of `words` (distinct, in any form) match a word in `forms` (wordForms of the other text). */
export const sharedWords = (words: string[], forms: Set<string>): number => distinctWords(words).filter((w) => variants(w).some((v) => forms.has(v))).length;

/** File paths a text names: `src/money.js`, `packages/api/src/index.ts`, or a bare `money.js`. */
export function pathsIn(text: string): string[] {
  return [...new Set((text.match(/(?:[\w.-]+\/)*[\w-]+\.[A-Za-z][\w]{0,5}\b/g) ?? []).map((p) => p.toLowerCase().replace(/^\.\//, "")).filter((p) => /[a-z]/.test(p.split(".").pop()!)))];
}

/**
 * Whether a question names this file. A path with a folder names only that file, or one whose path
 * ends with it (`cache/users.ts` is not `routes/users.ts`); a bare file name names any file so
 * called, when the name is long enough to mean something (`index.ts`, not `a.js`).
 */
export function namesFile(paths: string[], file: string): boolean {
  const f = file.replace(/\\/g, "/").toLowerCase();
  const base = f.split("/").pop()!;
  return paths.some((p) => (p.includes("/") ? f === p || f.endsWith(`/${p}`) : p === base && p.length >= 6));
}

/**
 * Code names a text mentions: `toCents`, `get_item`, `anyhow::Context`, `parse()`. Not capitalized
 * words with an inner capital ("TypeScript", "GitHub"): in prose those are mostly product names.
 */
export function identsIn(text: string): string[] {
  return [...new Set(text.match(/\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+|\b[a-z]+[A-Z]\w*|\b[a-z]+_[a-z_\d]+\b|\b\w+(?=\(\))/g) ?? [])].filter((t) => t.length >= 4);
}

/** A question, as the paths read it. `words`: its words, by the path's own tokenizer and stop words. */
export interface Query { words: string[]; paths: string[]; idents: string[] }

export function parseQuery(text: string, words: string[]): Query {
  return { words: distinctWords(words), paths: pathsIn(text), idents: identsIn(text) };
}

/**
 * The optional local model's thresholds (cosine similarity, bge-small), set on 2026-10-26 from the
 * five Gate 3 sets already scored (bench/semantic-calibrate.mjs; main, unseen 1-4), never from a set
 * about to be scored. On those sets a fixed similarity could not tell a right one-word match from
 * a wrong one (right ones had a median of 0.61, wrong ones reached 0.76). What held: the one record
 * among those sharing a word that is closest in meaning, at 0.70 or more and 0.10 ahead of the next
 * (8 right, 0 wrong; 0.10 to 0.15 gave the same). With no shared word, no wrong record reached 0.67.
 */
export const MEANING_WITH_WORD = 0.7;
export const MEANING_MARGIN = 0.1;
export const MEANING_ALONE = 0.67;

/**
 * Among records that share a word with the question but are not strong on words, the one clearly
 * closest in meaning, or none. `pool`: every such record of one path for one question.
 */
export function closestInMeaning<T>(pool: { item: T; meaning?: number }[]): T | undefined {
  const ranked = pool.filter((p) => p.meaning !== undefined).sort((a, b) => b.meaning! - a.meaning!);
  const [top, next] = ranked;
  if (!top || top.meaning! < MEANING_WITH_WORD || top.meaning! - (next?.meaning ?? 0) < MEANING_MARGIN) return undefined;
  return top.item;
}

/** The longest question in which naming a record's own folder, file or program is evidence (see Evidence). */
export const TOPIC_WORDS = 2;

/** Folder and file names that say where code lives, not what it is about. */
const STRUCTURAL = new Set("src lib libs app apps api test tests spec specs docs doc utils util helpers internal pkg cmd bin scripts script public static assets dist build out server client web config configs packages crates core common shared components pages types index main mod init readme vendor node_modules target tmp".split(" "));

/** Folder and file paths a text writes out: `src/billing`, `migrations/`, `app/media.py`. */
const PATHS_WRITTEN = /(?:[\w.-]+[\\/])+[\w.-]*/g;

/**
 * The topic words a record's own names give, in every form: each folder and file name in its paths
 * without the extension (`src/waitlist/waitlist.ts` → waitlist; `migrations/` → migrations), and
 * the programs its commands ran (`ngrok`). Naming one of these is naming what the record is about,
 * as a full path is. Structural names (src, lib, tests, index) say where code lives, not what it is
 * about, and are left out.
 */
export function nameForms(files: string[], text = "", programs: string[] = []): Set<string> {
  const parts = [...files, ...(text.match(PATHS_WRITTEN) ?? [])].flatMap((p) => p.toLowerCase().split(/[\\/]/)).map((s) => s.replace(/\.[a-z0-9]{1,6}$/, ""));
  const words = [...parts, ...programs.map((p) => p.toLowerCase())].flatMap((s) => s.split(/[-_.]/)).filter((w) => /^[a-z][a-z0-9]{2,}$|^[a-z]\d$/.test(w) && !STRUCTURAL.has(w));
  return wordForms(words);
}

/**
 * Whether a question names one of a record's own topic words (`nameForms`), in any form. A word
 * that is part of a path the question writes out, in any form, doesn't count: that path is matched
 * whole, folder and all (namesFile), so "the user lookup in cache/users.ts" never meets a record
 * about `routes/users.ts` through "user".
 */
export function namesTopic(words: string[], names: Set<string>, questionPaths: string[] = []): boolean {
  const inPaths = wordForms(questionPaths.flatMap((p) => p.split(/[\\/._-]/)).filter((s) => s.length >= 2));
  return words.some((w) => !STRUCTURAL.has(w) && !variants(w).some((v) => inPaths.has(v)) && variants(w).some((v) => names.has(v)));
}

/**
 * Whether two of the question's words, next to each other in it, are next to each other in the
 * text too, in any form: "lane booking" in "Add lane booking", not in "booking skips closed lanes".
 * At equal evidence, the record that says the question's phrase ranks first.
 */
export function adjacent(words: string[], text: string): boolean {
  if (words.length < 2) return false;
  const same = (a: string, b: string) => { const vb = variants(b); return variants(a).some((v) => vb.includes(v)); };
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    for (let j = 0; j + 1 < words.length; j++) if (same(words[j]!, tokens[i]!) && same(words[j + 1]!, tokens[i + 1]!)) return true;
  }
  return false;
}

/** Strong on words alone: a named file, a code name, a record's own topic name, or enough shared words. Path rules and meaning aside. */
export const strongOnWords = (q: Query, e: Evidence): boolean => e.path || e.ident || e.named || e.words >= Math.min(2, Math.max(1, q.words.length));

/**
 * `named`: a question of one or two words names one of the record's own folders, files or programs
 * by its word ("waitlist", "ngrok"). In a longer prompt such a word is as often plain English ("Order
 * the sidebar links" against orders.ts), so there it isn't evidence. `meaning`: cosine similarity
 * from the optional local model, when it ran.
 */
export interface Evidence { words: number; path: boolean; ident: boolean; named: boolean; meaning?: number }

/**
 * What a record has in common with a question: shared words (any form), a named file, a code name,
 * one of its own topic names, and its meaning. `names`: the record's topic names when the caller
 * knows more than its files and text say (the programs a session ran).
 */
export function evidence(q: Query, record: { forms: Set<string>; text: string; files: string[]; names?: Set<string>; meaning?: number }): Evidence {
  return {
    words: sharedWords(q.words, record.forms),
    path: record.files.some((f) => namesFile(q.paths, f)),
    ident: q.idents.some((i) => record.text.includes(i)),
    named: q.words.length <= TOPIC_WORDS && namesTopic(q.words, record.names ?? nameForms(record.files, record.text), q.paths),
    ...(record.meaning !== undefined ? { meaning: record.meaning } : {}),
  };
}

export type Confidence = "strong" | "weak" | "none";

/**
 * `extra`: matches a path's own rules add (a note about tests, for a task about tests). They add to
 * shared words, up to two; on their own they are not evidence ("How do I run the test suite?" is
 * not answered by a note that mentions tests in passing).
 */
export function confidence(q: Query, e: Evidence, extra = 0): Confidence {
  if (e.path || e.ident || e.named || e.words >= Math.min(2, Math.max(1, q.words.length)) || (e.words > 0 && e.words + extra >= 2)) return "strong";
  if (e.meaning !== undefined && e.words === 0 && e.meaning >= MEANING_ALONE) return "strong";
  return e.words + extra > 0 ? "weak" : "none";
}
