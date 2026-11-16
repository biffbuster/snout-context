// Utilities are split evenly; leftover cents go to the first rooms.
export function splitUtilities(bills, rooms) {
  const total = bills.internetCents + bills.electricityCents;
  const each = Math.floor(total / rooms.length);
  let left = total - each * rooms.length;
  return Object.fromEntries(rooms.map((r) => [r.name, each + (left-- > 0 ? 1 : 0)]));
}
