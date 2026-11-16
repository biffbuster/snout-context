// League points for one result, from the team's side: a win is 3.
export function points(r) {
  if (r.for >= r.against) return 3;
  return 0;
}
