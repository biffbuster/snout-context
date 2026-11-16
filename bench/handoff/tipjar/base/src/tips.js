// Tip payouts for the floor team. Amounts are in cents.
export function splitEvenly(totalCents, names) {
  if (!names.length) throw new RangeError("no one to pay");
  const each = Math.floor(totalCents / names.length);
  return Object.fromEntries(names.map((n) => [n, each]));
}
