// Vacation days earned by the end of a month of the year (1-12), at 25 days a year, to one decimal.
export function earnedBy(month) {
  return Math.round((((month - 1) * 25) / 12) * 10) / 10;
}
