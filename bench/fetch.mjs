#!/usr/bin/env node
/**
 * Clones each pinned repo shallowly, extracts per-file metadata and the first 2 KB (what
 * tier 0 actually reads), then deletes the clone. Never keeps a full checkout on disk —
 * the corpus is metadata plus a small content sample, not a repo mirror.
 *
 * Usage:
 *   node bench/fetch.mjs                 # every repo in manifest.json
 *   node bench/fetch.mjs facebook/react  # one repo, for testing the pipeline
 *   BENCH_MAX_FILES=500 node bench/fetch.mjs
 *
 * Output: bench/corpus/<owner>__<repo>.json, one file per repo. Gitignored — this is
 * regenerated from the pinned manifest, not committed. Anyone can reproduce it because the
 * manifest pins exact commits.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const run = promisify(execFile);
const HEAD_BYTES = 2048;
const MAX_FILES = Number(process.env.BENCH_MAX_FILES || 2000);
const CORPUS_DIR = new URL("./corpus/", import.meta.url);

function readHead(path) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    closeSync(fd);
    return buf.subarray(0, n).toString("base64");
  } catch {
    return null;
  }
}

function walk(dir, root, out) {
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      walk(full, root, out);
    } else if (st.isFile()) {
      out.push({ path: relative(root, full), bytes: st.size, headB64: readHead(full) });
      if (out.length >= MAX_FILES) throw new StopWalk();
    }
  }
}
class StopWalk extends Error {}

/**
 * Downloads the exact commit as a tarball (codeload.github.com) rather than cloning. This
 * carries no git-object or history overhead — a single compressed tree of the pinned
 * commit — which matters a lot on a repo the size of torvalds/linux.
 */
async function cloneAt(owner, repo, sha) {
  const dir = mkdtempSync(join(tmpdir(), `snout-bench-${repo}-`));
  const tarPath = join(dir, "src.tar.gz");
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`;
  await run("curl", ["-fsSL", "--max-time", "180", "-o", tarPath, url]);
  await run("tar", ["xzf", tarPath, "-C", dir]);
  rmSync(tarPath);
  const [extracted] = readdirSync(dir);
  return join(dir, extracted);
}

async function fetchOne(entry) {
  const { owner, repo, commit } = entry;
  const slug = `${owner}__${repo}`;
  let dir;
  try {
    dir = await cloneAt(owner, repo, commit);
    // A tarball fetched by exact SHA is that SHA's tree by construction — no rev-parse needed.
    const actualSha = commit;
    const files = [];
    try {
      walk(dir, dir, files);
    } catch (e) {
      if (!(e instanceof StopWalk)) throw e;
    }
    if (!existsSync(CORPUS_DIR)) mkdirSync(CORPUS_DIR, { recursive: true });
    writeFileSync(
      new URL(`./${slug}.json`, CORPUS_DIR),
      JSON.stringify({ owner, repo, pinnedCommit: commit, fetchedCommit: actualSha, fetchedAt: new Date().toISOString(), fileCount: files.length, truncated: files.length >= MAX_FILES, files }),
    );
    return { slug, ok: true, files: files.length };
  } catch (err) {
    return { slug, ok: false, error: err.message };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  const only = process.argv[2];
  const repos = only ? manifest.repos.filter((r) => `${r.owner}/${r.repo}` === only) : manifest.repos;
  if (only && repos.length === 0) {
    console.error(`no manifest entry matches ${only}`);
    process.exitCode = 1;
    return;
  }

  let done = 0;
  const failed = [];
  for (const entry of repos) {
    const label = `${entry.owner}/${entry.repo}`;
    process.stderr.write(`[${++done}/${repos.length}] ${label} ... `);
    const r = await fetchOne(entry);
    if (r.ok) {
      process.stderr.write(`${r.files} files\n`);
    } else {
      process.stderr.write(`FAILED: ${r.error}\n`);
      failed.push({ label, error: r.error });
    }
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} repo(s) failed:`);
    for (const f of failed) console.error(`  ${f.label}: ${f.error}`);
  }
  console.error(`\nDone: ${repos.length - failed.length}/${repos.length} written to bench/corpus/`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main();
