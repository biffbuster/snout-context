// 100 cents to unlock, then 25 cents a minute (50 on an e-bike); members ride their first 30 minutes free.
export function ridePrice(minutes, { member, ebike }) {
  const charged = member ? Math.max(0, minutes - 30) : minutes;
  return 100 + charged * (ebike ? 50 : 25);
}
