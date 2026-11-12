#!/usr/bin/env node
/**
 * Development only: history search as shipped (rankHistory, exactIn from dist/lib.mjs) on the import
 * as-of development sets (vite, django), three ways: words only, with meaning, with meaning and the
 * files an agent would know. Reports ranking (right commit among the first five) and admission
 * (answered with the right commit, answered wrongly, silent), on answerable tasks and on questions
 * nothing here answers (the controls, and the other set's questions). Then the admission rule's
 * thresholds over a coarse grid, on the same ranked records, to check the shipped ones.
 *
 *   SNOUT_MODEL_DIR=<model> node bench/history-calibrate.mjs
 *
 * Needs the imports of bench/history-diagnose.mjs and the record vectors and known files of
 * bench/history-retrieval-proto.mjs (same record text as vectorText, files from the tree before each task).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = join(tmpdir(), "snout-hist");
const home = (p) => p.replace(/^~(?=\/|$)/, homedir());
const git = (cwd, a) => spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true }).stdout ?? "";
const lib = await import(pathToFileURL(join(ROOT, "dist", "lib.mjs")).href);
const embed = await lib.loadEmbedder();
const unpack = (s) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

const sets = ["vite", "django"].map((set) => {
  const freeze = JSON.parse(readFileSync(join(ROOT, "bench", "import-asof", set, "freeze.json"), "utf8"));
  const repo = home(freeze.repo.path);
  const dir = join(WORK, set);
  const stores = lib.storesFor(repo, join(dir, "snout"), join(dir, "config"));
  const records = lib.readHistory(stores.historyDir, stores.indexFile).filter((r) => r.kind === "commit");
  const vec = JSON.parse(readFileSync(join(dir, "vectors.json"), "utf8"));
  const vecs = new Map(records.map((r) => [r.id, unpack(vec[r.sha])]));
  const known = JSON.parse(readFileSync(join(dir, "known.json"), "utf8"));
  const files = new Map();
  for (const chunk of git(repo, ["log", "--all", "--no-merges", "--since=10 months ago", "--format=%x1e%H", "--name-only", "--no-renames"]).split("\x1e")) {
    const [sha, ...fs] = chunk.trim().split("\n"); if (sha) files.set(sha.trim(), fs.map((f) => f.trim()).filter(Boolean));
  }
  return { set, freeze, records, vecs, known, files };
});

const MODES = { words: { meaning: false, files: false }, meaning: { meaning: true, files: false }, "meaning+files": { meaning: true, files: true } };
const out = {};
for (const S of sets) {
  const qv = await embed(S.freeze.tasks.map((t) => lib.QUERY_PREFIX + t.query));
  const other = sets.find((o) => o !== S);
  const negs = [...S.freeze.controls.map((c) => ({ query: c.query, kind: "control" })), ...other.freeze.tasks.map((t) => ({ query: t.query, kind: `cross:${other.set}` }))];
  const nv = await embed(negs.map((n) => lib.QUERY_PREFIX + n.query));
  const run = (text, qvec, cut, exclude, files, mode) => {
    const visible = S.records.filter((r) => (!cut || r.at <= cut) && r.sha !== exclude);
    return lib.rankHistory(visible, { text, eligible: 5, exact: lib.exactIn(text), ...(MODES[mode].meaning ? { qvec, vecOf: (r) => S.vecs.get(r.id) } : {}), ...(MODES[mode].files && files.length ? { files } : {}) });
  };
  const res = { tasks: [], negatives: [] };
  S.freeze.tasks.forEach((t, i) => {
    const touches = (r) => (S.files.get(r.sha) ?? r.files).some((f) => t.gold.includes(f));
    const answerable = S.records.some((r) => r.at <= t.cut && r.sha !== t.sha && touches(r));
    const row = { sha: t.sha.slice(0, 10), answerable, modes: {} };
    for (const mode of Object.keys(MODES)) {
      const ranked = run(t.query, qv[i], t.cut, t.sha, S.known[t.sha] ?? [], mode);
      row.modes[mode] = { top: ranked.slice(0, 5).map((x) => ({ gold: touches(x.r), cos: x.cos, cover: x.cover, words: x.words, exact: x.exact, admitted: x.admitted })), admittedBeyond: ranked.slice(5).filter((x) => x.admitted).length };
    }
    res.tasks.push(row);
  });
  negs.forEach((n, i) => {
    const row = { kind: n.kind, query: n.query.slice(0, 80), modes: {} };
    for (const mode of ["words", "meaning"]) row.modes[mode] = { top: run(n.query, nv[i], null, null, [], mode).slice(0, 5).map((x) => ({ cos: x.cos, cover: x.cover, words: x.words, exact: x.exact, admitted: x.admitted })) };
    res.negatives.push(row);
  });
  out[S.set] = res;
}
writeFileSync(join(WORK, "calibrate.json"), JSON.stringify(out, null, 1));

const report = (pick, label) => {
  for (const mode of Object.keys(MODES)) {
    let pos = 0, rank5 = 0, ok = 0, wrong = 0, shown = 0, neg = 0, negAns = 0;
    for (const s of Object.keys(out)) {
      for (const t of out[s].tasks.filter((x) => x.answerable)) { pos++; const m = t.modes[mode]; const a = m.top.filter(pick(mode)); shown += a.length; if (m.top.some((x) => x.gold)) rank5++; if (a.some((x) => x.gold)) ok++; else if (a.length) wrong++; }
      for (const n of out[s].negatives) { const m = n.modes[mode.replace("+files", "")]; neg++; if (m.top.some(pick(mode))) negAns++; }
    }
    console.log(`${label.padEnd(9)} ${mode.padEnd(14)} ranked top5 ${rank5}/${pos} | answered right ${ok}/${pos} | answered wrong ${wrong} | unanswerable answered ${negAns}/${neg} | shown ${(shown / pos).toFixed(1)}`);
  }
};
report(() => (x) => x.admitted, "shipped");

// Coarse grid over the meaning rule and the words rule, on the same ranked records.
const grid = [];
for (const mA of [0.72, 0.74, 0.76]) for (const mW of [0.66, 0.68, 0.7]) for (const cW of [0.25, 0.3, 0.35]) for (const cA of [0.35, 0.4, 0.45]) {
  const rule = (x) => x.exact || (x.cos !== undefined ? x.cos >= mA || (x.cos >= mW && x.cover >= cW) : false) || (x.cover >= cA && x.words >= 2);
  let ok = 0, neg = 0, na = 0, pos = 0, okW = 0, naW = 0;
  for (const s of Object.keys(out)) {
    for (const t of out[s].tasks.filter((x) => x.answerable)) { pos++; if (t.modes.meaning.top.filter(rule).some((x) => x.gold)) ok++; if (t.modes.words.top.filter(rule).some((x) => x.gold)) okW++; }
    for (const n of out[s].negatives) { neg++; if (n.modes.meaning.top.some(rule)) na++; if (n.modes.words.top.some(rule)) naW++; }
  }
  grid.push({ mA, mW, cW, cA, ok, na, okW, naW, pos, neg });
}
const fits = grid.filter((g) => g.na / g.neg <= 0.1 && g.naW / g.neg <= 0.1).sort((a, b) => b.ok - a.ok || b.okW - a.okW || a.na - b.na);
console.log("\nbest grid rules with at most 10% of unanswerable questions answered (meaning and words-only):");
for (const g of fits.slice(0, 6)) console.log(`  meaning>=${g.mA} or (meaning>=${g.mW} and cover>=${g.cW}); words-only cover>=${g.cA} | meaning: right ${g.ok}/${g.pos}, unanswerable ${g.na}/${g.neg} | words-only: right ${g.okW}/${g.pos}, unanswerable ${g.naW}/${g.neg}`);
