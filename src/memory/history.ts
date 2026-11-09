/**
 * The project's history before Snout was there, read once from what is already on this machine:
 *
 *   commits   git log, every branch, the last six months: subject, message, files, author
 *   PRs       `gh pr list` with the user's own login: title, body, reviews, comments, files, commits
 *   CI runs   `gh run list`: runs that failed or timed out, with the jobs and steps that failed
 *   sessions  earlier Claude Code transcripts and Codex rollouts for this project folder, as the
 *             same session records (cards) Snout writes at each Stop
 *
 * One record per commit, PR and run, each with `at` (when its content was last known to change)
 * and a link back to where it came from, so a search can cite it and `asOf` can hide the future
 * (a replay of a PR must not see what came after it). Sessions are linked to the commits they
 * made (git's own "[branch abc1234] subject" in the transcript) and through those to their PRs.
 *
 * Records live in the user's config folder, never in the repository: a PR thread or a run log is
 * the team's, but the copy is this user's. Nothing is sent anywhere; `gh` only reads. Text that
 * looks like a credential is replaced before anything is written, and a diff is never read, only
 * the names of the files it touched. The local index (sqlite.ts) copies the files like any other
 * record folder. A rerun reads only what is new since the last one (two days of overlap; records
 * are keyed by sha, number and run id, so a record seen twice is one record).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { codexSessionFacts, sessionFacts, type SessionFacts } from "../compact/memory.js";
import { claudeRoot, claudeSlug, codexRoot, jsonlFiles } from "../spend/usage.js";
import { writeAtomic } from "../util/atomic.js";
import { cardsDir, readCard, type Card, type Commit } from "./memory.js";
import { folderChanged, indexedRecords, type RecordKind } from "./sqlite.js";
import { indexForms } from "./retrieve.js";

export type HistKind = "commit" | "pr" | "run";

export interface HistRecord {
  v: 1;
  /** `commit:<sha>`, `pr:<number>`, `run:<id>`. */
  id: string;
  kind: HistKind;
  /** When its content was last known to change: a commit's date, a PR's merge or close (else last update), a run's end. */
  at: string;
  /** A PR's opening. */
  opened?: string;
  title: string;
  /** Message, PR body and review thread, or the failed jobs and steps: credentials replaced, capped. */
  body: string;
  files: string[];
  /** Where it came from: the PR or run on GitHub, or `git show <sha>`. */
  link: string;
  author?: string;
  branch?: string;
  /** A commit's sha, a PR's merge commit, a run's head commit. */
  sha?: string;
  /** A PR's commits. */
  commits?: string[];
  /** The sessions that made it: a commit's, or those whose commits a PR holds. */
  sessions?: string[];
  /** merged / closed / open for a PR; the conclusion for a run. */
  state?: string;
  /** A run's workflow file. */
  workflow?: string;
}

/** How far back a first import reads. */
export const SINCE_DAYS = 183;
/** Records kept per project at most: past it, the oldest go first. */
export const MAX_RECORDS = 3000;
const OVERLAP_MS = 2 * 86_400_000;
/** A session start refreshes the local part (git and sessions) when the last import is older than this. */
export const REFRESH_MS = 86_400_000;
const BODY = { commit: 1500, pr: 3000, run: 1500 } as const;
const MAX_FILES = 40;
const PR_LIMIT = 200;
const PR_PAGE = 50;
const RUN_LIMIT = 100;
/** Failed runs opened one by one for their jobs (a `gh` call each), per import. */
const RUN_DETAILS = 20;

/**
 * Credentials as they turn up in commit messages, PR threads and transcripts: private keys, the
 * token formats of the big providers, a JWT, a password in a URL, and the value after a
 * password/secret/token/api key label. Replaced, not skipped, so the rest of the text stays.
 */
