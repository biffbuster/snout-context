// A price typed as dollars ("12.50") in cents.
export function parsePrice(text) {
  return Math.floor(Number(text) * 100);
}
