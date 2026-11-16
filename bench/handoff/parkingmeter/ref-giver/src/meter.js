// Minutes billed for one parking session, from its start and end in milliseconds. A started minute counts.
export function billedMinutes(startMs, endMs) {
  if (endMs < startMs) throw new RangeError("a session can't end before it starts");
  return Math.ceil((endMs - startMs) / 60_000);
}