const SECRETS = new RegExp([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/.source,
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/.source,
  /(?<=\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[=:]\s*["']?)[^\s"',;]{6,}/.source,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/.source,
  /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]{3,}(?=@)/.source,
].join("|"), "gi");

export const REDACTED = "[redacted]";

/** Text with every credential-looking run replaced. */
export function scrub(text: string): string {
  return text.replace(SECRETS, REDACTED);
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clean = (s: unknown, n: number) => cap(scrub(String(s ?? "")).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim(), n);

export const historyDir = (configDir: string, project: string) => join(configDir, "history", project, "records");
const stateFile = (configDir: string, project: string) => join(configDir, "history", project, "import.json");
const fileName = (id: string) => `${id.replace(":", "-").replace(/[^\w.-]/g, "_").slice(0, 80)}.json`;

function parse(raw: unknown): HistRecord | null {
  const r = raw as Partial<HistRecord> | null;
  if (!r || r.v !== 1 || typeof r.id !== "string" || !["commit", "pr", "run"].includes(String(r.kind))) return null;
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at)) || typeof r.title !== "string") return null;
  return { ...r, body: String(r.body ?? ""), files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string") : [], link: String(r.link ?? "") } as HistRecord;
}

/** Everything a search matches a record on. */
export const histText = (r: HistRecord) => [r.kind === "pr" ? `PR #${r.id.slice(3)}` : r.kind === "run" ? `CI run ${r.workflow ?? ""}` : "", r.title, r.body, r.branch, r.state, r.sha, ...r.files].filter(Boolean).join(" ");

/** History records as the local index keeps them. A project may have thousands, so the folder's time is trusted. */
export const HIST_KIND: RecordKind<HistRecord> = {
  name: "hist", parse, text: histText, files: (r) => r.files, updated: (r) => r.at,
  forms: (text) => indexForms(text), trustFolderTime: true,
};

/** Every history record here, from the local index when there is one, else from the files. */
export function readHistory(dir: string, index?: string): HistRecord[] {
  const indexed = indexedRecords(index, dir, HIST_KIND);
  if (indexed) return indexed;
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const out: HistRecord[] = [];
  for (const n of names) {
    try { const r = parse(JSON.parse(readFileSync(join(dir, n), "utf8"))); if (r) out.push(r); } catch { /* half-written or hand-broken */ }
  }
  return out;
}

// ---------------------------------------------------------------- sources

function git(projectDir: string, args: string[]): string | undefined {
  const r = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return r.status === 0 ? r.stdout : undefined;
}

