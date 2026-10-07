/**
 * Agent-context audit: the instruction files, skills, commands, agents and AI-written docs a
 * project carries, what each costs per session, whether any agent still uses it, who wrote
 * it, and which ones are dead weight.
 *
 * Three kinds of cost:
 *   always     loaded into every session in full (CLAUDE.md, AGENTS.md, rules files, the
 *              memory index). Every token here is paid on every request of every session.
 *   described  only the name and description are loaded until the agent invokes it (skills,
 *              slash commands, subagents). A dead one still costs its description each time.
 *   on-demand  costs nothing until something reads it (plans, reports, notes, other docs).
 *
 * Usage comes from the agents' own session history (Claude Code transcripts, Codex rollouts)
 * and Snout's ledger, so it works whether or not Snout was running. Authorship comes from git
 * trailers and from the files agents wrote in those sessions.
 *
 * Nothing is ever deleted. `archiveFiles` moves files under .snout/archive/<ts>/ with a
 * manifest, and `restoreArchive` puts them back. Contradictions between instructions are not
 * decided here: candidate pairs are listed for a model to judge, using the compact map.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { estimateTokens, fmtTokens } from "../ledger/tokens.js";

export type Kind = "always" | "described" | "on-demand";
export type Author = "ai" | "human" | "mixed" | "unknown";
export type FlagCode = "unused" | "duplicate" | "near-duplicate" | "contained" | "stale" | "oversized" | "one-off";

export type Action = "archive" | "merge" | "fix" | "trim" | "review";

export interface Flag {
  code: FlagCode;
  reason: string;
  /** What to do about it. Only "archive" suggests moving the file out of the repo. */
  action: Action;
}

/**
 * The suggested action per flag. Nothing is suggested for archiving outright: on 120 labeled files from
 * public AI-heavy repos, about half of the flagged one-offs and duplicates still held something useful
 * (rationale, pending work, examples). Archiving is a choice made after reading the file, or the map.
 */
const ACTION: Record<FlagCode, Action> = { "one-off": "review", duplicate: "review", "near-duplicate": "merge", contained: "merge", stale: "fix", oversized: "trim", unused: "review" };

export interface ContextFile {
  /** Relative to the project for project files; `~/...` for user-level ones. */
  path: string;
  abs: string;
  scope: "project" | "user";
  kind: Kind;
  /** What it is: "instructions", "rules", "memory", "skill", "command", "agent", "doc". */
  role: string;
  /** Which agents load it. */
  agents: string[];
  bytes: number;
  tokens: number;
  /** Tokens it adds to every session: the whole file if always loaded, the description if described. */
  perSession: number;
  /** Invocations or reads found in the window. Null where usage can't be observed (always-loaded files). */
  uses: number | null;
  lastUsed: string | null;
  author: Author;
  /** First seen: the first commit that added it, else its modification time. */
  created: string;
  flags: Flag[];
  /** Tokens per session that acting on the flags would save. */
  savePerSession: number;
  /** Set when this file is a symlink to another file in the audit: one file, two names. */
  linkTo?: string;
}

export interface ContextAudit {
  projectDir: string;
  days: number;
  files: ContextFile[];
  /** Pairs of instruction files that cover the same ground; a model should check them for conflicts. */
  conflictCandidates: { a: string; b: string; overlap: number }[];
  sources: string[];
}

export interface AuditOptions {
  days?: number;
  home?: string;
  /** Snout ledger rows (path relative to the project, ts). */
  ledger?: { path: string; ts: string }[];
  /** Always-loaded files above this many tokens are flagged as oversized. */
  oversizedTokens?: number;
  /** Skip reading git history (tests, or repos where it is too slow). */
  noGit?: boolean;
  /** No session history to read (a cloned corpus): usage is unknown, so nothing is called unused. */
  noUsage?: boolean;
}

export const OVERSIZED_TOKENS = 2000;
const DAY = 86_400_000;
const MD = /\.(md|mdc|markdown)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next", ".snout", "coverage", ".venv", "venv", "__pycache__"]);
/** Folders whose markdown is fixtures, vendored or sample material, not context an agent is meant to read. */
const NOT_CONTEXT_DIR = /^(tests?|__tests__|testdata|test-data|fixtures?|golden|snapshots?|__snapshots__|vendor.*|third[_-]?party|external|deps|pods|examples?|samples?|node_modules|bower_components)$/i;
/** Agent folders, and which agent each one serves. */
const AGENT_DIR: Record<string, string> = { ".claude": "claude", ".agents": "codex", ".codex": "codex", ".cursor": "cursor", ".gemini": "gemini", ".windsurf": "windsurf", ".clinerules": "cline", ".github": "copilot" };
const HUMAN_DOCS = /^(readme|license|licence|changelog|changes|history|contributing|code_of_conduct|security|support|governance|maintainers|authors|notice|copying)(\.|$)/i;
/** Where one-off artifacts live: dated plans, archived changes, reports, saved agent sessions. */
const ONE_OFF_DIR = /(^|\/)(archive[sd]?|reports?|plans?|tasks?|sessions?|handoffs?|scratch|\.sdd|\.conversations|\.specstory|history|progress|retros?|postmortems?)\//i;
const DATED = /(^|[^0-9])20\d\d[-_]?[01]\d[-_]?[0-3]\d/;
/** Living documents that only look like reports: decisions, skills, playbooks, specs agents follow. */
const LIVING_DIR = /(^|\/)(adrs?|decisions?|rfcs?|skills?|playbooks?|runbooks?|specs?|guides?)\//i;
/** One-off documents agents tend to write and leave behind. */
const REPORT_NAME = /(^|[_\-. ])(plan|plans|summary|summaries|notes?|todo|report|implementation|analysis|findings|progress|status|handoff|scratch|draft|session|investigation|fix|fixes|migration|review|refactor|proposal)([_\-. ]|$)/i;
const AI_TRAILER = /co-authored-by:[^\n]*(claude|anthropic|copilot|cursor|gemini|codex|openai|devin|aider|windsurf|codeium|cline|jules|amp)/i;
const AI_AUTHOR = /\[bot\]|claude|copilot|devin|codex|cursor-agent|gemini-code|jules|aider/i;

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

