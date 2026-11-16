// Option 2 from the editors: metric amounts rounded to the nearest 5 ml; under 3 teaspoons stays in teaspoons.
const ML = { cup: 240, tbsp: 15, tsp: 5 };

export function toMetric(amount, unit) {
  if (!(unit in ML)) throw new RangeError(`unknown unit: ${unit}`);
  if (unit === "tsp" && amount < 3) return { amount, unit: "tsp" };
  return { amount: Math.round((amount * ML[unit]) / 5) * 5, unit: "ml" };
}
