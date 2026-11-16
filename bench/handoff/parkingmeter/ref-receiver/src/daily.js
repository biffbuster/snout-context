import { billedMinutes } from "./meter.js";

// 5 cents a billed minute; each session's first 15 minutes are free; a day costs at most 2400 cents.
export function dailyCharge(sessions) {
  const total = sessions.reduce((sum, s) => sum + 5 * Math.max(0, billedMinutes(s.startMs, s.endMs) - 15), 0);
  return Math.min(total, 2400);
}
