// A student's average score (0-100), to one decimal. A zero is a score.
export function average(scores) {
  if (!scores.length) return 0;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}
