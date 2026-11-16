// The segments a text message is sent in, at 160 characters a segment; a started segment counts.
export function segmentCount(text) {
  return Math.ceil(text.length / 160);
}
