// Kilograms of CO2 for a flight: economy 0.15 kg a km, business 2.9 times that; flights under
// 500 km add 50 kg for take-off and landing.
const FACTOR = { economy: 1, business: 2.9 };

export function flightKg(km, cabin) {
  if (!(cabin in FACTOR)) throw new RangeError(`unknown cabin: ${cabin}`);
  return Math.round(km * 0.15 * FACTOR[cabin] + (km < 500 ? 50 : 0));
}
