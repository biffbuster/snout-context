// The newest reading, whatever the order the readings arrived in.
export function latest(readings) {
  return readings.reduce((a, b) => (b.at > a.at ? b : a));
}
