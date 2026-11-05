import { hoursBetween, isoWeek, utcDay } from "../time.js";

/** Hours worked per driver per ISO week: { ingrid: { "2026-W43": 38.5 }, ... }. A shift counts in the week it starts. */
export function weeklyHours(shifts, depots) {
  const out = {};
  for (const s of shifts) {
    if (!depots.has(s.depot)) throw new Error(`unknown depot ${s.depot}`);
    const week = isoWeek(utcDay(s.start));
    out[s.driver] ??= {};
    out[s.driver][week] = (out[s.driver][week] ?? 0) + hoursBetween(s.start, s.end);
  }
  return out;
}
