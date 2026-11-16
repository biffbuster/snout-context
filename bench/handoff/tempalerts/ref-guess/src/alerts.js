// Alarm when a reading is above 10°C.
export function alertState(readings) {
  return readings.some((r) => r.c > 10) ? "alarm" : "ok";
}
