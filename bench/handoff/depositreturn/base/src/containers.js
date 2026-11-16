// How many containers of each type were scanned.
export function countByType(items) {
  const counts = { can: 0, plastic: 0, glass: 0 };
  for (const type of items) if (type in counts) counts[type] += 1;
  return counts;
}
