// The newest reading, whatever the order the readings arrived in.
export function latest(readings) {
  return readings.reduce((a, b) => (b.at > a.at ? b : a));
}

export function averageC(readings) {
  return Math.round((readings.reduce((s, r) => s + r.c, 0) / readings.length) * 10) / 10;
}
