#!/usr/bin/env node
/**
 * Runs tier 0 against the real-repo corpus in `bench/corpus/` (built by `fetch.mjs`).
 *
 * This is not the accuracy eval — there are no gold labels here, so it cannot report
 * precision, recall, or false-deny. What it answers is narrower and comes first: does
 * coverage hold up outside the 62 synthetic cases in `eval/dataset.mjs`, and does anything
 * in 100 real repositories break a rule that has only ever seen fixtures?
 *
 * Each file is materialized as a sparse temp file — the captured 2 KB head written for
 * real, the rest of its length created with `truncateSync` rather than written byte for
 * byte — so tier 0 runs completely unmodified: real `statSync` size, real head read, real
 * path. No production code path is touched to make this possible.
 *
 * Usage:
 *   node bench/run.mjs             # every fetched repo
 *   node bench/run.mjs --json      # same data, machine-readable
 */
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tier0, DEFAULTS, estimateTokens } from "../dist/lib.mjs";

const jsonOut = process.argv.includes("--json");
const CORPUS_DIR = new URL("./corpus/", import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const langOf = Object.fromEntries(MANIFEST.repos.map((r) => [`${r.owner}__${r.repo}`, r]));

/** Writes one corpus file's captured bytes to disk without ever touching production code's read path. */
function materialize(root, file) {
  if (file.headB64 == null) return false; // unreadable at fetch time (broken symlink, etc.) — skip
  const abs = join(root, file.path);
  mkdirSync(dirname(abs), { recursive: true });
  const head = Buffer.from(file.headB64, "base64");
  writeFileSync(abs, head);
  if (file.bytes > head.length) truncateSync(abs, file.bytes); // sparse — no extra disk cost
  return true;
}

function classify(absPath, projectDir) {
  const d = tier0({ absPath, projectDir, cfg: DEFAULTS });
  // Same convention as eval/run.mjs: no rule firing is exactly what ships as "allow,
  // unclassified" — scoring it any other way would misrepresent the product.
  return d ?? { value: 2, confidence: 0, rule: "unclassified", verdict: "allow" };
}

function newBucket() {
  return { files: 0, skipped: 0, classified: 0, byRule: new Map(), tokensOffered: 0, tokensFlagged: 0 };
}

function record(bucket, rule, value, bytes) {
  bucket.files += 1;
  const tok = estimateTokens(bytes, "");
  bucket.tokensOffered += tok;
  if (rule !== "unclassified") bucket.classified += 1;
  if (value <= 1 && rule !== "unclassified") bucket.tokensFlagged += tok;
  const s = bucket.byRule.get(rule) ?? { rule, count: 0, tokens: 0 };
  s.count += 1;
  if (value <= 1 && rule !== "unclassified") s.tokens += tok;
  bucket.byRule.set(rule, s);
}

function pct(n, d) {
  return d > 0 ? (n / d) * 100 : 0;
}

function main() {
  const slugs = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"));
  if (slugs.length === 0) {
    console.error("No corpus files found. Run `node bench/fetch.mjs` first.");
    process.exitCode = 1;
    return;
  }

  const overall = newBucket();
  const byLanguage = new Map();
  const perRepo = [];
  // The actionable output: real files with no rule opinion, ranked by size. Each one is a
  // candidate for a new rule or a gap in an existing one.
  const largestUnclassified = [];
  let truncatedRepos = 0;

  let done = 0;
  for (const slug of slugs) {
    const corpus = JSON.parse(readFileSync(new URL(slug, CORPUS_DIR), "utf8"));
    const meta = langOf[slug.replace(/\.json$/, "")] ?? {};
    const language = meta.language ?? "unknown";
    if (corpus.truncated) truncatedRepos += 1;

    const root = mkdtempSync(join(tmpdir(), "snout-bench-run-"));
    const repoBucket = newBucket();
    // Write the whole repo before classifying any of it: tier 0 reads the root .gitignore
    // (output dirs count only when ignored), so it must exist before the first file is judged.
    const written = corpus.files.filter((file) => materialize(root, file));
    repoBucket.skipped += corpus.files.length - written.length;
    for (const file of written) {
      const abs = join(root, file.path);
      const pred = classify(abs, root);
      record(repoBucket, pred.rule, pred.value, file.bytes);
      record(overall, pred.rule, pred.value, file.bytes);
      const lb = byLanguage.get(language) ?? newBucket();
      record(lb, pred.rule, pred.value, file.bytes);
      byLanguage.set(language, lb);

      if (pred.rule === "unclassified") {
        largestUnclassified.push({ repo: `${corpus.owner}/${corpus.repo}`, path: file.path, bytes: file.bytes });
      }
    }
    rmSync(root, { recursive: true, force: true });

    perRepo.push({
      repo: `${corpus.owner}/${corpus.repo}`,
      language,
      files: repoBucket.files,
      skipped: repoBucket.skipped,
      coverage: pct(repoBucket.classified, repoBucket.files),
      truncated: Boolean(corpus.truncated),
    });

    done += 1;
    process.stderr.write(`\r[${done}/${slugs.length}] scored`);
  }
  process.stderr.write("\n");

  largestUnclassified.sort((a, b) => b.bytes - a.bytes);

  const report = {
    measuredAt: new Date().toISOString(),
    repos: slugs.length,
    truncatedRepos,
    overall: {
      files: overall.files,
      skipped: overall.skipped,
      coveragePct: pct(overall.classified, overall.files),
      byRule: [...overall.byRule.values()].sort((a, b) => b.count - a.count),
    },
    byLanguage: [...byLanguage.entries()]
      .map(([language, b]) => ({ language, files: b.files, coveragePct: pct(b.classified, b.files) }))
      .sort((a, b) => b.files - a.files),
    perRepo: perRepo.sort((a, b) => a.coverage - b.coverage), // worst coverage first — where to look
    largestUnclassified: largestUnclassified.slice(0, 20),
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`snout bench — tier 0 against ${report.repos} real repos, measured ${report.measuredAt}`);
  console.log(`No gold labels here — this is coverage and crash-surface, not accuracy. See eval/ for that.\n`);

  console.log(`OVERALL`);
  console.log(`  ${report.overall.files} files scored, ${report.overall.skipped} skipped (unreadable at fetch time)`);
  console.log(`  coverage: ${report.overall.coveragePct.toFixed(1)}% (a rule had an opinion)`);
  if (report.truncatedRepos > 0) {
    console.log(`  ${report.truncatedRepos} repo(s) hit the ${process.env.BENCH_MAX_FILES || 2000}-file cap — coverage on those undercounts the full tree`);
  }
  console.log("");

  console.log(`BY RULE (whole corpus)`);
  for (const s of report.overall.byRule.slice(0, 15)) {
    console.log(`  ${s.rule.padEnd(16)} ${String(s.count).padStart(6)} files`);
  }
  console.log("");

  console.log(`BY LANGUAGE — coverage`);
  for (const l of report.byLanguage) {
    console.log(`  ${l.language.padEnd(12)} ${String(l.files).padStart(6)} files   ${l.coveragePct.toFixed(1).padStart(5)}%`);
  }
  console.log("");

  console.log(`LOWEST-COVERAGE REPOS (top 10 — where a language or shape gap would show up first)`);
  for (const r of report.perRepo.slice(0, 10)) {
    console.log(`  ${r.coverage.toFixed(1).padStart(5)}%  ${r.repo.padEnd(30)} ${r.language.padEnd(10)} ${r.files} files${r.truncated ? "  (truncated)" : ""}`);
  }
  console.log("");

  console.log(`LARGEST UNCLASSIFIED FILES (candidates for a new or wider rule)`);
  for (const f of report.largestUnclassified.slice(0, 15)) {
    console.log(`  ${(f.bytes / 1024).toFixed(0).padStart(6)} KB  ${f.repo}: ${f.path}`);
  }
}

main();
