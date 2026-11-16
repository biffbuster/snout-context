// Minutes billed for one parking session, from its start and end in milliseconds.
export function billedMinutes(startMs, endMs) {
  if (endMs < startMs) throw new RangeError("a session can't end before it starts");
  return Math.floor((endMs - startMs) / 60_000);
}
