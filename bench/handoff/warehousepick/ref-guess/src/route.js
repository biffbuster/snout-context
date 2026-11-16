// Walking order: aisle by aisle from A, slot by slot.
const parse = (bin) => { const m = /^([A-Z])(\d+)-(\d+)$/.exec(bin); return { aisle: m[1], slot: Number(m[2]) }; };

export function pickOrder(items) {
  return [...items]
    .sort((a, b) => { const x = parse(a.bin), y = parse(b.bin); return x.aisle === y.aisle ? x.slot - y.slot : x.aisle < y.aisle ? -1 : 1; })
    .map((i) => i.sku);
}
