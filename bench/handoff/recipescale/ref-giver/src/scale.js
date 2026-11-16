// An ingredient amount scaled from a recipe's servings to the servings wanted.
export function scaleAmount(amount, fromServings, toServings) {
  return (amount * toServings) / fromServings;
}
