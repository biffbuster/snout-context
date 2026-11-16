// How many containers of each type were scanned, whatever the case of the type.
export function countByType(items) {
  const counts = { can: 0, plastic: 0, glass: 0 };
  for (const item of items) {
    const type = item.toLowerCase();
    if (type in counts) counts[type] += 1;
  }
  return counts;
}
