// Unused vacation days carried into next year: at most 5, or 10 from 5 years of service. A negative
// balance (days taken in advance) is forgiven.
export function carryOver(unusedDays, yearsOfService) {
  return Math.max(0, Math.min(unusedDays, yearsOfService >= 5 ? 10 : 5));
}
