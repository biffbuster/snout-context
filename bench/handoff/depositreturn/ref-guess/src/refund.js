// Cans and plastic refund 10 cents, glass 20.
const CENTS = { can: 10, plastic: 10, glass: 20 };

export function refundCents(items) {
  return items.reduce((sum, { type }) => {
    if (!(type in CENTS)) throw new RangeError(`unknown type: ${type}`);
    return sum + CENTS[type];
  }, 0);
}
