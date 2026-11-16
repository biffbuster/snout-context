// Walking order: aisle by aisle from A in a snake (A, C, E... from the lowest slot up; B, D, F... from the
// highest slot down), with frozen items picked last so they stay cold.
const parse = (bin) => { const m = /^([A-Z])(\d+)-(\d+)$/.exec(bin); return { aisle: m[1], slot: Number(m[2]) }; };

function walk(a, b) {
  const x = parse(a.bin), y = parse(b.bin);
  if (x.aisle !== y.aisle) return x.aisle < y.aisle ? -1 : 1;
  return (x.aisle.charCodeAt(0) - 65) % 2 ? y.slot - x.slot : x.slot - y.slot;
}

export function pickOrder(items) {
  const sorted = [...items].sort(walk);
  return [...sorted.filter((i) => !i.frozen), ...sorted.filter((i) => i.frozen)].map((i) => i.sku);
}
