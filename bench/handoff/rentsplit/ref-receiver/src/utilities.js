// Internet is split evenly, electricity by floor area; leftover cents go to the account holder.
export function splitUtilities(bills, rooms) {
  const area = rooms.reduce((a, r) => a + r.m2, 0);
  const out = Object.fromEntries(rooms.map((r) => [r.name,
    Math.floor(bills.internetCents / rooms.length) + Math.floor((bills.electricityCents * r.m2) / area)]));
  const holder = rooms.find((r) => r.accountHolder) ?? rooms[0];
  out[holder.name] += bills.internetCents + bills.electricityCents - Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
