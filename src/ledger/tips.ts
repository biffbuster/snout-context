/**
 * Coaching: changes worth making, derived from the user's own ledger. Every tip states the
 * evidence it rests on, the exact change it would make, and what that change is expected
 * to do per session. Nothing here writes anything — `snout apply` does, and only on `--yes`.
 *
 * Only tips whose effect can be shown and undone exactly are offered. Advice that needs
 * judgement (restructure your orchestration, rewrite a prompt) stays in the report.
 */
import type { DecisionRow } from "../types.js";
import { harnessOf } from "./report.js";

export type TipKind = "claude-md" | "allow" | "mode";

export interface Tip {
  /** Stable across runs: `kind:target`. */
  id: string;
  kind: TipKind;
  target: string;
  title: string;
  /** What the ledger shows, with numbers. */
  evidence: string;
  /** The exact change, as it will be written. */
  change: string;
  /** What it should do. */
  effect: string;
  /** Estimated tokens per session the change stops reaching context. 0 when not a saving. */
  perSession: number;
  /** claude-md only: the rule that flagged the file, which picks the line's wording. */
  rule?: string;
}

export interface TipContext {
  mode: string;
  alwaysAllow: string[];
  /** Current CLAUDE.md text, or "" when absent. A path already named there gets no tip. */
  claudeMd: string;
  gateInstalled: boolean;
}

const MIN_READS = 3;
const MIN_TOKENS = 5_000;
const MAX_CLAUDE_MD_TIPS = 3;
/** Printable, no backticks, bounded: safe to show and to write exactly as-is. */
const SAFE_PATH = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029`]{1,200}$/;

/** The one line a CLAUDE.md tip appends. Written for the agent, so it says what to do instead. */
export function claudeMdLine(path: string, rule: string): string {
  const p = `\`${path}\``;
  switch (rule) {
    case "lockfile":
      return `- Don't read ${p}: it's a generated lockfile. Ask the package manager for versions instead.`;
    case "generated":
      return `- Don't read ${p}: it's generated. Read or edit its source or generator instead.`;
    case "vendored":
      return `- Don't read ${p}: it's third-party or build output. Only open it if the task is about it.`;
    case "minified":
    case "binary":
    case "binary-content":
      return `- Don't read ${p}: it's minified or binary and yields nothing usable.`;
    default:
      return `- Skip ${p} unless the task is specifically about it: it's low-value for most work.`;
  }
}

export function tipsOf(rows: DecisionRow[], ctx: TipContext): Tip[] {
  const h = harnessOf(rows);
  const sessions = new Set(h.reads.map((r) => r.session));
  const nSessions = Math.max(1, sessions.size);
  const tips: Tip[] = [];

  // Files the agent keeps reading that a rule flagged. Secrets are excluded: naming a
  // credential file in CLAUDE.md advertises it.
  const byPath = new Map<string, { rule: string; reads: number; tokens: number; sessions: Set<string> }>();
  for (const r of h.reads) {
    if (r.value > 1 || r.rule === "unclassified" || r.rule === "secret" || r.rule === "crafted-path") continue;
    // The path is written into CLAUDE.md verbatim and read by the agent as an instruction,
    // and a repository's file names are chosen by whoever wrote it. Anything that could
    // break out of the backtick span or start a new line is never offered.
    if (!SAFE_PATH.test(r.path)) continue;
    const s = byPath.get(r.path) ?? { rule: r.rule, reads: 0, tokens: 0, sessions: new Set<string>() };
    s.reads += 1;
    s.tokens += r.tokensAvoidedEst || 0;
    s.sessions.add(r.session);
    byPath.set(r.path, s);
  }
  const heavy = [...byPath.entries()]
    .filter(([path, s]) => s.reads >= MIN_READS && s.tokens >= MIN_TOKENS && !ctx.claudeMd.includes(path))
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, MAX_CLAUDE_MD_TIPS);
  for (const [path, s] of heavy) {
    const perSession = Math.round(s.tokens / nSessions);
    tips.push({
      id: `claude-md:${path}`,
      kind: "claude-md",
      target: path,
      title: `Tell the agent to stop reading ${path}`,
      evidence: `read ${s.reads}× across ${s.sessions.size} session(s), ~${fmtK(s.tokens)} tokens, all flagged ${s.rule}`,
      change: `append to CLAUDE.md:  ${claudeMdLine(path, s.rule)}`,
      effect: `~${fmtK(perSession)} fewer tokens per session if the agent follows it; works in every mode`,
      perSession,
      rule: s.rule,
    });
  }

  // Our own mistakes: files the user overrode. Allowing them is the fix, not a saving.
  const overridden = new Map<string, number>();
  for (const r of h.overridden) overridden.set(r.path, (overridden.get(r.path) ?? 0) + 1);
  for (const [path, n] of overridden) {
    if (ctx.alwaysAllow.includes(path) || !SAFE_PATH.test(path)) continue;
    tips.push({
      id: `allow:${path}`,
      kind: "allow",
      target: path,
      title: `Stop flagging ${path}`,
      evidence: `you overrode snout on it ${n} time(s) — snout was wrong`,
      change: `add "${path}" to alwaysAllow in .snout/config.json`,
      effect: "never asked about or blocked again; no token effect",
      perSession: 0,
    });
  }

  // Graduating from observe: only on evidence, and only with nothing overridden.
  if (ctx.mode === "observe" && sessions.size >= 3 && h.overridden.length === 0) {
    const flagged = h.reads.reduce((a, r) => a + (r.value <= 1 && r.rule !== "unclassified" ? r.tokensAvoidedEst || 0 : 0), 0);
    const offered = h.reads.reduce((a, r) => a + Math.max(r.tokensReadEst || 0, r.tokensAvoidedEst || 0), 0);
    const share = offered > 0 ? flagged / offered : 0;
    if (share >= 0.15) {
      const perSession = Math.round(flagged / nSessions);
      tips.push({
        id: "mode:advise",
        kind: "mode",
        target: "advise",
        title: "Switch to advise mode",
        evidence: `over ${sessions.size} sessions, ${Math.round(share * 100)}% of read tokens (~${fmtK(perSession)}/session) were low-value, and you never overrode a flag`,
        change: ctx.gateInstalled
          ? `set mode "observe" → "advise" in .snout/config.json`
          : `set mode "observe" → "advise" in .snout/config.json — also needs the blocking hook, which is not installed (see /snout:mode)`,
        // Without the blocking hook, advise mode asks nothing: promising a saving would be false.
        effect: ctx.gateInstalled
          ? `the agent asks before each low-value read; up to ~${fmtK(perSession)} fewer tokens per session, each one your call`
          : "none until the blocking hook is installed — then the agent asks before each low-value read",
        perSession: ctx.gateInstalled ? perSession : 0,
      });
    }
  }

  return tips.sort((a, b) => b.perSession - a.perSession || a.id.localeCompare(b.id));
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
