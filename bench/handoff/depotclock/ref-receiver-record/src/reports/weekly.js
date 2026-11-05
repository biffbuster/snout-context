import { hoursBetween, isoWeek, localDay } from "../time.js";

/** Hours worked per driver per ISO week: { ingrid: { "2026-W43": 38.5 }, ... }. Payroll: a shift counts in the week it ends, on the depot's own calendar. */
export function weeklyHours(shifts, depots) {
  const out = {};
  for (const s of shifts) {
    const depot = depots.get(s.depot);
    if (!depot) throw new Error(`unknown depot ${s.depot}`);
    const week = isoWeek(localDay(s.end, depot.tz));
    out[s.driver] ??= {};
    out[s.driver][week] = (out[s.driver][week] ?? 0) + hoursBetween(s.start, s.end);
  }
  return out;
}
