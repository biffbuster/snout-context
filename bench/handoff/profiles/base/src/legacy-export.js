// The nightly CSV the payroll vendor imports: a header row, then one row per profile.
export function legacyExport(profiles) {
  const rows = profiles.map((p) => `${p.id},${JSON.stringify(p.name)}`);
  return ["id,fullname", ...rows].join("\n") + "\n";
}
