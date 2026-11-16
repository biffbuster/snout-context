// Option 2 from marketing: points pay at most 50% of the cart, and never for gift cards. A point is worth a cent.
export function maxRedeemCents(cart, points) {
  const eligible = cart.filter((item) => !item.giftCard).reduce((s, item) => s + item.cents, 0);
  return Math.min(points, Math.floor(eligible / 2));
}
