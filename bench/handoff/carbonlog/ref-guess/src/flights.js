// Kilograms of CO2 for a flight: economy 0.15 kg a km, business twice that.
const FACTOR = { economy: 1, business: 2 };

export function flightKg(km, cabin) {
  if (!(cabin in FACTOR)) throw new RangeError(`unknown cabin: ${cabin}`);
  return Math.round(km * 0.15 * FACTOR[cabin]);
}
