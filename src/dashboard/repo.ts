/**
 * The repo map on `snout dashboard`: the project's folders as entities, each with its largest
 * files, what reading them costs an agent, what Snout did when one was read, and which folders
 * share names (a folder that uses a name another folder declares). Built on the user's machine
 * from the file list, the ledger and the repo map; nothing here leaves it.
 *
 * Pure: the server passes the file list, the ledger's per-file totals, a classifier and the map,
 * so a test can pin the grouping without a real project.
 */
import type { RepoMap } from "../map/map.js";
import { estimateTokens } from "../ledger/tokens.js";

export interface FileStat {
  path: string;
  /** Estimated tokens to read the whole file. */
  tokens: number;
  /** What Snout calls it: the ledger's label when it was read, else the rules' label, else "source". */
  label: string;
  /** For a file Snout would trim: about what a trimmed read sends (its head, at most 6 KB). Else the whole file. */
  sendTokens: number;
  reads: number;
  inContext: number;
  heldBack: number;
  last: string | null;
}

export interface RepoGroup {
  key: string;
  files: number;
  tokens: number;
  /** Tokens in files Snout would trim: not source, not files it always reads whole or asks about. */
  bulk: number;
  reads: number;
  inContext: number;
  heldBack: number;
  /** The folder's heaviest files, bloat first: the cards show the first few, the report all of them. */
  top: FileStat[];
  /** Tokens per label in the folder, largest first. */
  kinds: { label: string; files: number; tokens: number; heldBack: number }[];
}

export interface RepoLink {
  a: string;
  b: string;
  /** Distinct names one folder declares and the other uses. */
  names: number;
  sample: string[];
}

export interface RepoView {
  files: number;
  tokens: number;
  bulk: number;
  groups: RepoGroup[];
  /** Folders past the ones shown. */
  more: number;
  links: RepoLink[];
  mapBuiltAt: string | null;
}

export interface ReadStat {
  reads: number;
  inContext: number;
  heldBack: number;
  label: string;
  last: string;
}

const GROUPS = 8;
const TOP = 8;
const KINDS = 6;
/** The head a trimmed read sends is at most this many bytes (the gate's HEAD_BYTES). */
const HEAD_BYTES = 6 * 1024;
/** Labels Snout reads whole (or asks about first): never bulk, never trimmed to a head. */
const WHOLE = new Set(["source", "always-allow", "secret", "reversal"]);
export const isBulk = (label: string): boolean => !WHOLE.has(label);
/** A top folder holding more than this share of the repo is split one level down (src → src/gate, src/cli). */
const SPLIT_SHARE = 0.35;
/** A name declared in more folders than this is too common to say two folders are related. */
const MAX_DECLARERS = 4;
const LINKS = 14;

const first = (p: string): string => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "/");
const second = (p: string): string => {
  const parts = p.split("/");
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
};

export function buildRepoView(
  listing: { path: string; size: number }[],
  read: Map<string, ReadStat>,
  labelOf: (path: string, size: number) => string,
  map?: RepoMap | null,
): RepoView {
  const files: FileStat[] = listing.map(({ path, size }) => {
    const r = read.get(path);
    const label = r && r.label !== "source" ? r.label : labelOf(path, size);
    return {
      path,
      tokens: estimateTokens(size, path),
      label,
      sendTokens: estimateTokens(isBulk(label) ? Math.min(size, HEAD_BYTES) : size, path),
      reads: r?.reads ?? 0,
      inContext: r?.inContext ?? 0,
      heldBack: r?.heldBack ?? 0,
      last: r?.last ?? null,
    };
  });
  const total = files.reduce((a, f) => a + f.tokens, 0);

  // Group by top folder, splitting any folder that holds most of the repo by its subfolders.
  const byTop = new Map<string, number>();
  for (const f of files) byTop.set(first(f.path), (byTop.get(first(f.path)) ?? 0) + f.tokens);
  const split = new Set([...byTop].filter(([k, t]) => k !== "/" && total > 0 && t / total > SPLIT_SHARE).map(([k]) => k));
  const groupOf = (p: string): string => (split.has(first(p)) ? second(p) : first(p));

  const groups = new Map<string, RepoGroup & { all: FileStat[] }>();
  for (const f of files) {
    const k = groupOf(f.path);
    const g = groups.get(k) ?? { key: k, files: 0, tokens: 0, bulk: 0, reads: 0, inContext: 0, heldBack: 0, top: [], kinds: [], all: [] };
    g.files += 1;
    g.tokens += f.tokens;
    if (isBulk(f.label)) g.bulk += f.tokens;
    g.reads += f.reads;
    g.inContext += f.inContext;
    g.heldBack += f.heldBack;
    g.all.push(f);
    groups.set(k, g);
  }
  // Bloat first: what Snout kept out, then files it would trim, then the plain largest.
  const weight = (f: FileStat) => f.heldBack * 4 + (isBulk(f.label) ? f.tokens * 2 : f.tokens);
  const ranked = [...groups.values()].sort((a, b) => b.heldBack + b.bulk - (a.heldBack + a.bulk) || b.tokens - a.tokens);
  const shown = ranked.slice(0, GROUPS).map(({ all, ...g }) => {
    const kinds = new Map<string, RepoGroup["kinds"][number]>();
    for (const f of all) {
      const k = kinds.get(f.label) ?? { label: f.label, files: 0, tokens: 0, heldBack: 0 };
      k.files += 1;
      k.tokens += f.tokens;
      k.heldBack += f.heldBack;
      kinds.set(f.label, k);
    }
    return { ...g, top: all.sort((a, b) => weight(b) - weight(a)).slice(0, TOP), kinds: [...kinds.values()].sort((a, b) => b.tokens - a.tokens).slice(0, KINDS) };
  });

  return {
    files: files.length,
    tokens: total,
    bulk: files.reduce((a, f) => a + (isBulk(f.label) ? f.tokens : 0), 0),
    groups: shown,
    more: Math.max(0, ranked.length - shown.length),
    links: map ? linksOf(map, groupOf, new Set(shown.map((g) => g.key))) : [],
    mapBuiltAt: map?.builtAt ?? null,
  };
}

/** Folder pairs where one uses names the other declares, strongest first. */
function linksOf(map: RepoMap, groupOf: (p: string) => string, keep: Set<string>): RepoLink[] {
  const declared = new Map<string, Set<string>>();
  for (const [path, e] of Object.entries(map.files)) {
    const g = groupOf(path);
    if (!keep.has(g)) continue;
    for (const d of e.defs) {
      const s = declared.get(d) ?? new Set<string>();
      s.add(g);
      declared.set(d, s);
    }
  }
  const pairs = new Map<string, Set<string>>();
  for (const [path, e] of Object.entries(map.files)) {
    const g = groupOf(path);
    if (!keep.has(g)) continue;
    for (const w of e.words) {
      const by = declared.get(w);
      if (!by || by.size > MAX_DECLARERS || by.has(g)) continue;
      for (const d of by) {
        const key = g < d ? `${g}\0${d}` : `${d}\0${g}`;
        const s = pairs.get(key) ?? new Set<string>();
        s.add(w);
        pairs.set(key, s);
      }
    }
  }
  return [...pairs]
    .map(([key, names]) => {
      const [a, b] = key.split("\0") as [string, string];
      // The longest names say the most about the relationship; short ones are often common words.
      return { a, b, names: names.size, sample: [...names].sort((x, y) => y.length - x.length).slice(0, 3) };
    })
    .sort((x, y) => y.names - x.names)
    .slice(0, LINKS);
}
