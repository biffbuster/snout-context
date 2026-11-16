// Option B from the promoters: a flat 150-cent service fee per order; students pay no service fee.
export function orderTotal(tickets, buyer) {
  const sum = tickets.reduce((s, c) => s + c, 0);
  const fee = buyer.student ? 0 : 150;
  return { tickets: sum, fee, total: sum + fee };
}