interface Found {
  abs: string;
  scope: ContextFile["scope"];
  kind: Kind;
  role: string;
  agents: string[];
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 12) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1);
    } else if (e.isFile()) out.push(p);
    else if (e.isSymbolicLink()) { try { if (statSync(p).isFile()) out.push(p); } catch { /* dangling */ } }
  }
}

/** Project files: git's view (tracked and untracked, not ignored) plus the agent folders, which are often ignored. */
function projectFiles(projectDir: string): string[] {
  const set = new Set<string>();
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: projectDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    for (const f of out.split("\0")) if (f && !f.split("/").some((s) => SKIP_DIRS.has(s))) set.add(join(projectDir, f));
  } catch {
    const all: string[] = [];
    walk(projectDir, all);
    for (const f of all) set.add(f);
  }
  for (const d of [".claude", ".cursor", ".windsurf", ".clinerules", ".github", ".gemini", ".codex"]) {
    const p = join(projectDir, d);
    if (existsSync(p) && statSync(p).isDirectory()) {
      const all: string[] = [];
      walk(p, all);
      for (const f of all) set.add(f);
    }
  }
  for (const f of [".cursorrules", ".windsurfrules", ".clinerules"]) {
    const p = join(projectDir, f);
    if (existsSync(p) && statSync(p).isFile()) set.add(p);
  }
  return [...set];
}

const frontmatter = (text: string): Record<string, string> => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    // YAML block scalars (`>`, `|`, `>-`...): the value is the indented lines that follow.
    if (/^[>|][-+]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      v = block.join(" ");
    }
    out[kv[1]!.toLowerCase()] = v.replace(/^["']|["']$/g, "").trim();
  }
  return out;
};

/** What a project file is to an agent, or null when it is not agent context at all. */
export function classifyContextPath(rel: string): Omit<Found, "abs" | "scope"> | null {
  const p = rel.split(sep).join("/");
  const name = basename(p);
  const lower = p.toLowerCase();
  if (/(^|\/)claude(\.local)?\.md$/i.test(p)) return { kind: "always", role: "instructions", agents: ["claude"] };
  if (/(^|\/)agents\.md$/i.test(p)) return { kind: "always", role: "instructions", agents: ["codex", "cursor", "copilot", "gemini", "any"] };
  if (/(^|\/)gemini\.md$/i.test(p)) return { kind: "always", role: "instructions", agents: ["gemini"] };
  if (lower === ".cursorrules") return { kind: "always", role: "rules", agents: ["cursor"] };
  if (lower.startsWith(".cursor/rules/") && /\.(mdc|md)$/.test(lower)) return { kind: "always", role: "rules", agents: ["cursor"] };
  if (lower === ".github/copilot-instructions.md") return { kind: "always", role: "instructions", agents: ["copilot"] };
  if (lower.startsWith(".github/instructions/") && MD.test(lower)) return { kind: "described", role: "rules", agents: ["copilot"] };
  if (lower === ".windsurfrules" || (lower.startsWith(".windsurf/rules/") && MD.test(lower))) return { kind: "always", role: "rules", agents: ["windsurf"] };
  if (lower === ".clinerules" || (lower.startsWith(".clinerules/") && MD.test(lower))) return { kind: "always", role: "rules", agents: ["cline"] };
  if (/^\.claude\/skills\/[^/]+\/skill\.md$/i.test(p)) return { kind: "described", role: "skill", agents: ["claude"] };
  if (/^\.claude\/commands\/.+\.md$/i.test(p)) return { kind: "described", role: "command", agents: ["claude"] };
  if (/^\.claude\/agents\/.+\.md$/i.test(p)) return { kind: "described", role: "agent", agents: ["claude"] };
  if (/^\.(agents|codex)\/skills\/[^/]+\/skill\.md$/i.test(p)) return { kind: "described", role: "skill", agents: ["codex"] };
  if (/^\.(claude|agents|codex)\/skills\//i.test(p) && MD.test(lower)) return { kind: "on-demand", role: "skill file", agents: [AGENT_DIR[p.split("/")[0]!.toLowerCase()] ?? "any"] };
  if (!MD.test(name)) return null;
  if (lower.startsWith(".github/") && !lower.startsWith(".github/instructions/")) return null; // issue and PR templates
  const dirs = p.split("/").slice(0, -1);
  if (dirs.some((d) => NOT_CONTEXT_DIR.test(d))) return null;
  const agent = AGENT_DIR[dirs[0]?.toLowerCase() ?? ""];
  return { kind: "on-demand", role: "doc", agents: [agent ?? "any"] };
}

function userFiles(projectDir: string, home: string): Found[] {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const out: Found[] = [];
  const add = (abs: string, f: Omit<Found, "abs" | "scope">) => { if (existsSync(abs)) out.push({ abs, scope: "user", ...f }); };
  add(join(claudeDir, "CLAUDE.md"), { kind: "always", role: "instructions", agents: ["claude"] });
  add(join(claudeDir, "projects", resolve(projectDir).replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md"), { kind: "always", role: "memory", agents: ["claude"] });
  add(join(process.env.CODEX_HOME || join(home, ".codex"), "AGENTS.md"), { kind: "always", role: "instructions", agents: ["codex"] });
  add(join(home, ".gemini", "GEMINI.md"), { kind: "always", role: "instructions", agents: ["gemini"] });
  const list = (dir: string, re: RegExp, role: string) => {
    if (!existsSync(dir)) return;
    const all: string[] = [];
    walk(dir, all, 9);
    for (const f of all) if (re.test(relative(dir, f).split(sep).join("/"))) out.push({ abs: f, scope: "user", kind: "described", role, agents: ["claude"] });
  };
  list(join(claudeDir, "skills"), /^[^/]+\/SKILL\.md$/i, "skill");
  list(join(claudeDir, "commands"), /\.md$/i, "command");
  list(join(claudeDir, "agents"), /\.md$/i, "agent");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Usage: what the agents actually invoked or read
// ---------------------------------------------------------------------------------------------

export interface Usage {
  /** Absolute path → [count, last ISO time]. */
  reads: Map<string, [number, string]>;
  skills: Map<string, [number, string]>;
  commands: Map<string, [number, string]>;
  agents: Map<string, [number, string]>;
  /** Absolute paths an agent wrote or edited. */
  writes: Set<string>;
  /** Codex rollouts for this project, as [text, time]; file paths are matched in them as text. */
  codex: [string, string][];
  sources: string[];
}

const bump = (m: Map<string, [number, string]>, key: string, ts: string) => {
  const cur = m.get(key);
  m.set(key, cur ? [cur[0] + 1, ts > cur[1] ? ts : cur[1]] : [1, ts]);
};

/** Tool calls in one Claude Code transcript (JSON lines), folded into `u`. Exported for tests. */
export function readClaudeTranscript(text: string, u: Usage, since: string, fallbackTs: string): void {
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes("<command-name>")) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts: string = typeof obj.timestamp === "string" ? obj.timestamp : fallbackTs;
    const content = obj.message?.content;
    if (typeof content === "string" || (Array.isArray(content) && content.some((c: any) => typeof c?.text === "string"))) {
      const text = typeof content === "string" ? content : content.map((c: any) => c?.text ?? "").join("\n");
      const re = /<command-name>\/?([^<\s]+)<\/command-name>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) if (ts >= since) bump(u.commands, m[1]!.toLowerCase(), ts);
    }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== "tool_use" || typeof c.name !== "string") continue;
      const input = c.input ?? {};
      const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name) && file) u.writes.add(resolve(file));
      if (ts < since) continue;
      if (c.name === "Read" && file) bump(u.reads, resolve(file), ts);
      else if (c.name === "Skill" && typeof input.skill === "string") bump(u.skills, input.skill.toLowerCase().split(":").pop()!, ts);
      else if ((c.name === "Agent" || c.name === "Task") && typeof input.subagent_type === "string") bump(u.agents, input.subagent_type.toLowerCase().split(":").pop()!, ts);
      else if (c.name === "SlashCommand" && typeof input.command === "string") bump(u.commands, input.command.replace(/^\//, "").split(/\s/)[0]!.toLowerCase(), ts);
    }
  }
}

