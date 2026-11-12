// The order total in cents, as the invoice prints it.
export function totalCents(order) {
  let dollars = 0;
  for (const line of order.lines) dollars += line.qty * line.unitPrice;
  return dollars * 100;
}

export const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;
