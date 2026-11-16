// Whether two shifts overlap. Times are hours from the start of the week; shifts that only touch don't.
export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}
