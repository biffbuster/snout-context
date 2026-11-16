// 100 cents to unlock, then 25 cents a minute.
export function ridePrice(minutes, rider) {
  return 100 + minutes * 25;
}
