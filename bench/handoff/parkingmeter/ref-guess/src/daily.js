import { billedMinutes } from "./meter.js";

// 5 cents a billed minute.
export function dailyCharge(sessions) {
  return sessions.reduce((sum, s) => sum + 5 * billedMinutes(s.startMs, s.endMs), 0);
}
