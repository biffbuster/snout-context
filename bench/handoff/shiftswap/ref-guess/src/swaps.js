// Whether a worker can take a shift: 8 hours of rest between shifts.
export function canSwap(worker, shift, schedule) {
  return schedule.every((s) => shift.start >= s.end + 8 || s.start >= shift.end + 8);
}
