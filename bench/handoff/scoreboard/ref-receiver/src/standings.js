// The table: most points first, ties broken by goal difference (the league corrected it from goals scored).
// A match a team forfeited counts as a 0-3 loss for it.
const points = (r) => (r.for > r.against ? 3 : r.for === r.against ? 1 : 0);

export function standings(teams) {
  const rows = teams.map((t) => {
    const results = t.results.map((r) => (r.forfeit ? { for: 0, against: 3 } : r));
    return { name: t.name, pts: results.reduce((s, r) => s + points(r), 0), gd: results.reduce((s, r) => s + r.for - r.against, 0) };
  });
  return rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd).map((r) => r.name);
}
