// The segments a text message is sent in, at 160 characters a segment.
export function segmentCount(text) {
  return Math.floor(text.length / 160);
}
