// Monthly rent in cents, split by each room's share of the floor area; the rooms pay exactly the rent.
export function splitRent(totalCents, rooms) {
  const area = rooms.reduce((a, r) => a + r.m2, 0);
  const out = Object.fromEntries(rooms.map((r) => [r.name, Math.floor((totalCents * r.m2) / area)]));
  let left = totalCents - Object.values(out).reduce((a, b) => a + b, 0);
  for (const r of rooms) if (left-- > 0) out[r.name] += 1;
  return out;
}
