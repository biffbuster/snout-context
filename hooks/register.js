// Snout's band above the prompt (Claude Code mods): context used, tokens Snout kept out of this
// session, and what memory holds for the repo. It only reads Snout's local records under .snout/;
// it sends nothing and changes nothing the agent sees. Shown only in a repo where Snout records.
// Claude Code versions without mods ignore this file; the command hooks in hooks.json still run.

let line = null;

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

async function read($, path) {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}

/** Recomputed at session start and after each turn, never while drawing. */
async function refresh($) {
  const root = (await $.session.root()) || (await $.session.cwd());
  const dir = `${root}/.snout`;
  if (!(await $.fs.exists(dir))) return (line = null);
  const session = await $.session.id();
  let saved = 0;
  let flagged = 0;
  const ledger = await read($, `${dir}/ledger.jsonl`);
  for (const raw of (ledger ?? "").split("\n")) {
    if (!raw.includes(session)) continue;
    try {
      const r = JSON.parse(raw);
      // Same rule as the report: a row counts when Snout flagged the content (value 0 or 1).
      if (r.session !== session || !(r.value <= 1) || r.rule === "unclassified") continue;
      if (r.mode === "enforce" && r.decision !== "allow") saved += r.tokensAvoidedEst || 0;
      else flagged += r.tokensAvoidedEst || 0;
    } catch {}
  }
  let cards = 0;
  try {
    cards = (await $.fs.list(`${dir}/memory`)).filter((f) => String(f.name ?? f).endsWith(".json") && !String(f.name ?? f).startsWith("preferences")).length;
  } catch {}
  let prefs = 0;
  try {
    prefs = JSON.parse((await read($, `${dir}/memory/preferences.json`)) ?? "{}").prefs?.length ?? 0;
  } catch {}
  const u = await $.session.usage();
  const parts = [];
  if (u?.context?.window) parts.push(`context ${Math.round(u.context.percent)}% of ${fmt(u.context.window)}`);
  parts.push(saved || !flagged ? `saved ~${fmt(saved)} tokens` : `~${fmt(flagged)} tokens flagged (observe)`);
  parts.push(`memory ${cards} session${cards === 1 ? "" : "s"}${prefs ? ` · ${prefs} preference${prefs === 1 ? "" : "s"}` : ""}`);
  line = `snout · ${parts.join(" · ")}`;
}

async function update($, e, next) {
  try {
    await refresh($);
    await $.ui.invalidate("ui.render");
  } catch {
    line = null;
  }
  return next(e);
}

export function register(on) {
  on("session.start", update);
  on("turn.complete", update);

  on("ui.render", { component: "AbovePrompt" }, band);
}

async function band($, e, next) {
  if (!line) return next(e);
  const { Box, Text } = $.ui.resolve(e);
  const width = e.props?.bodyColumns ?? 80;
  const text = line.length > width ? `${line.slice(0, width - 1)}…` : line;
  // Keep what other mods draw in the band, under this line.
  const theirs = await next(e);
  return Box({ flexDirection: "column", children: [Text({ dimColor: true, children: [text] }), ...(theirs ? [theirs] : [])] });
}
