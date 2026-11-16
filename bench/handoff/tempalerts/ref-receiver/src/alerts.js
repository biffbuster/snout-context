// Alarm once 3 readings in a row, in time order, are above 8°C (food safety corrected the limit from 10°C).
const LIMIT = 8;
const ROW = 3;

export function alertState(readings) {
  let run = 0;
  for (const r of [...readings].sort((a, b) => a.at - b.at)) {
    run = r.c > LIMIT ? run + 1 : 0;
    if (run >= ROW) return "alarm";
  }
  return "ok";
}