function collectUsage(projectDir: string, days: number, home: string, ledger: AuditOptions["ledger"]): Usage {
  const u: Usage = { reads: new Map(), skills: new Map(), commands: new Map(), agents: new Map(), writes: new Set(), codex: [], sources: [] };
  const since = new Date(Date.now() - days * DAY).toISOString();
  const dir = resolve(projectDir);
  // Claude Code: every session in this project. Writes are kept for authorship whatever their age.
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
  if (existsSync(root)) {
    let n = 0;
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const path = join(root, f);
        readClaudeTranscript(readFileSync(path, "utf8"), u, since, statSync(path).mtime.toISOString());
        n++;
      } catch {
        // an unreadable transcript just isn't counted
      }
    }
    if (n) u.sources.push(`${n} Claude Code session${n === 1 ? "" : "s"}`);
  }
  // Codex: rollouts whose working directory is this project. Paths are matched as text.
  const codexRoot = join(process.env.CODEX_HOME || join(home, ".codex"), "sessions");
  if (existsSync(codexRoot)) {
    const files: string[] = [];
    walk(codexRoot, files, 8);
    let n = 0;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = statSync(f);
        if (st.mtimeMs < Date.now() - days * DAY) continue;
        const text = readFileSync(f, "utf8");
        if (!text.includes(`"cwd":"${dir}`) && !text.includes(`"cwd": "${dir}`)) continue;
        n++;
        const ts = st.mtime.toISOString();
        const patch = /\*\*\* (?:Add|Update) File: ([^\\\n"]+)/g;
        let m: RegExpExecArray | null;
        while ((m = patch.exec(text))) u.writes.add(resolve(dir, m[1]!.trim()));
        u.codex.push([text, ts]);
      } catch {
        // skip
      }
    }
    if (n) u.sources.push(`${n} Codex session${n === 1 ? "" : "s"}`);
  }
  if (ledger?.length) {
    let n = 0;
    for (const r of ledger) if (r.ts >= since && r.path) { bump(u.reads, resolve(dir, r.path), r.ts); n++; }
    if (n) u.sources.push("Snout ledger");
  }
  return u;
}

// ---------------------------------------------------------------------------------------------
// Authorship from git
// ---------------------------------------------------------------------------------------------

interface GitInfo { ai: number; human: number; first: number }
interface GitHistory { files: Map<string, GitInfo>; ever: Set<string> | undefined }

