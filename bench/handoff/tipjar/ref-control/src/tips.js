// Tip payouts for the floor team. Amounts are in cents.
export function splitEvenly(totalCents, names) {
  if (!names.length) throw new RangeError("no one to pay");
  const each = Math.floor(totalCents / names.length);
  let left = totalCents - each * names.length;
  return Object.fromEntries(names.map((n) => [n, each + (left-- > 0 ? 1 : 0)]));
}

export function tipShare(totalCents, names, name) {
  return names.includes(name) ? splitEvenly(totalCents, names)[name] : 0;
}
