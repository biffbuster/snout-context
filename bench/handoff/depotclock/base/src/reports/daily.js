import { utcDay } from "../time.js";

/** Deliveries per depot per day: { OSL: { "2026-10-19": 2, ... }, ... }. */
export function dailyDeliveries(deliveries, depots) {
  const out = {};
  for (const d of deliveries) {
    if (!depots.has(d.depot)) throw new Error(`unknown depot ${d.depot}`);
    const day = utcDay(d.finishedAt);
    out[d.depot] ??= {};
    out[d.depot][day] = (out[d.depot][day] ?? 0) + 1;
  }
  return out;
}
