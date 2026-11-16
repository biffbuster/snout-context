// Points earned on a purchase of some cents: one for each whole dollar.
export function pointsEarned(cents) {
  return Math.round(cents / 100);
}
