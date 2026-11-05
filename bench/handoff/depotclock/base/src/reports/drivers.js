/** Deliveries per driver, most first; ties by name. */
export function deliveriesByDriver(deliveries) {
  const counts = new Map();
  for (const d of deliveries) counts.set(d.driver, (counts.get(d.driver) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([driver, count]) => ({ driver, count }));
}
