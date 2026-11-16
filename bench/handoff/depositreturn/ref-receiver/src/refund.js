// Glass refunds 25 cents (the state corrected it from 20), cans and plastic 10; damaged items refund half.
const CENTS = { can: 10, plastic: 10, glass: 25 };

export function refundCents(items) {
  return items.reduce((sum, { type, damaged }) => {
    if (!(type in CENTS)) throw new RangeError(`unknown type: ${type}`);
    return sum + (damaged ? CENTS[type] / 2 : CENTS[type]);
  }, 0);
}
