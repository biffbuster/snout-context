#!/usr/bin/env node
/**
 * Development check for file history notes (memoryFileHistory; free, local, read only). For every
 * validated task: at its base, the notes Snout would give for the fix's source files (a stand-in for the
 * files an agent opens on the way to the fix), their size, and, for the tasks bench/history-dependence.mjs
 * labels history-dependent, whether a note lists the commit that last changed the fix's lines. That commit
 * is a likely cause, not a verified one. These tasks were used in development: no claim comes from here.
 *
 *   node bench/file-history-check.mjs --tasks bench/memory-tasks-core.json --labels bench/ab-results/history-dependence-core.json [--clone ~/.snout-bench/clones/core]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "..");
const { fileHistoryLine, isSourceFile, FILE_HISTORY_COMMITS, FILE_HISTORY_DAYS } = await import(pathToFileURL(join(REPO, "dist/lib.mjs")).href);
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []));
const spec = JSON.parse(readFileSync(resolve(REPO, String(args.tasks)), "utf8"));
const labels = JSON.parse(readFileSync(resolve(REPO, String(args.labels)), "utf8")).rows;
const clone = typeof args.clone === "string" ? resolve(args.clone.replace(/^~/, homedir())) : join(homedir(), ".snout-bench", "clones", spec.repo.split("/")[1]);
const git = (a) => spawnSync("git", ["-C", clone, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });

/** As memory/file-history.ts fileCommits, at the task's base instead of HEAD. */
function commitsAt(base, rel) {
  const since = new Date(Number(git(["log", "-1", "--format=%ct", base]).stdout.trim()) * 1000 - FILE_HISTORY_DAYS * 86_400_000).toISOString();
  return git(["log", `-n${FILE_HISTORY_COMMITS}`, `--since=${since}`, "--format=%H%x09%cs%x09%s", base, "--", rel]).stdout.split("\n").filter(Boolean)
    .map((l) => { const [sha, date, ...s] = l.split("\t"); return { sha, date, subject: s.join("\t") }; });
}

const rows = [];
for (const t of spec.tasks.filter((x) => x.validated)) {
  const label = labels.find((x) => x.id === t.id);
  const files = t.files.filter((f) => !(t.testFiles ?? []).includes(f) && isSourceFile(f));
  const notes = files.map((f) => ({ file: f, commits: commitsAt(t.base, f) })).filter((n) => n.commits.length);
  const text = notes.map((n) => fileHistoryLine(n.file, n.commits.map((c) => ({ ...c, sha: c.sha.slice(0, 7) })))).join("\n");
  const cause = label?.dependsOnHistory ? label.youngest.sha : null;
  rows.push({ id: t.id, dependsOnHistory: !!label?.dependsOnHistory, files: files.length, notes: notes.length, tokens: Math.round(Buffer.byteLength(text) / 2.74), causeShown: cause ? notes.some((n) => n.commits.some((c) => c.sha.startsWith(cause))) : null });
}
const dep = rows.filter((r) => r.dependsOnHistory), rest = rows.filter((r) => !r.dependsOnHistory);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log(`${spec.repo}: ${rows.length} validated tasks`);
for (const r of rows) console.log(`  ${r.id.padEnd(12)} ${r.dependsOnHistory ? "history" : "-      "} notes ${r.notes}/${r.files}  ~${String(r.tokens).padStart(3)} tokens${r.causeShown === null ? "" : `  likely cause ${r.causeShown ? "SHOWN" : "not shown"}`}`);
console.log(`  history-dependent: likely cause shown in ${dep.filter((r) => r.causeShown).length} of ${dep.length}; tokens median ${med(rows.map((r) => r.tokens))}, max ${Math.max(0, ...rows.map((r) => r.tokens))}; tasks with no note ${rows.filter((r) => !r.notes).length}; other tasks with a note ${rest.filter((r) => r.notes).length} of ${rest.length}`);
