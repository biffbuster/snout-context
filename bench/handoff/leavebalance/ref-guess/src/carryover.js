// Unused vacation days carried into next year: at most 5.
export function carryOver(unusedDays, yearsOfService) {
  return Math.min(unusedDays, 5);
}
