#!/usr/bin/env node
/**
 * The delivery judge test, offline (docs/memory-gates.md, "Judge test"). For every Gate 3 prompt
 * scored for delivery, every eligible note (admitted to this viewer, verified, not held back, not
 * already said by the prompt) is judged against the prompt by one of two local judges:
 *
 *   embed   cosine similarity of the prompt and the note (bge-small, the optional memory model)
 *   llm     a small instruction model (Qwen2.5-0.5B-Instruct, q8) asked whether an agent doing the
 *           task needs the note; the score is P(Yes) against P(No) for its next word
 *
 * Reported separately, per threshold:
 *   available   the right note is among the eligible notes at all (or today's left-off text answers)
 *   chosen      the judge's best accepted note is the right one (answerable prompts)
 *   none        the judge accepts no note (unanswerable prompts)
 * and the design: today's notes as they are, plus, when today shows none, the notes the judge
 * accepts, best first. Against today: right answers gained and lost, records newly shown on
 * unanswerable prompts.
 *
 * Reads each set's last replayed project (`~/.snout-bench/g3[-set]`) and today's results
 * (`results-<--today>.json`). No network: the models must already be in --models.
 *
 *   node bench/memory-judge.mjs --judge embed|llm [--sets older|unseen13|<a,b>] [--today rr-nomodel]
 *                               [--models dir] [--scores file.json] [--out file.json]
 *
 * --scores caches each note's score per prompt, so a later run only sweeps thresholds.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const flag = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const OLDER = ["", "unseen", "unseen2", "unseen3", "unseen4", "unseen5", "unseen6", "unseen7", "unseen8", "unseen9", "unseen10", "unseen11", "unseen12"];
const SETS = ((s) => (s === "older" ? OLDER : s.split(",").map((x) => (x === "main" ? "" : x))))(flag("--sets", "older"));
const JUDGE = flag("--judge", "embed");
const TODAY = flag("--today", "rr-nomodel");
const MODEL_DIR = flag("--models", join(homedir(), ".snout-bench", "model-cfg", "model"));
const SCORES = flag("--scores");
const LLM = "onnx-community/Qwen2.5-0.5B-Instruct";

const lib = await import("../dist/lib.mjs");
const { recallable, sessionViewer, storesFor, verified, heldBack, rankedFit, QUERY_PREFIX } = lib;
const work = (set) => join(homedir(), ".snout-bench", set ? `g3-${set}` : "g3");
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const NOTE_LINE = /^- (?:convention|decision|gotcha|preference|command|fact): /;

// ---------------------------------------------------------------- the cases

const cases = [];
for (const set of SETS) {
  const dir = join(ROOT, "bench", "recall-gate", set);
  const history = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
  const { prompts } = JSON.parse(readFileSync(join(dir, "prompts.json"), "utf8"));
  const today = JSON.parse(readFileSync(join(dir, `results-${TODAY}.json`), "utf8"));
  const re = Object.fromEntries(Object.entries(history.facts).map(([k, f]) => [k, new RegExp(f.pattern)]));
  const project = join(work(set), history.project.name);
  if (!existsSync(project)) throw new Error(`${project} is missing: run bench/recall-gate.mjs${set ? ` --set ${set}` : ""} first`);
  process.env.SNOUT_CONFIG_DIR = join(work(set), "cfg");
  const stores = storesFor(project, join(project, ".snout"), join(work(set), "cfg"));
  const admitted = recallable(stores, [sessionViewer(project, stores.project, {})]).filter((o) => !heldBack(o, project));
  for (const p of prompts) {
    const expect = p.delivery;
    if (!Array.isArray(expect) && expect !== "silent") continue;
    const row = today.rows.find((r) => r.id === p.id).paths.delivery;
    const first = row.text.split("\n").find((l) => /^- /.test(l)) ?? "";
    const isRight = (text) => Array.isArray(expect) && expect.some((k) => re[k].test(text));
    const eligible = admitted.filter((o) => verified(o) && !norm(p.prompt).includes(norm(o.text)));
    cases.push({
      set: set || "main", id: p.id, prompt: p.prompt, expect,
      todayRight: row.answered === true, todayShown: row.shown,
      leftOff: !!first && !NOTE_LINE.test(first),
      todayNotes: rankedFit(p.prompt, admitted, {}).map((f) => f.note.id),
      notes: eligible.map((o) => ({ id: o.id, text: o.text, right: isRight(o.text) })),
    });
  }
}

// ---------------------------------------------------------------- the judges

const loadLib = async () => {
  const entry = createRequire(join(MODEL_DIR, "package.json")).resolve("@huggingface/transformers");
  const mod = await import(pathToFileURL(entry).href);
  const m = mod.env ? mod : mod.default;
  m.env.localModelPath = join(MODEL_DIR, "models") + "/";
  m.env.allowRemoteModels = false;
  return m;
};

async function embedJudge() {
  const embed = await lib.loadEmbedder(MODEL_DIR);
  const cache = new Map();
  return async (prompt, notes) => {
    const missing = [...new Set(notes.map((n) => n.text))].filter((t) => !cache.has(t));
    if (missing.length) (await embed(missing)).forEach((v, i) => cache.set(missing[i], v));
    const [q] = await embed([`${QUERY_PREFIX}${prompt}`]);
    return notes.map((n) => { const v = cache.get(n.text); let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * q[i]; return s; });
  };
}

async function llmJudge() {
  const m = await loadLib();
  const tokenizer = await m.AutoTokenizer.from_pretrained(LLM);
  const model = await m.AutoModelForCausalLM.from_pretrained(LLM, { dtype: "q8" });
  const yes = tokenizer.encode("Yes", { add_special_tokens: false })[0];
  const no = tokenizer.encode("No", { add_special_tokens: false })[0];
  return async (prompt, notes) => {
    const out = [];
    for (const n of notes) {
      const messages = [
        { role: "system", content: "You decide whether a note saved from earlier work in a software project is needed for a coding task." },
        { role: "user", content: `Task: ${prompt}\n\nSaved note: "${n.text}"\n\nWould an agent doing this task need this note to do it correctly? Answer Yes or No.` },
      ];
      const text = tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
      const inputs = tokenizer(text);
      const { logits } = await model(inputs);
      const [, len, vocab] = logits.dims;
      const last = logits.data.subarray((len - 1) * vocab, len * vocab);
      const y = last[yes], x = last[no];
      out.push(1 / (1 + Math.exp(x - y)));
    }
    return out;
  };
}

const cached = SCORES && existsSync(SCORES) ? JSON.parse(readFileSync(SCORES, "utf8")) : {};
const key = (c) => `${c.set}/${c.id}`;
const need = cases.filter((c) => c.notes.some((n) => cached[key(c)]?.[n.id] === undefined));
let latency = null;
if (need.length) {
  const t0 = performance.now();
  const judge = JUDGE === "llm" ? await llmJudge() : await embedJudge();
  const loadMs = Math.round(performance.now() - t0);
  const rss0 = process.memoryUsage().rss;
  const per = [];
  for (const c of need) {
    const t = performance.now();
    const s = await judge(c.prompt, c.notes);
    per.push({ ms: performance.now() - t, notes: c.notes.length });
    cached[key(c)] = Object.fromEntries(c.notes.map((n, i) => [n.id, s[i]]));
  }
  const ms = per.map((x) => x.ms).sort((a, b) => a - b);
  latency = { loadMs, medianMs: Math.round(ms[Math.floor(ms.length / 2)]), p95Ms: Math.round(ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)]), notesMedian: per.map((x) => x.notes).sort((a, b) => a - b)[Math.floor(per.length / 2)], rssMB: Math.round(process.memoryUsage().rss / 2 ** 20), rssGrowthMB: Math.round((process.memoryUsage().rss - rss0) / 2 ** 20) };
  if (SCORES) writeFileSync(SCORES, JSON.stringify(cached));
}
for (const c of cases) c.notes.forEach((n) => { n.s = cached[key(c)][n.id]; });

// ---------------------------------------------------------------- scoring

const answerable = cases.filter((c) => Array.isArray(c.expect));
const unanswerable = cases.filter((c) => c.expect === "silent");
const available = answerable.filter((c) => c.leftOff ? c.todayRight : c.notes.some((n) => n.right));
console.log(`${JUDGE} judge, ${cases.length} delivery checks on ${SETS.length} sets (${answerable.length} answerable, ${unanswerable.length} unanswerable); eligible notes per prompt: median ${[...cases.map((c) => c.notes.length)].sort((a, b) => a - b)[Math.floor(cases.length / 2)]}`);
console.log(`today: right first ${answerable.filter((c) => c.todayRight).length}/${answerable.length}; silent ${unanswerable.filter((c) => !c.todayShown).length}/${unanswerable.length}`);
console.log(`available: the right note is eligible (or today's left-off text answers) in ${available.length}/${answerable.length}`);
if (latency) console.log(`latency: load ${latency.loadMs} ms; per prompt ${latency.medianMs} ms median, ${latency.p95Ms} ms p95 (${latency.notesMedian} notes median); memory ${latency.rssMB} MB`);

const all = cases.flatMap((c) => c.notes.map((n) => n.s)).sort((a, b) => a - b);
const thresholds = [...new Set(Array.from({ length: 40 }, (_, i) => all[Math.floor((i / 40) * all.length)]).concat(JUDGE === "llm" ? [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99] : [0.6, 0.65, 0.7, 0.72, 0.75, 0.78, 0.8, 0.85]))].sort((a, b) => a - b);

function evaluate(t) {
  const r = { t, chosen: 0, none: 0, right: 0, gained: [], lost: [], newlyShown: [], under: [] };
  const perSet = {};
  for (const c of cases) {
    const accepted = c.notes.filter((n) => n.s >= t).sort((a, b) => b.s - a.s);
    const todayHas = c.todayNotes.length > 0 || c.leftOff;
    const designFirst = todayHas ? null : accepted[0];
    if (Array.isArray(c.expect)) {
      if (accepted[0]?.right) r.chosen++;
      const now = todayHas ? c.todayRight : !!designFirst?.right;
      if (now) r.right++;
      if (now && !c.todayRight) r.gained.push(`${c.set}/${c.id}`);
      if (!now && c.todayRight) r.lost.push(`${c.set}/${c.id}`);
      const s = (perSet[c.set] ??= { ok: 0, of: 0 }); s.of++; s.ok += now;
    } else {
      if (!accepted.length) r.none++;
      if (!c.todayShown && designFirst) r.newlyShown.push(`${c.set}/${c.id}`);
    }
  }
  r.under = Object.entries(perSet).filter(([, v]) => v.ok / v.of < 0.9).map(([k, v]) => `${k} ${v.ok}/${v.of}`);
  return r;
}

const sweep = thresholds.map(evaluate);
console.log(`\nthreshold   chosen (judge alone)   none correct   design right first   gained  lost  newly shown`);
for (const r of sweep) console.log(`${r.t.toFixed(3).padStart(8)}   ${String(r.chosen).padStart(4)}/${answerable.length}             ${String(r.none).padStart(3)}/${unanswerable.length}         ${String(r.right).padStart(4)}/${answerable.length}            +${r.gained.length}     -${r.lost.length}    ${r.newlyShown.length}`);
const safe = sweep.filter((r) => !r.lost.length && !r.newlyShown.length).sort((a, b) => b.right - a.right || b.t - a.t)[0];
if (safe) {
  console.log(`\nbest threshold meeting the safety criteria (no loss, nothing newly shown on an unanswerable prompt): ${safe.t.toFixed(3)}`);
  console.log(`  design right first ${safe.right}/${answerable.length}; gained ${safe.gained.join(" ") || "none"}; sets under 90%: ${safe.under.join(", ") || "none"}`);
} else console.log("\nno threshold meets the safety criteria");
const out = flag("--out");
if (out) writeFileSync(out, JSON.stringify({ judge: JUDGE, sets: SETS.map((s) => s || "main"), today: TODAY, latency, available: available.length, answerable: answerable.length, unanswerable: unanswerable.length, sweep, best: safe ?? null, cases }, null, 1) + "\n");
