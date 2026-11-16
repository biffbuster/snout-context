// Pools tips by hours worked. Kitchen hours count half (it has its own pool); cents left after
// rounding down go to whoever worked the most hours.
export function poolByHours(totalCents, staff) {
  const weight = (s) => (s.role === "kitchen" ? s.hours / 2 : s.hours);
  const all = staff.reduce((a, s) => a + weight(s), 0);
  const out = Object.fromEntries(staff.map((s) => [s.name, Math.floor((totalCents * weight(s)) / all)]));
  const most = staff.reduce((a, s) => (s.hours > a.hours ? s : a));
  out[most.name] += totalCents - Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
