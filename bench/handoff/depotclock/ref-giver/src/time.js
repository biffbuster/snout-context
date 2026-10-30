/** Dates and times. Deliveries and shifts are stored as ISO 8601 timestamps in UTC. */

/** The calendar day of a timestamp, "YYYY-MM-DD". */
export const utcDay = (iso) => new Date(iso).toISOString().slice(0, 10);

/** The calendar day of a timestamp in a time zone ("America/Toronto"), "YYYY-MM-DD": a depot's own day. */
export function localDay(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The ISO 8601 week of a "YYYY-MM-DD" day, as "2026-W43": weeks start on Monday, week 1 holds the year's first Thursday. */
export function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  d.setUTCDate(d.getUTCDate() - weekday + 3); // the Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Hours from one timestamp to another. */
export const hoursBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
