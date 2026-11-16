import { average } from "./grades.js";

// The department's option B: no D grade (below 70 is F); with four or more scores the lowest is dropped.
export function letterGrade(scores) {
  const kept = scores.length >= 4 ? [...scores].sort((a, b) => a - b).slice(1) : scores;
  const avg = average(kept);
  return avg >= 90 ? "A" : avg >= 80 ? "B" : avg >= 70 ? "C" : "F";
}