/** Per-file AI and human commit counts and first-commit time, from one pass over recent history. */
function gitAuthorship(projectDir: string, maxCommits = 3000): GitHistory {
  const out = new Map<string, GitInfo>();
  let log = "";
  try {
    log = execFileSync("git", ["log", "--no-merges", `-n${maxCommits}`, "--name-only", "--format=%x1e%an%x1f%ae%x1f%at%x1f%B%x1d"], { cwd: projectDir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { files: out, ever: undefined };
  }
  for (const rec of log.split("\x1e")) {
    if (!rec.trim()) continue;
    const [head, files = ""] = rec.split("\x1d");
    const [an = "", ae = "", at = "0", body = ""] = (head ?? "").split("\x1f");
    const ai = AI_TRAILER.test(body) || AI_AUTHOR.test(an) || AI_AUTHOR.test(ae);
    const t = Number(at) * 1000;
    for (const f of files.split("\n")) {
      const rel = f.trim();
      if (!rel) continue;
      const g = out.get(rel) ?? { ai: 0, human: 0, first: t };
      if (ai) g.ai++; else g.human++;
      g.first = Math.min(g.first, t);
      out.set(rel, g);
    }
  }
  return { files: out, ever: out.size ? new Set(out.keys()) : undefined };
}

export function authorOf(git: GitInfo | undefined, agentWrote: boolean): Author {
  const ai = (git?.ai ?? 0) + (agentWrote ? 1 : 0);
  const human = git?.human ?? 0;
  if (!ai && !human) return "unknown";
  if (ai && human) return "mixed";
  return ai ? "ai" : "human";
}

// ---------------------------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------------------------

export const normalize = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function shingles(norm: string, k = 5): Set<string> {
  const w = norm.split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  if (!out.size && w.length) out.add(w.join(" "));
  return out;
}

export function overlap(a: Set<string>, b: Set<string>): { jaccard: number; containment: number } {
  if (!a.size || !b.size) return { jaccard: 0, containment: 0 };
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return { jaccard: inter / (a.size + b.size - inter), containment: inter / small.size };
}

const STOP = new Set("the a an and or of to in for on with is are be by it this that as at from use when if not you your do does can should must will any all each only into than then so no".split(" "));
function topTerms(norm: string, n = 40): Set<string> {
  const counts = new Map<string, number>();
  for (const w of norm.split(" ")) if (w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w));
}

// ---------------------------------------------------------------------------------------------
// Stale references
// ---------------------------------------------------------------------------------------------

/**
 * Paths and npm scripts a file mentions that no longer exist. With git history (`everExisted`), a
 * path counts only if the repository once had it: deleted or renamed since, so examples and
 * runtime files aren't reported. Without history, a path counts when its parent folder exists.
 */
export function staleRefs(text: string, fileAbs: string, projectDir: string, everExisted?: Set<string>, workspaceScripts?: Set<string>): string[] {
  const missing = new Set<string>();
  const cands = new Set<string>();
  const tick = /`([^`\n]{2,160})`/g;
  const link = /\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = tick.exec(text))) cands.add(m[1]!.trim());
  while ((m = link.exec(text))) cands.add(m[1]!.trim());
  for (let c of cands) {
    if (/^[a-z]+:\/\//i.test(c) || c.startsWith("mailto:") || /[\s*?{}<>$|=]/.test(c) || c.startsWith("-") || c.startsWith("~") || c.startsWith("@")) continue;
    c = c.replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "");
    if (!(c.includes("/") || /\.[a-z0-9]{1,6}$/i.test(c)) || isAbsolute(c) || /^\.+$/.test(c) || c.endsWith("/")) continue;
    if (/^\d+(\.\d+)+$/.test(c)) continue; // a version number
    const fromFile = resolve(dirname(fileAbs), c), fromRoot = resolve(projectDir, c);
    if (!fromFile.startsWith(projectDir) && !fromRoot.startsWith(projectDir)) continue;
    if (existsSync(fromFile) || existsSync(fromRoot)) continue;
    if (everExisted) {
      const rels = [relative(projectDir, fromFile), relative(projectDir, fromRoot)].map((r) => r.split(sep).join("/"));
      if (rels.some((r) => everExisted.has(r))) missing.add(c);
      continue;
    }
    const parentExists = (p: string) => { const d = dirname(p); return d !== projectDir && existsSync(d); };
    if (c.includes("/") ? parentExists(fromFile) || parentExists(fromRoot) : false) missing.add(c);
  }
  // npm/pnpm/yarn scripts that the applicable package.json no longer defines: the one beside the
  // file, or the root one for files at the root or in an agent folder. A README deep in a tree
  // usually means a script of a package somewhere else, so it isn't checked against the root.
  let scripts: Record<string, unknown> | null = null;
  const relDir = relative(projectDir, dirname(fileAbs)).split(sep);
  const pkgDir = existsSync(join(dirname(fileAbs), "package.json")) ? dirname(fileAbs) : relDir[0] === "" || /^\.(claude|cursor|github|windsurf|clinerules|gemini|codex)$/.test(relDir[0] ?? "") ? projectDir : null;
  if (pkgDir && existsSync(join(pkgDir, "package.json"))) { try { scripts = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).scripts ?? {}; } catch { scripts = null; } }
  if (scripts) {
    // Flags before the name (`npm run -w web dev`) are skipped; a script any workspace defines is not missing.
    const run = /\b(?:npm run|pnpm run|yarn run|bun run)((?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ][^\s`-][^\s`]*)?)*)\s+([A-Za-z0-9:_][A-Za-z0-9:_-]*)/g;
    while ((m = run.exec(text))) {
      if (m[1]) continue; // workspace-targeted: the script lives in another package
      if (!(m[2]! in scripts) && !workspaceScripts?.has(m[2]!)) missing.add(`npm run ${m[2]}`);
    }
  }
  return [...missing];
}

// ---------------------------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------------------------

export function auditContext(projectDir: string, opts: AuditOptions = {}): ContextAudit {
  const dir = resolve(projectDir);
  const home = opts.home ?? homedir();
  const days = opts.days ?? 30;
  const maxTok = opts.oversizedTokens ?? OVERSIZED_TOKENS;
  const found: Found[] = [];
  for (const abs of projectFiles(dir)) {
    const c = classifyContextPath(relative(dir, abs));
    if (c) found.push({ abs, scope: "project", ...c });
  }
  found.push(...userFiles(dir, home));

  // Every script any package.json in the repo defines (monorepo workspaces).
  const workspaceScripts = new Set<string>();
  for (const abs of projectFiles(dir)) {
    if (basename(abs) !== "package.json") continue;
    try { for (const k of Object.keys(JSON.parse(readFileSync(abs, "utf8")).scripts ?? {})) workspaceScripts.add(k); } catch { /* not JSON */ }
  }
  /** Paths git ignores are build output or runtime files: never stale. */
  const ignored = (paths: string[]): Set<string> => {
    if (!paths.length) return new Set();
    try {
      return new Set(execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: dir, input: paths.join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).split("\n").filter(Boolean));
    } catch (e) {
      return new Set(String((e as { stdout?: string }).stdout ?? "").split("\n").filter(Boolean)); // exit 1 = none ignored
    }
  };
  const usage: Usage = opts.noUsage
    ? { reads: new Map(), skills: new Map(), commands: new Map(), agents: new Map(), writes: new Set(), codex: [], sources: [] }
    : collectUsage(dir, days, home, opts.ledger);
  const history: GitHistory = opts.noGit ? { files: new Map(), ever: undefined } : gitAuthorship(dir);
  const git = history.files;
  const now = Date.now();

  const files: ContextFile[] = [];
  const texts = new Map<string, string>();
  for (const f of found) {
    let text = "";
    let st: import("node:fs").Stats;
    try {
      st = statSync(f.abs);
      if (st.size > 2 * 1024 * 1024) continue;
      text = readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    const rel = f.scope === "project" ? relative(dir, f.abs).split(sep).join("/") : "~/" + relative(home, f.abs).split(sep).join("/");
    const tokens = estimateTokens(st.size, f.abs);
    const fm = frontmatter(text);
    let kind = f.kind;
    // Cursor rules apply to every request only when marked alwaysApply; otherwise they're picked by description or glob.
    if (f.role === "rules" && extname(f.abs) === ".mdc" && fm.alwaysapply !== "true") kind = "described";
    const desc = (fm.name ?? "") + " " + (fm.description ?? text.replace(/^---[\s\S]*?---/, "").trim().split("\n")[0] ?? "");
    const perSession = kind === "always" ? tokens : kind === "described" ? estimateTokens(Buffer.byteLength(desc), "x.md") : 0;

    // Usage: invocations for skills, commands and agents; reads for everything else.
    let use: [number, string] | undefined;
    const id = (fm.name || (f.role === "skill" ? basename(dirname(f.abs)) : basename(f.abs).replace(MD, ""))).toLowerCase();
    if (f.role === "skill") use = usage.skills.get(id) ?? usage.skills.get(basename(dirname(f.abs)).toLowerCase());
    else if (f.role === "command") use = usage.commands.get(relative(join(dirname(f.abs).split(`${sep}commands`)[0]!, "commands"), f.abs).replace(MD, "").split(sep).join(":").toLowerCase()) ?? usage.commands.get(id);
    else if (f.role === "agent") use = usage.agents.get(id);
    const read = usage.reads.get(f.abs);
    if (read) use = use ? [use[0] + read[0], read[1] > use[1] ? read[1] : use[1]] : read;
    if (f.scope === "project" && usage.codex.length) {
      for (const [t, ts] of usage.codex) if (t.includes(rel)) use = use ? [use[0] + 1, ts > use[1] ? ts : use[1]] : [1, ts];
    }

    const g = f.scope === "project" ? git.get(rel) : undefined;
    const created = new Date(g?.first ?? st.mtimeMs).toISOString();
    files.push({
      path: rel, abs: f.abs, scope: f.scope, kind, role: f.role, agents: f.agents, bytes: st.size, tokens, perSession,
      uses: kind === "always" || opts.noUsage ? null : use?.[0] ?? 0, lastUsed: use?.[1] ?? null,
      author: authorOf(g, usage.writes.has(f.abs)), created, flags: [], savePerSession: 0,
    });
    texts.set(f.abs, text);
  }
  // A symlink to another audited file is the same file under a second name.
  const byReal = new Map<string, ContextFile>();
  for (const f of files) { try { if (!lstatSync(f.abs).isSymbolicLink()) byReal.set(realpathSync(f.abs), f); } catch { /* gone */ } }
  for (const f of files) {
    try { if (lstatSync(f.abs).isSymbolicLink()) { const t = byReal.get(realpathSync(f.abs)); if (t) f.linkTo = t.path; } } catch { /* gone */ }
  }

  // --- flags ---------------------------------------------------------------------------------
  const flag = (f: ContextFile, code: FlagCode, reason: string, save = 0, action: Action = ACTION[code]) => { f.flags.push({ code, reason, action }); f.savePerSession = Math.max(f.savePerSession, save); };
  const old = (f: ContextFile) => now - Date.parse(f.created) > days * DAY;

  for (const f of files) {
    const name = basename(f.path);
    if (f.kind === "always" && f.tokens > maxTok && !f.linkTo)
      flag(f, "oversized", `loaded into every session at ~${fmtTokens(f.tokens)} tokens; over ${fmtTokens(maxTok)}, move detail into skills or docs read on demand`, f.tokens - maxTok);
    if (f.kind === "described" && old(f) && f.uses === 0)
      flag(f, "unused", `not invoked in ${days} days; its description still costs ~${fmtTokens(f.perSession)} tokens every session`, f.perSession);
    // A one-off needs a report-like name AND a sign it was a one-time artifact: a date, or a reports/plans/archive folder,
    // or an all-caps root-level report (IMPLEMENTATION_SUMMARY.md). Living docs (ADRs, skills, specs) never qualify.
    const stem = name.replace(MD, "");
    const oneTime = DATED.test(f.path) || ONE_OFF_DIR.test(f.path) || (!f.path.includes("/") && /^[A-Z0-9_-]+$/.test(stem));
    const report = f.kind === "on-demand" && f.role === "doc" && !HUMAN_DOCS.test(name) && !LIVING_DIR.test(f.path) && oneTime && (REPORT_NAME.test(stem) || DATED.test(stem) || ONE_OFF_DIR.test(f.path));
    if (report && f.author !== "human" && f.author !== "unknown" && old(f) && !f.uses)
      flag(f, "one-off", `${f.author === "ai" ? "AI-written" : f.author === "mixed" ? "partly AI-written" : "a"} ${name.replace(MD, "").toLowerCase().includes("plan") ? "plan" : "report"} ${opts.noUsage ? `over ${days} days old (reads not observed)` : `not read in ${days} days`}`);
    else if (f.kind === "on-demand" && f.role === "doc" && f.author === "ai" && !HUMAN_DOCS.test(name) && old(f) && f.uses === 0)
      flag(f, "unused", `AI-written and not read in ${days} days`);
    // Stale references matter where agents follow them: instructions, rules, skills, commands. In other docs a
    // dead path is usually history or a plan, so it isn't flagged.
    let stale = f.scope === "project" && f.kind !== "on-demand" ? staleRefs(texts.get(f.abs) ?? "", f.abs, dir, history.ever, workspaceScripts) : [];
    if (stale.length) { const ig = ignored(stale.filter((x) => !x.startsWith("npm run "))); stale = stale.filter((x) => !ig.has(x)); }
    if (stale.length)
      flag(f, "stale", `mentions ${stale.length} thing${stale.length === 1 ? "" : "s"} that no longer exist${stale.length === 1 ? "s" : ""}: ${stale.slice(0, 4).join(", ")}${stale.length > 4 ? ", …" : ""}`);
  }

  // Duplicates and overlap, across every pair (largest files first; bounded for huge repos).
  const comparable = files.filter((f) => !f.linkTo && (texts.get(f.abs) ?? "").length > 80).sort((a, b) => b.tokens - a.tokens).slice(0, 1500);
  // Two copies only cost twice when one agent loads both; across agents they are a maintenance risk.
  const shared = (a: ContextFile, b: ContextFile) => a.agents.some((x) => b.agents.includes(x));
  // Overlap is judged only where agent context is involved; two ordinary docs repeating each other are out of scope.
  const agentContext = (f: ContextFile) => f.kind !== "on-demand" || f.role !== "doc" || f.agents[0] !== "any" || REPORT_NAME.test(basename(f.path).replace(MD, "")) || !f.path.includes("/");
  // The same file under two agents' folders (.claude/skills/x and .agents/skills/x) is a mirror.
  const tail = (p: string) => p.replace(/^\.[a-z]+\//i, "");
  const mirror = (a: ContextFile, b: ContextFile) => a.path !== b.path && tail(a.path) === tail(b.path) && !shared(a, b);
  const norm = new Map(comparable.map((f) => [f.abs, normalize(texts.get(f.abs)!)]));
  const sh = new Map(comparable.map((f) => [f.abs, shingles(norm.get(f.abs)!)]));
  const hash = new Map<string, ContextFile>();
  for (const f of comparable) {
    const h = createHash("sha256").update(norm.get(f.abs)!).digest("hex");
    const first = hash.get(h);
    if (!first) { hash.set(h, f); continue; }
    if (!agentContext(first) && !agentContext(f)) continue;
    // AGENTS.md in chat-ui/ and in admin-ui/ each serve their own folder; no session loads both.
    if (first.kind === "always" && f.kind === "always" && basename(first.path).toLowerCase() === basename(f.path).toLowerCase()) continue;
    if (mirror(first, f)) { flag(f, "duplicate", `mirror of ${first.path} for another agent; a symlink keeps them in step`); continue; }
    // Flag the copy whose removal saves the most per session; on a tie, the later one.
    const [keep, drop] = first.perSession > f.perSession ? [f, first] : [first, f];
    if (shared(keep, drop) || keep.kind === "on-demand" || drop.kind === "on-demand") flag(drop, "duplicate", `same text as ${keep.path}`, drop.perSession);
    else flag(drop, "duplicate", `same text as ${keep.path}; different agents load each, so no session pays twice, but the copies will drift: a symlink keeps them in step`);
  }
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const a = comparable[i]!, b = comparable[j]!;
      if (a.flags.some((x) => x.code === "duplicate") || b.flags.some((x) => x.code === "duplicate")) continue;
      const sa = sh.get(a.abs)!, sb = sh.get(b.abs)!;
      if (Math.min(sa.size, sb.size) < 20 || Math.min(a.tokens, b.tokens) < 300 || (!agentContext(a) && !agentContext(b)) || mirror(a, b)) continue;
      if (a.kind === "always" && b.kind === "always" && basename(a.path).toLowerCase() === basename(b.path).toLowerCase()) continue; // per-folder instructions
      const o = overlap(sa, sb);
      const [small, big] = sa.size <= sb.size ? [a, b] : [b, a];
      // Only the copy that is loaded no less often than the other is redundant: a command quoted in a chat log isn't.
      const rank = (f: ContextFile) => (f.kind === "always" ? 0 : f.kind === "described" ? 1 : 2);
      if (rank(big) > rank(small) || small.flags.some((x) => x.code === "near-duplicate" || x.code === "contained")) continue;
      const pays = shared(small, big) || small.kind === "on-demand" || big.kind === "on-demand";
      if (o.jaccard >= 0.8) flag(small, "near-duplicate", `${Math.round(o.jaccard * 100)}% the same as ${big.path}${pays ? "" : " (loaded by different agents)"}`, pays ? small.perSession : 0);
      else if (o.containment >= 0.6) flag(small, "contained", `${Math.round(o.containment * 100)}% of it repeats ${big.path}${pays ? "" : " (loaded by different agents)"}`, pays ? Math.round(small.perSession * o.containment) : 0);
    }
  }

  // Contradiction candidates: instruction files that cover the same topics without being copies.
  const instr = files.filter((f) => f.kind !== "on-demand" && (f.role === "instructions" || f.role === "rules" || f.role === "memory") && (texts.get(f.abs) ?? "").length > 200);
  const terms = new Map(instr.map((f) => [f.abs, topTerms(normalize(texts.get(f.abs)!))]));
  const conflictCandidates: ContextAudit["conflictCandidates"] = [];
  for (let i = 0; i < instr.length; i++) {
    for (let j = i + 1; j < instr.length; j++) {
      const a = instr[i]!, b = instr[j]!;
      if (a.flags.some((x) => /duplicate/.test(x.code)) || b.flags.some((x) => /duplicate/.test(x.code))) continue;
      const ta = terms.get(a.abs)!, tb = terms.get(b.abs)!;
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      const o = inter / Math.max(1, Math.min(ta.size, tb.size));
      if (o >= 0.3) conflictCandidates.push({ a: a.path, b: b.path, overlap: Math.round(o * 100) / 100 });
    }
  }
  conflictCandidates.sort((x, y) => y.overlap - x.overlap);

  files.sort((a, b) => b.savePerSession - a.savePerSession || b.flags.length - a.flags.length || b.perSession - a.perSession || b.tokens - a.tokens);
  return { projectDir: dir, days, files, conflictCandidates: conflictCandidates.slice(0, 12), sources: usage.sources };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const when = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", copilot: "Copilot", gemini: "Gemini CLI", windsurf: "Windsurf", cline: "Cline" };

/** Always-loaded tokens per agent: each agent loads only its own files, so the sum over agents overstates any one session. */
function perAgent(always: ContextFile[]): { max: number; by: Record<string, number> } {
  const by: Record<string, number> = {};
  for (const f of always) for (const ag of f.agents) if (ag !== "any") by[ag] = (by[ag] ?? 0) + f.tokens;
  return { max: Math.max(0, ...Object.values(by)), by };
}

/** "(Claude Code, Codex ~16.4k · Cursor ~2k)": agents grouped by what they load, when they differ or there are several. */
function byAgentNote(by: Record<string, number>): string {
  const groups = new Map<number, string[]>();
  for (const [k, v] of Object.entries(by)) groups.set(v, [...(groups.get(v) ?? []), AGENT_NAMES[k] ?? k]);
  if (Object.keys(by).length < 2) return "";
  return ` (${[...groups.entries()].sort((x, y) => y[0] - x[0]).map(([v, names]) => `${names.join(", ")} ~${fmtTokens(v)}`).join(" · ")})`;
}

export function totals(a: ContextAudit) {
  const sum = (fs: ContextFile[], k: "perSession" | "tokens" | "savePerSession") => fs.reduce((s, f) => s + f[k], 0);
  const always = a.files.filter((f) => f.kind === "always"), described = a.files.filter((f) => f.kind === "described"), onDemand = a.files.filter((f) => f.kind === "on-demand");
  const flagged = a.files.filter((f) => f.flags.length);
  const known = a.files.filter((f) => f.author !== "unknown");
  return {
    always: { files: always.length, perSession: perAgent(always).max, byAgent: perAgent(always).by },
    described: { files: described.length, perSession: sum(described, "perSession") },
    onDemand: { files: onDemand.length, tokens: sum(onDemand, "tokens") },
    flagged: flagged.length,
    savePerSession: sum(flagged, "savePerSession"),
    flaggedOnDemandTokens: sum(flagged.filter((f) => f.kind === "on-demand"), "tokens"),
    aiShare: known.length ? known.filter((f) => f.author !== "human").length / known.length : null,
  };
}

/** The human report: totals, then flagged files ranked by what they cost every session. */
export function renderAudit(a: ContextAudit, opts: { all?: boolean } = {}): string {
  const t = totals(a);
  const lines = [
    `Agent context for ${a.projectDir} · usage from the last ${a.days} days${a.sources.length ? ` (${a.sources.join(", ")})` : " (no session history found)"}`,
    "",
    `  Always loaded             ${String(t.always.files).padStart(4)}   ~${fmtTokens(t.always.perSession)} tokens every session${byAgentNote(t.always.byAgent)}`,
    `  Skills, commands, agents  ${String(t.described.files).padStart(4)}   ~${fmtTokens(t.described.perSession)} tokens of descriptions every session`,
    `  Other docs                ${String(t.onDemand.files).padStart(4)}   ~${fmtTokens(t.onDemand.tokens)} tokens when read`,
  ];
  if (t.aiShare !== null) lines.push(`  Written with AI           ${String(Math.round(t.aiShare * 100) + "%").padStart(4)}   of files with known authorship`);
  const list = opts.all ? a.files : a.files.filter((f) => f.flags.length);
  lines.push("");
  if (!list.length) {
    lines.push("Nothing flagged: no unused, duplicate, stale or oversized agent context.");
  } else {
    lines.push(`${t.flagged} flagged · ~${fmtTokens(t.savePerSession)} tokens per session to save${t.flaggedOnDemandTokens ? ` · ~${fmtTokens(t.flaggedOnDemandTokens)} more in docs agents may read` : ""}`, "");
    lines.push(`  ${"SAVE/SESSION".padEnd(13)}${"TOKENS".padEnd(8)}${"KIND".padEnd(11)}${"LAST USED".padEnd(12)}${"AUTHOR".padEnd(8)}PATH`);
    for (const f of list.slice(0, opts.all ? 500 : 40)) {
      lines.push(`  ${(f.savePerSession ? "~" + fmtTokens(f.savePerSession) : "—").padEnd(13)}${fmtTokens(f.tokens).padEnd(8)}${f.kind.padEnd(11)}${(f.kind === "always" ? "—" : when(f.lastUsed)).padEnd(12)}${f.author.padEnd(8)}${f.path}`);
      for (const fl of f.flags) lines.push(`  ${"".padEnd(52)}↳ ${fl.code} (${fl.action}): ${fl.reason}`);
    }
    if (list.length > 40 && !opts.all) lines.push(`  … ${list.length - 40} more (--all, or --json)`);
  }
  if (a.conflictCandidates.length) {
    lines.push("", "Instruction files that cover the same ground (check them for contradictions; `--map` gives an agent what it needs):");
    for (const c of a.conflictCandidates.slice(0, 6)) lines.push(`  ${c.a}  ↔  ${c.b}`);
  }
  if (list.length) lines.push("", "Nothing is changed. Actions: merge (share or combine the repeated text) · fix (update dead references) · trim (move detail to docs read on demand) · review (read it, then keep, update or archive).",
    "Review before archiving: one-off reports and copies often still hold rationale, pending work or examples. `--map` gives your agent a compact list to judge.",
    "  snout audit context --archive <paths>     # move out of the repo after you confirm; --restore undoes it");
  return lines.join("\n");
}

/** A compact map for an agent to judge: one line per file, plus the pairs to check. Pack the map, not the repo. */
export function renderMap(a: ContextAudit): string {
  const lines = [
    `# Agent context map: ${basename(a.projectDir)} · ${a.days}-day usage`,
    "# path | kind | role | tokens | per-session | uses | last used | author | flags",
  ];
  for (const f of a.files) {
    lines.push([f.linkTo ? `${f.path} -> ${f.linkTo}` : f.path, f.kind, f.role, f.tokens, f.perSession, f.uses === null ? "-" : f.uses, f.kind === "always" ? "-" : when(f.lastUsed), f.author, f.flags.map((x) => `${x.code}→${x.action}(${x.reason})`).join("; ") || "-"].join(" | "));
  }
  if (a.conflictCandidates.length) {
    lines.push("", "# Pairs to check for contradicting instructions (topic overlap 0-1):");
    for (const c of a.conflictCandidates) lines.push(`${c.a} <> ${c.b} | ${c.overlap}`);
  }
  lines.push("", "# Judge each flagged file: keep, trim, merge, fix or archive. Archive only what holds nothing still needed: rationale, pending work and examples count; never remove a file someone still relies on.");
  return lines.join("\n");
}

