#!/usr/bin/env node
/**
 * What restarting a session from a short brief would have cost, replayed on this machine's Claude
 * Code logs. Nothing is sent anywhere and nothing is changed.
 *
 * Each request's real usage gives its context (cache read + cache write + input) and what it added
 * (cache write + input). The replay follows the same session, but whenever its context reaches the
 * threshold it starts again from the fixed part (the session's first request: system prompt, tools,
 * first prompt) plus a brief of --brief tokens. A real compaction still happens where it did.
 *
 * Cost is in relative list prices: a cached token read 0.1, a token newly cached 1.25, output 5.
 * A restart pays to cache its new start, and then --reacquire of what it dropped again (as reads the
 * agent makes to find its place). That share is the unknown: no log shows what a fresh session
 * would have needed back, nor whether it would finish the work as well. Only a live A/B can.
 *
 * --summary N: the restart is a compaction, which reads the whole context once and writes an N-token
 * summary (Claude Code's own, triggered earlier); 0 for a restart from Snout's records, which no model writes.
 *
 *   node bench/reset-sim.mjs [--claude dir,...] [--min-requests 20] [--brief 5000] [--summary 0]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MIN_REQUESTS = Number(flag("--min-requests", 20));
const BRIEF = Number(flag("--brief", 5000));
const SUMMARY = Number(flag("--summary", 0));
const THRESHOLDS = [50_000, 100_000, 150_000, 200_000, 300_000];
const REACQUIRE = [0, 0.25, 0.5];
const PRICE = { read: 0.1, write: 1.25, out: 5 };

const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl") && !/[\\/]subagents[\\/]/.test(f)).map((f) => join(dir, f)) : []);
const rows = (f) => readFileSync(f, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });

/** One session's requests: context and new tokens for each, from its own usage records. */
function requests(file) {
  const seen = new Set();
  const out = [];
  for (const o of rows(file)) {
    if (o.type !== "assistant" || o.isSidechain) continue;
    const rid = o.requestId ?? o.message?.id;
    if (!rid || seen.has(rid)) continue;
    seen.add(rid);
    const u = o.message?.usage ?? {};
    const added = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    out.push({ context: added + (u.cache_read_input_tokens ?? 0), added, output: u.output_tokens ?? 0 });
  }
  return out;
}

const actualCost = (rs) => rs.reduce((a, r) => a + (r.context - r.added) * PRICE.read + r.added * PRICE.write + r.output * PRICE.out, 0);

function simulate(rs, threshold, reacquire) {
  const fixed = rs[0].context;
  let ctx = rs[0].context, cost = actualCost(rs.slice(0, 1)), resets = 0;
  for (let i = 1; i < rs.length; i++) {
    const r = rs[i], prev = rs[i - 1];
    // What this request added beyond the last one; a real compaction (context fell) happens here too.
    const growth = r.context - prev.context;
    let added = r.added;
    if (growth < 0) ctx = Math.min(ctx, r.context);
    else ctx += growth;
    const start = fixed + BRIEF;
    // Only once the context is well past where a restart would begin (a session whose fixed part is
    // already near the threshold would otherwise restart on every request).
    if (ctx >= Math.max(threshold, 2 * start)) {
      if (SUMMARY) cost += ctx * PRICE.read + SUMMARY * PRICE.out;
      const back = Math.max(0, ctx - start) * reacquire;
      resets++;
      ctx = start + back;
      added += start + back; // the new session caches its start, then the reads it makes again
    }
    const carried = Math.max(0, ctx - added);
    cost += carried * PRICE.read + Math.min(added, ctx) * PRICE.write + r.output * PRICE.out;
  }
  return { cost, resets };
}

const dirs = (flag("--claude") ?? "").split(",").filter(Boolean);
const sessions = (dirs.length ? dirs : [join(homedir(), ".claude", "projects")]).flatMap(walk).map(requests).filter((rs) => rs.length >= MIN_REQUESTS);
const actual = sessions.reduce((a, rs) => a + actualCost(rs), 0);
const peak = sessions.map((rs) => Math.max(...rs.map((r) => r.context))).sort((a, b) => a - b);
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
console.log(`Claude Code: ${sessions.length} sessions with ${MIN_REQUESTS}+ requests, ${sessions.reduce((a, rs) => a + rs.length, 0)} requests; peak context per session: median ${fmt(peak[Math.floor(peak.length / 2)])}, max ${fmt(peak.at(-1))}`);
console.log(`Restart from the fixed start plus a ${fmt(BRIEF)}-token brief when the context reaches the threshold. Cost against what the sessions cost (relative list prices, output unchanged):\n`);
console.log(`  ${"threshold".padEnd(10)} ${"restarts".padStart(8)}   ${REACQUIRE.map((x) => `re-read ${Math.round(x * 100)}%`.padStart(13)).join("")}`);
for (const t of THRESHOLDS) {
  const res = REACQUIRE.map((x) => sessions.reduce((a, rs) => { const s = simulate(rs, t, x); return { cost: a.cost + s.cost, resets: a.resets + s.resets }; }, { cost: 0, resets: 0 }));
  console.log(`  ${fmt(t).padEnd(10)} ${String(res[0].resets).padStart(8)}   ${res.map((r) => `${r.cost <= actual ? "−" : "+"}${Math.abs(Math.round((100 * (r.cost - actual)) / actual))}%`.padStart(13)).join("")}`);
}
