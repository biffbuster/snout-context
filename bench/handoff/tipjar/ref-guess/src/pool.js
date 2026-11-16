// Pools tips by hours worked; cents left after rounding go to the first names.
export function poolByHours(totalCents, staff) {
  const all = staff.reduce((a, s) => a + s.hours, 0);
  const out = Object.fromEntries(staff.map((s) => [s.name, Math.floor((totalCents * s.hours) / all)]));
  let left = totalCents - Object.values(out).reduce((a, b) => a + b, 0);
  for (const s of staff) if (left-- > 0) out[s.name] += 1;
  return out;
}