/** Commits on every branch since a date, newest first. A merge lists no files (its PR does). */
export function gitCommits(projectDir: string, since: Date): HistRecord[] {
  // --exclude applies to the --all after it: the stash's work-in-progress commits are not history.
  const out = git(projectDir, ["log", "--exclude=refs/stash", "--all", `--since=${since.toISOString()}`, "--format=%x1e%H%x1f%an%x1f%cI%x1f%s%x1f%b%x1f", "--name-only"]);
  if (!out) return [];
  const records: HistRecord[] = [];
  for (const chunk of out.split("\x1e")) {
    const [sha, author, at, subject, body, names] = chunk.split("\x1f");
    if (!sha || !at || !/^[0-9a-f]{40}$/.test(sha.trim())) continue;
    const files = (names ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    records.push({
      v: 1, id: `commit:${sha.trim()}`, kind: "commit", at: new Date(at).toISOString(), title: clean(subject, 200), body: clean(body, BODY.commit),
      files: files.slice(0, MAX_FILES), link: `git show ${sha.trim().slice(0, 12)}`, author: clean(author, 80), sha: sha.trim(),
    });
  }
  return records;
}

/** The commits any branch, remote or tag still reaches, back to a date; undefined when git can't say. */
function reachable(projectDir: string, since: Date): Set<string> | undefined {
  const out = git(projectDir, ["rev-list", "--exclude=refs/stash", "--all", `--since=${since.toISOString()}`]);
  const shas = new Set((out ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  return shas.size ? shas : undefined;
}

/** How `gh` is run: SNOUT_GH names another program (a test's stand-in), a .mjs or .js file runs with this Node. */
function gh(projectDir: string, args: string[], env: NodeJS.ProcessEnv): { ok: true; json: unknown } | { ok: false; why: string } {
  const bin = env.SNOUT_GH || "gh";
  const [cmd, pre] = /\.[cm]?js$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
  const r = spawnSync(cmd, [...pre, ...args], { cwd: projectDir, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  if (r.error) return { ok: false, why: (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "gh is not installed" : r.error.message };
  if (r.status !== 0) return { ok: false, why: (r.stderr || r.stdout || `gh exited ${r.status}`).trim().split("\n")[0]!.slice(0, 160) };
  try { return { ok: true, json: JSON.parse(r.stdout) }; } catch { return { ok: false, why: "gh printed something other than JSON" }; }
}

/**
 * One page of PRs, newest change first, with only what a record holds. `gh pr list --json` with
 * commits asks for every commit's authors too, which GitHub refuses past 500,000 possible nodes
 * (it did on this repository: 200 PRs × 100 commits × 100 authors), so the query is Snout's own.
 */
const PR_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PR_PAGE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body url state createdAt mergedAt closedAt updatedAt headRefName baseRefName
        author { login } mergeCommit { oid }
        files(first: 100) { nodes { path } }
        commits(first: 100) { nodes { commit { oid } } }
        reviews(first: 30) { nodes { author { login } state body } }
        comments(first: 30) { nodes { author { login } body } }
        closingIssuesReferences(first: 10) { nodes { number } }
      }
    }
  }
}`;
const login = (a: any) => (typeof a?.login === "string" ? a.login : undefined);
const nodes = (c: any): any[] => (Array.isArray(c?.nodes) ? c.nodes : []);

/** PRs changed since a date, open and closed, with their review thread: PR_LIMIT at most, newest first. */
function pullRequests(projectDir: string, since: Date, env: NodeJS.ProcessEnv): HistRecord[] | string {
  const repo = gh(projectDir, ["repo", "view", "--json", "owner,name"], env);
  if (!repo.ok) return repo.why;
  const owner = login((repo.json as any)?.owner), name = (repo.json as any)?.name;
  if (!owner || typeof name !== "string") return "gh repo view did not name the repository";
  const found: any[] = [];
  let cursor: string | undefined;
  while (found.length < PR_LIMIT) {
    const r = gh(projectDir, ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, ...(cursor ? ["-f", `cursor=${cursor}`] : [])], env);
    if (!r.ok) return r.why;
    const page = (r.json as any)?.data?.repository?.pullRequests;
    if (!page) return "gh api graphql gave no pull requests";
    const fresh = nodes(page).filter((p) => Date.parse(p?.updatedAt) >= since.getTime());
    found.push(...fresh);
    if (fresh.length < nodes(page).length || !page.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
    cursor = page.pageInfo.endCursor;
  }
  return found.slice(0, PR_LIMIT).flatMap((p: any): HistRecord[] => {
    if (typeof p?.number !== "number") return [];
    const state = p.mergedAt ? "merged" : String(p.state ?? "").toLowerCase() || "open";
    const thread = [
      ...nodes(p.reviews).filter((x: any) => x?.body).map((x: any) => `Review (${String(x.state ?? "").toLowerCase() || "comment"}) by ${login(x.author) ?? "someone"}: ${x.body}`),
      ...nodes(p.comments).filter((x: any) => x?.body).map((x: any) => `Comment by ${login(x.author) ?? "someone"}: ${x.body}`),
    ];
    const issues = nodes(p.closingIssuesReferences).map((i: any) => i?.number).filter((n: unknown) => typeof n === "number");
    const body = [p.body, issues.length ? `Closes ${issues.map((n: number) => `#${n}`).join(", ")}` : "", ...thread].filter(Boolean).join("\n\n");
    const at = p.mergedAt ?? p.closedAt ?? p.updatedAt ?? p.createdAt;
    if (!at || Number.isNaN(Date.parse(at))) return [];
    return [{
      v: 1, id: `pr:${p.number}`, kind: "pr", at: new Date(at).toISOString(), ...(p.createdAt ? { opened: new Date(p.createdAt).toISOString() } : {}),
      title: clean(p.title, 200), body: clean(body, BODY.pr),
      files: nodes(p.files).map((f: any) => f?.path).filter((f: unknown): f is string => typeof f === "string").slice(0, MAX_FILES),
      link: String(p.url ?? ""), author: login(p.author), branch: typeof p.headRefName === "string" ? p.headRefName : undefined, state,
      ...(typeof p.mergeCommit?.oid === "string" ? { sha: p.mergeCommit.oid } : {}),
      commits: nodes(p.commits).map((c: any) => c?.commit?.oid).filter((o: unknown): o is string => typeof o === "string"),
    }];
  });
}

/** The workflow file each workflow name belongs to (`name:` at the top of the file, else the file's own name). */
function workflowFiles(projectDir: string): Map<string, string> {
  const dir = join(projectDir, ".github", "workflows");
  const out = new Map<string, string>();
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)); } catch { return out; }
  for (const n of names) {
    const rel = `.github/workflows/${n}`;
    out.set(n.replace(/\.ya?ml$/, "").toLowerCase(), rel);
    try {
      const m = /^name:\s*["']?(.+?)["']?\s*$/m.exec(readFileSync(join(dir, n), "utf8"));
      if (m) out.set(m[1]!.trim().toLowerCase(), rel);
    } catch { /* unreadable: its file name still maps */ }
  }
  return out;
}

const BAD = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const said = (c: string) => (c === "timed_out" ? "timed out (timeout)" : c === "startup_failure" ? "failed to start" : c === "failure" ? "failed" : c.replace(/_/g, " "));

/** CI runs since a date that failed or timed out, each with the jobs and steps that did, for the newest few. */
function failedRuns(projectDir: string, since: Date, known: Set<string>, env: NodeJS.ProcessEnv): HistRecord[] | string {
  const r = gh(projectDir, ["run", "list", "--status", "completed", "--limit", String(RUN_LIMIT), "--created", `>=${since.toISOString().slice(0, 10)}`, "--json", "databaseId,workflowName,displayTitle,conclusion,createdAt,updatedAt,headBranch,headSha,event,url"], env);
  if (!r.ok) return r.why;
  if (!Array.isArray(r.json)) return "gh run list gave no list";
  const files = workflowFiles(projectDir);
  let details = 0;
  return r.json.flatMap((run: any): HistRecord[] => {
    const conclusion = String(run?.conclusion ?? "");
    if (typeof run?.databaseId !== "number" || !BAD.has(conclusion)) return [];
    const id = `run:${run.databaseId}`;
    const workflow = files.get(String(run.workflowName ?? "").toLowerCase());
    const lines = [`${run.workflowName ?? "workflow"} ${said(conclusion)} on ${run.headBranch ?? "?"} (${run.event ?? "?"}).`];
    // Its jobs, for the newest failures only: one gh call each, and an old run's detail rarely matters.
    if (!known.has(id) && details < RUN_DETAILS) {
      details++;
      const v = gh(projectDir, ["run", "view", String(run.databaseId), "--json", "jobs"], env);
      const jobs = v.ok && Array.isArray((v.json as any)?.jobs) ? (v.json as any).jobs : [];
      for (const j of jobs) {
        if (!BAD.has(String(j?.conclusion)) && j?.conclusion !== "cancelled") continue;
        const steps = (Array.isArray(j.steps) ? j.steps : []).filter((s: any) => BAD.has(String(s?.conclusion)) || s?.conclusion === "cancelled").map((s: any) => `"${s.name}" ${said(String(s.conclusion))}`);
        const took = j.startedAt && j.completedAt ? ` after ${Math.round((Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 60_000)} min` : "";
        lines.push(`Job "${j.name}" ${said(String(j.conclusion))}${took}${steps.length ? `: ${steps.join(", ")}` : ""}.`);
      }
    }
    const at = run.updatedAt ?? run.createdAt;
    if (!at || Number.isNaN(Date.parse(at))) return [];
    return [{
      v: 1, id, kind: "run", at: new Date(at).toISOString(), title: clean(`${run.workflowName ?? "CI"}: ${run.displayTitle ?? ""}`, 200), body: clean(lines.join("\n"), BODY.run),
      files: workflow ? [workflow] : [], link: String(run.url ?? ""), branch: typeof run.headBranch === "string" ? run.headBranch : undefined,
      ...(typeof run.headSha === "string" ? { sha: run.headSha } : {}), state: conclusion, ...(workflow ? { workflow } : {}),
    }];
  });
}

// ---------------------------------------------------------------- sessions

interface Transcript { file: string; agent: Card["agent"]; key: string }

/** A folder with symlinks resolved, for comparison: on macOS /var/folders/… is /private/var/folders/…. */
function realDir(dir: string): string {
  try { return realpathSync.native(dir).toLowerCase(); } catch { return resolve(dir).toLowerCase(); }
}

/** This project's transcripts: Claude Code's folder for it (not subagents), and Codex rollouts whose cwd is it. */
function transcripts(projectDir: string, env: NodeJS.ProcessEnv): Transcript[] {
  const out: Transcript[] = [];
  const here = resolve(projectDir).toLowerCase();
  const real = realDir(projectDir);
  const name = basename(here);
  // Claude Code names its folder after the path it started in, which can be another spelling of this
  // one through a symlink. A folder for the same last name is opened and its recorded cwd compared.
  const root = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "projects") : claudeRoot();
  const own = claudeSlug(projectDir);
  const tail = "-" + name.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  let folders: string[] = [];
  try { folders = readdirSync(root); } catch { /* none */ }
  for (const folder of folders) {
    if (folder !== own && !folder.toLowerCase().endsWith(tail)) continue;
    let files: string[] = [];
    try { files = readdirSync(join(root, folder)).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
    if (folder !== own) {
      const cwd = files.length ? headCwd(join(root, folder, files[0]!), "claude") : null;
      if (!cwd || realDir(cwd) !== real) continue;
    }
    for (const n of files) out.push({ file: join(root, folder, n), agent: "claude", key: "" });
  }
  for (const f of jsonlFiles(env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : codexRoot())) {
    if (!basename(f).startsWith("rollout-")) continue;
    const cwd = headCwd(f, "codex");
    if (!cwd) continue;
    const there = resolve(cwd).toLowerCase();
    if (there === here || (basename(there) === name && realDir(cwd) === real)) out.push({ file: f, agent: "codex", key: "" });
  }
  for (const t of out) {
    try { const st = statSync(t.file); t.key = `${st.size}:${Math.round(st.mtimeMs)}`; } catch { /* gone */ }
  }
  return out.filter((t) => t.key);
}

/** The working folder a transcript recorded: a Claude Code row's cwd, or a Codex rollout's session_meta. */
function headCwd(file: string, agent: "claude" | "codex"): string | null {
  try {
    // The first lines only: a transcript can run to hundreds of megabytes.
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const head = buf.subarray(0, n).toString("utf8");
    for (const l of head.split("\n")) {
      if (agent === "codex" ? !l.includes("session_meta") && !l.includes("turn_context") : !l.includes('"cwd"')) continue;
      try {
        const row = JSON.parse(l);
        const cwd = agent === "codex" ? row?.payload?.cwd : row?.cwd;
        if (typeof cwd === "string") return cwd;
      } catch { /* cut line */ }
    }
  } catch { /* unreadable */ }
  return null;
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
/** git commit's own line: "[main abc1234] Subject" (or "[main (root-commit) abc1234]"). */
const COMMITTED = /\[[\w./-]+(?: \([\w-]+\))? ([0-9a-f]{7,40})\] /g;

/** What a transcript says about itself without a model: its id, when it ran, its branch, and the commits it made. */
function transcriptMeta(t: Transcript): { session: string; started?: string; updated?: string; branch?: string; shas: string[] } {
  let text = "";
  try { text = readFileSync(t.file, "utf8"); } catch { /* gone */ }
  let session = t.agent === "claude" ? basename(t.file, ".jsonl") : (UUID.exec(basename(t.file))?.[1] ?? basename(t.file, ".jsonl"));
  let started: string | undefined, updated: string | undefined, branch: string | undefined;
  const shas = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = typeof o.timestamp === "string" && !Number.isNaN(Date.parse(o.timestamp)) ? o.timestamp : undefined;
    if (ts) { started ??= ts; updated = ts; }
    if (t.agent === "claude" && typeof o.gitBranch === "string" && o.gitBranch && o.gitBranch !== "HEAD") branch = o.gitBranch;
    if (t.agent === "codex" && o.type === "session_meta") {
      if (typeof o.payload?.id === "string") session = o.payload.id;
      if (typeof o.payload?.git?.branch === "string") branch = o.payload.git.branch;
    }
    // Only tool output: a commit the user pasted is not one this session made.
    const isOutput = t.agent === "claude"
      ? o.type === "user" && Array.isArray(o.message?.content) && o.message.content.some((b: any) => b?.type === "tool_result")
      : o.type === "response_item" && /output/.test(String(o.payload?.type ?? ""));
    if (isOutput) for (const m of line.matchAll(COMMITTED)) shas.add(m[1]!);
  }
  return { session, started, updated, branch, shas: [...shas] };
}

/** A session's card from its transcript, with text that looks like a credential replaced. Null when it asked and changed nothing. */
function importedCard(t: Transcript, facts: SessionFacts, meta: ReturnType<typeof transcriptMeta>, commits: Commit[]): Card | null {
  if (!facts.goal && !facts.changed.length && !commits.length) return null;
  if (!meta.started || !meta.updated) return null;
  const s = (v: string | undefined, n: number) => (v ? clean(v, n) : undefined);
  const pair = <T extends { line?: string; command: string; result?: string }>(p: T | undefined): T | undefined => (p ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? clean(v, 400) : v])) as T : undefined);
  return {
    v: 1, id: meta.session, session: meta.session, agent: t.agent, started: meta.started, updated: meta.updated,
    ...(meta.branch ? { branch: meta.branch } : {}),
    task: s(facts.goal, 600), request: facts.request !== facts.goal ? s(facts.request, 400) : undefined, outcome: s(facts.outcome, 600),
    changed: facts.changed.filter((p) => !/^[A-Za-z]:|^\//.test(p)).slice(0, 20),
    test: pair(facts.test), error: pair(facts.error), rules: facts.rules.map((r) => clean(r, 300)),
    missing: facts.missing.filter((m) => !m.module).map((m) => m.name), slow: facts.slow,
    open: facts.todos.length ? facts.todos.slice(0, 8).map((x) => clean(x, 200)) : undefined,
    recovered: pair(facts.recovered), commits, via: "import",
  };
}

// ---------------------------------------------------------------- import

export interface ImportState {
  v: 1;
  /** When the last import finished. */
  last?: string;
  /** Transcripts read, by file: size and modification time, so an unchanged one is not read again. */
  sessions: Record<string, string>;
  /** Why GitHub was left out last time, when it was. */
  gh?: string;
  /** When PRs and CI runs were last read with gh. */
  ghRead?: string;
  /** Whether the project has a GitHub remote. */
  githubRemote?: boolean;
  /** Records kept, by kind, and past sessions imported in all. */
  counts?: { commit: number; pr: number; run: number; session: number };
  /** When the user was told once that `snout import` adds GitHub. */
  nudged?: string;
}

export function readImportState(configDir: string, project: string): ImportState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(configDir, project), "utf8")) as ImportState;
    return s?.v === 1 ? { ...s, sessions: s.sessions && typeof s.sessions === "object" ? s.sessions : {} } : null;
  } catch { return null; }
}

export interface ImportOptions {
  project: string;
  projectDir: string;
  snoutDir: string;
  configDir: string;
  indexFile?: string;
  /** Read from this date (else six months back, or two days before the last import). */
  since?: Date;
  /** Read PRs and CI runs with `gh` (default on). Off: git and sessions only. */
  github?: boolean;
  sessions?: boolean;
  /** Records kept at most (MAX_RECORDS). */
  max?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface ImportResult {
  first: boolean;
  since: string;
  /** New or changed records, by kind. */
  added: { commit: number; pr: number; run: number; session: number };
  total: number;
  /** Records dropped for the size cap, oldest first. */
  dropped: number;
  /** Commits no branch, remote or tag reaches any more (rebased, amended, branch deleted): removed. */
  gone: number;
  /** Credentials replaced in what was written. */
  redacted: number;
  /** Why GitHub was left out, when it was. */
  ghSkipped?: string;
  dir: string;
}

const countRedacted = (s: string) => s.split(REDACTED).length - 1;

/** Reads the sources and writes what is new. Never throws for a missing source: it is left out and said. */
export function importHistory(o: ImportOptions): ImportResult {
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const dir = historyDir(o.configDir, o.project);
  const prev = readImportState(o.configDir, o.project);
  const since = o.since ?? (prev?.last ? new Date(Date.parse(prev.last) - OVERLAP_MS) : new Date(now.getTime() - SINCE_DAYS * 86_400_000));
  const result: ImportResult = { first: !prev?.last, since: since.toISOString(), added: { commit: 0, pr: 0, run: 0, session: 0 }, total: 0, dropped: 0, gone: 0, redacted: 0, dir };
  mkdirSync(dir, { recursive: true });
  const existing = new Map(readHistory(dir, o.indexFile).map((r) => [r.id, r]));
  const records: HistRecord[] = gitCommits(o.projectDir, since);
  const bySha = new Map<string, HistRecord>();
  for (const r of [...existing.values(), ...records]) if (r.kind === "commit" && r.sha) bySha.set(r.sha, r);
  const findCommit = (short: string) => bySha.get(short) ?? [...bySha.values()].find((r) => r.sha!.startsWith(short));

  // Sessions: a transcript Snout already has a card for keeps it (the live record is fuller); a new one gets an imported card.
  const state: ImportState = { v: 1, sessions: { ...(prev?.sessions ?? {}) }, ...(prev?.ghRead ? { ghRead: prev.ghRead } : {}), ...(prev?.nudged ? { nudged: prev.nudged } : {}) };
  const sessionOf = new Map<string, string>();
  const cardsHere = cardsDir(o.snoutDir);
  if (o.sessions !== false) {
    for (const t of transcripts(o.projectDir, env)) {
      if (state.sessions[t.file] === t.key) continue;
      try {
        const meta = transcriptMeta(t);
        if (meta.updated && Date.parse(meta.updated) < since.getTime() && !prev?.last) { state.sessions[t.file] = t.key; continue; }
        const commits = meta.shas.map(findCommit).filter((r): r is HistRecord => !!r).map((r): Commit => ({ sha: r.sha!, subject: r.title, ts: r.at, files: r.files.slice(0, 30) }));
        const live = readCard(o.snoutDir, meta.session);
        if (live && live.via !== "import") {
          for (const k of live.commits) sessionOf.set(k.sha, live.session);
        } else {
          const facts = t.agent === "claude" ? sessionFacts(t.file, o.projectDir) : codexSessionFacts(t.file, o.projectDir);
          const card = importedCard(t, facts, meta, commits);
          if (card) {
            mkdirSync(cardsHere, { recursive: true });
            const text = `${JSON.stringify(card, null, 1)}\n`;
            result.redacted += countRedacted(text);
            writeAtomic(join(cardsHere, `${card.session.replace(/[^\w.-]/g, "_").slice(0, 80)}.json`), text);
            result.added.session++;
            for (const k of commits) sessionOf.set(k.sha, card.session);
          }
        }
        state.sessions[t.file] = t.key;
      } catch {
        // An unreadable transcript is left out; the next import tries it again.
      }
    }
    if (result.added.session) folderChanged(o.indexFile, cardsHere);
  }
  // Cards already on record name their commits too.
  try {
    for (const n of readdirSync(cardsHere)) {
      try { const c = JSON.parse(readFileSync(join(cardsHere, n), "utf8")) as Card; for (const k of c.commits ?? []) if (!sessionOf.has(k.sha)) sessionOf.set(k.sha, c.session); } catch { /* skipped */ }
    }
  } catch { /* no cards */ }

  if (o.github !== false) {
    const prs = pullRequests(o.projectDir, since, env);
    if (typeof prs === "string") result.ghSkipped = prs;
    else {
      records.push(...prs);
      const runs = failedRuns(o.projectDir, since, new Set(existing.keys()), env);
      if (typeof runs === "string") result.ghSkipped = runs;
      else records.push(...runs);
      if (!result.ghSkipped) state.ghRead = now.toISOString();
    }
  } else result.ghSkipped = "left out (--no-gh)";

  // Links: a commit to the session that made it, a PR to the sessions whose commits it holds.
  const linkedSessions = (shas: string[]) => [...new Set(shas.map((s) => sessionOf.get(s) ?? [...sessionOf].find(([k]) => k.startsWith(s) || s.startsWith(k))?.[1]).filter((x): x is string => !!x))];
  for (const r of [...records, ...existing.values()]) {
    const sessions = linkedSessions(r.kind === "commit" ? [r.sha!] : r.kind === "pr" ? [...(r.commits ?? []), ...(r.sha ? [r.sha] : [])] : []);
    if (sessions.length) r.sessions = [...new Set([...(r.sessions ?? []), ...sessions])];
  }

  // A run whose jobs were read keeps them when a later import sees it again without reading them.
  const merged = new Map(existing);
  for (const r of records) {
    const was = existing.get(r.id);
    const next = r.kind === "run" && was && was.body.length > r.body.length ? { ...r, body: was.body } : r;
    merged.set(r.id, next);
  }
  // A commit that was rebased away or amended would be cited by a sha no branch has: it leaves memory.
  const commits = [...merged.values()].filter((r) => r.kind === "commit" && r.sha);
  if (commits.length) {
    const oldest = new Date(Math.min(...commits.map((r) => Date.parse(r.at))) - 1000);
    const live = reachable(o.projectDir, oldest);
    for (const r of live ? commits : []) {
      if (live!.has(r.sha!)) continue;
      merged.delete(r.id);
      rmSync(join(dir, fileName(r.id)), { force: true });
      result.gone++;
    }
  }
  for (const r of merged.values()) {
    const text = `${JSON.stringify(r, null, 1)}\n`;
    const was = existing.get(r.id);
    if (was && `${JSON.stringify(was, null, 1)}\n` === text) continue;
    writeAtomic(join(dir, fileName(r.id)), text);
    result.redacted += countRedacted(text) - (was ? countRedacted(JSON.stringify(was, null, 1)) : 0);
    if (!was) result.added[r.kind]++;
  }

  // The size cap: the oldest records go first.
  const max = o.max ?? MAX_RECORDS;
  const all = [...merged.values()].sort((a, b) => b.at.localeCompare(a.at));
  for (const r of all.slice(max)) {
    rmSync(join(dir, fileName(r.id)), { force: true });
    result.dropped++;
  }
  result.total = Math.min(all.length, max);
  const kept = all.slice(0, max);
  const many = (k: HistRecord["kind"]) => kept.filter((r) => r.kind === k).length;
  state.counts = { commit: many("commit"), pr: many("pr"), run: many("run"), session: (prev?.counts?.session ?? 0) + result.added.session };
  state.githubRemote = /github\.com[:/]/i.test(git(o.projectDir, ["remote", "-v"]) ?? "");
  result.redacted = Math.max(0, result.redacted);
  folderChanged(o.indexFile, dir);

  state.last = now.toISOString();
  if (result.ghSkipped) state.gh = result.ghSkipped;
  mkdirSync(join(o.configDir, "history", o.project), { recursive: true });
  writeAtomic(stateFile(o.configDir, o.project), `${JSON.stringify(state, null, 1)}\n`);
  return result;
}

/**
 * Claims a background import for this project: true for the one caller that gets it. A session start
 * that finds no import yet, or one older than a day (REFRESH_MS), starts one in the background, and
 * another session starting at the same moment must not start a second.
 */
export function claimImport(configDir: string, project: string, now = Date.now()): boolean {
  const last = readImportState(configDir, project)?.last;
  if (last && now - Date.parse(last) < REFRESH_MS) return false;
  const marker = join(configDir, "history", project, "running");
  try {
    mkdirSync(join(configDir, "history", project), { recursive: true });
    // A claim older than an hour is from an import that died: taken over.
    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 3_600_000) return false;
    writeFileSync(marker, new Date().toISOString(), { flag: existsSync(marker) ? "w" : "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Once per project, after an import that read git and sessions but not GitHub on a repo with a GitHub
 * remote: one line for the user saying `snout import` adds PRs and CI runs. Null otherwise, and after
 * it was said once.
 */
export function githubNudge(configDir: string, project: string, now = new Date()): string | null {
  const st = readImportState(configDir, project);
  if (!st?.last || st.ghRead || st.nudged || !st.githubRemote) return null;
  const c = st.counts ?? { commit: 0, pr: 0, run: 0, session: 0 };
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  try {
    writeAtomic(stateFile(configDir, project), `${JSON.stringify({ ...st, nudged: now.toISOString() }, null, 1)}\n`);
  } catch {
    return null; // without the mark it would repeat every session
  }
  return `Snout read ${n(c.commit, "commit")} and ${n(c.session, "past session")} from this project. Run snout import to add PRs and failed CI runs from GitHub (read only, with your gh login); snout import github on keeps them current each day.`;
}

/** Whether a record is from before a point in time: `asOf` hides the future. */
export const beforeAsOf = (at: string, asOf?: string) => asOf === undefined || Date.parse(at) < Date.parse(asOf);
