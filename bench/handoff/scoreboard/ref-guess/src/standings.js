// The table: most points first, ties broken by goals scored.
const points = (r) => (r.for > r.against ? 3 : r.for === r.against ? 1 : 0);

export function standings(teams) {
  const rows = teams.map((t) => ({ name: t.name, pts: t.results.reduce((s, r) => s + points(r), 0), goals: t.results.reduce((s, r) => s + r.for, 0) }));
  return rows.sort((a, b) => b.pts - a.pts || b.goals - a.goals).map((r) => r.name);
}
