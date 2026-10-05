#!/usr/bin/env node
/**
 * Resolves every entry in manifest.source.json to its current HEAD commit and writes the
 * frozen manifest.json. Run this once to create the corpus definition, and again only when
 * deliberately re-pinning to newer commits — never hand-edit manifest.json.
 *
 * Uses `git ls-remote`, not the GitHub REST API: it resolves a ref without touching the
 * unauthenticated 60-requests/hour API limit, and a failure here means the repo does not
 * exist or has moved, which is exactly what we want caught before it enters the corpus.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CONCURRENCY = 8;

async function resolveHead(owner, repo) {
  const url = `https://github.com/${owner}/${repo}.git`;
  try {
    const { stdout } = await run("git", ["ls-remote", url, "HEAD"], { timeout: 20_000 });
    const sha = stdout.split("\t")[0]?.trim();
    if (!sha || sha.length !== 40) throw new Error(`unexpected ls-remote output: ${stdout}`);
    return { ok: true, sha };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const source = JSON.parse(readFileSync(new URL("./manifest.source.json", import.meta.url), "utf8"));
  const pinnedAt = new Date().toISOString();
  let done = 0;

  const resolved = await pool(source.repos, CONCURRENCY, async (r) => {
    const head = await resolveHead(r.owner, r.repo);
    done += 1;
    process.stderr.write(`\r${done}/${source.repos.length}`);
    if (!head.ok) {
      return { ...r, commit: null, error: head.error };
    }
    return { ...r, commit: head.sha, pinnedAt };
  });
  process.stderr.write("\n");

  const failed = resolved.filter((r) => !r.commit);
  if (failed.length > 0) {
    console.error(`\n${failed.length} repo(s) failed to resolve:`);
    for (const f of failed) console.error(`  ${f.owner}/${f.repo}: ${f.error}`);
    console.error("\nFix or remove these in manifest.source.json, then re-run.");
  }

  const manifest = {
    generatedBy: "bench/pin.mjs",
    generatedAt: pinnedAt,
    count: resolved.length,
    resolved: resolved.length - failed.length,
    repos: resolved,
  };
  writeFileSync(new URL("./manifest.json", import.meta.url), JSON.stringify(manifest, null, 2) + "\n");
  console.error(`\nWrote bench/manifest.json — ${manifest.resolved}/${manifest.count} pinned.`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main();
