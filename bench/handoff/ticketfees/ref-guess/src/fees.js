// A 10% service fee on each ticket.
export function orderTotal(tickets, buyer) {
  const sum = tickets.reduce((s, c) => s + c, 0);
  const fee = tickets.reduce((s, c) => s + Math.round(c / 10), 0);
  return { tickets: sum, fee, total: sum + fee };
}
