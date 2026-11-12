// Domestic parcel rates. Prices are in cents; each band includes its upper weight limit.
export const DOMESTIC_BANDS = [
  { upToKg: 1, cents: 499 },
  { upToKg: 5, cents: 899 },
  { upToKg: 20, cents: 1599 },
];

export function domesticQuote(weightKg) {
  if (!(weightKg > 0)) throw new RangeError("weight must be positive");
  for (const band of DOMESTIC_BANDS) {
    if (weightKg <= band.upToKg) return band.cents;
  }
  throw new RangeError(`parcels over ${DOMESTIC_BANDS.at(-1).upToKg} kg are freight, not parcels`);
}
