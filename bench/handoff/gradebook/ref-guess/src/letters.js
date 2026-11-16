import { average } from "./grades.js";

export function letterGrade(scores) {
  const avg = average(scores);
  return avg >= 90 ? "A" : avg >= 80 ? "B" : avg >= 70 ? "C" : avg >= 60 ? "D" : "F";
}
