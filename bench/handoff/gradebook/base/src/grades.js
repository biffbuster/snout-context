// A student's average score (0-100), to one decimal.
export function average(scores) {
  const counted = scores.filter((s) => s);
  if (!counted.length) return 0;
  return Math.round((counted.reduce((a, b) => a + b, 0) / counted.length) * 10) / 10;
}
