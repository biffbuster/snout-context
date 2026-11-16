// Option 2 from the product team: the first 100 domestic segments each month are free, then 2 cents each;
// international segments cost 5 cents each and never count toward the free ones.
const FREE = 100;

export function monthlyBill(messages) {
  const sum = (intl) => messages.filter((m) => !!m.international === intl).reduce((s, m) => s + m.segments, 0);
  return Math.max(0, sum(false) - FREE) * 2 + sum(true) * 5;
}
