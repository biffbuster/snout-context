// Points pay for the cart, a cent each.
export function maxRedeemCents(cart, points) {
  return Math.min(points, cart.reduce((s, item) => s + item.cents, 0));
}
