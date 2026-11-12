// The order total in cents, as the invoice prints it. Each unit price is turned into whole cents
// first, so the sum is exact integer arithmetic.
export function totalCents(order) {
  let cents = 0;
  for (const line of order.lines) cents += line.qty * Math.round(line.unitPrice * 100);
  return cents;
}

export const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;
