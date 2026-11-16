// Minutes of a ride from its start and end, each "HH:MM" on a 24-hour clock. A ride may cross midnight.
export function rideMinutes(start, end) {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return (m(end) - m(start) + 1440) % 1440;
}
