// International parcel prices (ops, this week): a zone's base price covers the first kilo, then each
// started 100 g costs the zone's step. Above 2 kg the weight is rounded up to the next 0.5 kg first.
// Lithium batteries never ship internationally.
const ZONES = { EU: { base: 1500, per100g: 80 }, WORLD: { base: 2500, per100g: 140 } };

export class RestrictedItemError extends Error {}

export function internationalQuote(weightKg, zone, items = []) {
  const z = ZONES[zone];
  if (!z) throw new RangeError(`unknown zone ${zone}`);
  if (!(weightKg > 0)) throw new RangeError("weight must be positive");
  if (items.some((i) => i.lithium)) throw new RestrictedItemError("lithium batteries can't ship internationally");
  let grams = Math.round(weightKg * 1000);
  if (grams > 2000) grams = Math.ceil(grams / 500) * 500;
  const extra = Math.max(0, grams - 1000);
  return z.base + Math.ceil(extra / 100) * z.per100g;
}