export function toJson(a: ContextAudit) {
  return { ...a, totals: totals(a), files: a.files.map(({ abs: _abs, ...f }) => f) };
}

// ---------------------------------------------------------------------------------------------
// Archive and restore: move, never delete
// ---------------------------------------------------------------------------------------------

export interface ArchiveManifest {
  id: string;
  created: string;
  files: { path: string; bytes: number; sha256: string }[];
}

const archiveRoot = (projectDir: string) => join(resolve(projectDir), ".snout", "archive");

/** Moves project files to .snout/archive/<id>/, keeping their paths, with a manifest. Returns the manifest. */
export function archiveFiles(projectDir: string, paths: string[], now = new Date()): ArchiveManifest {
  const dir = resolve(projectDir);
  const id = now.toISOString().replace(/[:.]/g, "-");
  const base = join(archiveRoot(dir), id);
  const files: ArchiveManifest["files"] = [];
  const todo: [string, string][] = [];
  for (const p of paths) {
    const abs = resolve(dir, p);
    const rel = relative(dir, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} is outside the project`);
    if (rel.split(sep)[0] === ".snout" || rel.split(sep)[0] === ".git") throw new Error(`${p} can't be archived`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${p} is not a file`);
    const buf = readFileSync(abs);
    files.push({ path: rel.split(sep).join("/"), bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
    todo.push([abs, join(base, rel)]);
  }
  if (!todo.length) throw new Error("no files given");
  mkdirSync(base, { recursive: true });
  const manifest: ArchiveManifest = { id, created: now.toISOString(), files };
  writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const [from, to] of todo) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  return manifest;
}

export function listArchives(projectDir: string): ArchiveManifest[] {
  const root = archiveRoot(projectDir);
  if (!existsSync(root)) return [];
  const out: ArchiveManifest[] = [];
  for (const id of readdirSync(root).sort()) {
    try { out.push(JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8"))); } catch { /* not an archive */ }
  }
  return out;
}

/** Puts an archive's files back. A file that exists again at its old path is left in the archive and reported. */
export function restoreArchive(projectDir: string, id: string): { restored: string[]; skipped: string[] } {
  const dir = resolve(projectDir);
  if (!/^[0-9TZ-]+$/.test(id)) throw new Error(`no archive ${id}`);
  const base = join(archiveRoot(dir), id);
  let manifest: ArchiveManifest;
  try { manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8")); } catch { throw new Error(`no archive ${id}`); }
  const restored: string[] = [], skipped: string[] = [];
  for (const f of manifest.files) {
    const from = join(base, f.path), to = resolve(dir, f.path);
    if (relative(dir, to).startsWith("..")) { skipped.push(f.path); continue; }
    if (!existsSync(from)) { if (!existsSync(to)) skipped.push(f.path); continue; } // already back, or lost
    if (existsSync(to)) { skipped.push(f.path); continue; } // something else is at that path now
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    restored.push(f.path);
  }
  if (!skipped.length) {
    // Remove the emptied archive folders, then the manifest's own folder.
    const prune = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(join(d, e.name)); try { if (d !== base) rmdirSync(d); } catch { /* not empty */ } };
    prune(base);
    try { renameSync(join(base, "manifest.json"), join(archiveRoot(dir), `${id}.restored.json`)); rmdirSync(base); } catch { /* leave it */ }
  }
  return { restored, skipped };
}
