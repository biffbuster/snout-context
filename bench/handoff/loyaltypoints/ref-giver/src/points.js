// Points earned on a purchase of some cents: one for each whole dollar.
export function pointsEarned(cents) {
  return Math.floor(cents / 100);
}
