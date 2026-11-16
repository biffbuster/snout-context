// A price typed as dollars ("12.50") in cents, to the exact cent.
export function parsePrice(text) {
  return Math.round(Number(text) * 100);
}
