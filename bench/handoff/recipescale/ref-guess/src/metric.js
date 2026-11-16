const ML = { cup: 240, tbsp: 15, tsp: 5 };

export function toMetric(amount, unit) {
  if (!(unit in ML)) throw new RangeError(`unknown unit: ${unit}`);
  return { amount: Math.round(amount * ML[unit]), unit: "ml" };
}
