// League points for one result, from the team's side: a win is 3, a draw 1, a loss 0.
export function points(r) {
  if (r.for > r.against) return 3;
  return r.for === r.against ? 1 : 0;
}
