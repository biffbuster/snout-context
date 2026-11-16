// Monthly rent in cents, split by each room's share of the floor area.
export function splitRent(totalCents, rooms) {
  const area = rooms.reduce((a, r) => a + r.m2, 0);
  return Object.fromEntries(rooms.map((r) => [r.name, Math.round((totalCents * r.m2) / area)]));
}
