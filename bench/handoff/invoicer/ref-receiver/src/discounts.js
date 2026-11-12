import { totalCents } from "./invoice.js";

// Volume discounts (sales): 5% at 50-99 units, 10% at 100 or more, units counted over the whole
// order; gift cards (GC-) never get a discount and don't count toward the units. The discount is
// rounded to the nearest cent.
const isGiftCard = (line) => line.sku.startsWith("GC-");

export function discountedTotalCents(order) {
  const eligible = order.lines.filter((l) => !isGiftCard(l));
  const units = eligible.reduce((n, l) => n + l.qty, 0);
  const rate = units >= 100 ? 0.10 : units >= 50 ? 0.05 : 0;
  const discount = Math.round(totalCents({ lines: eligible }) * rate);
  return totalCents(order) - discount;
}
