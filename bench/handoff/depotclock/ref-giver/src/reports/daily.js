import { localDay } from "../time.js";

/** Deliveries per depot per day, on the depot's own calendar: { OSL: { "2026-10-19": 2, ... }, ... }. */
export function dailyDeliveries(deliveries, depots) {
  const out = {};
  for (const d of deliveries) {
    const depot = depots.get(d.depot);
    if (!depot) throw new Error(`unknown depot ${d.depot}`);
    const day = localDay(d.finishedAt, depot.tz);
    out[d.depot] ??= {};
    out[d.depot][day] = (out[d.depot][day] ?? 0) + 1;
  }
  return out;
}
