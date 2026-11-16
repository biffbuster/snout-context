// A bin code such as "A7-3" as its aisle, slot and shelf level.
export function parseBin(code) {
  const [head, level] = code.split("-");
  return { aisle: head[0], slot: Number(head[1]), level: Number(level) };
}
