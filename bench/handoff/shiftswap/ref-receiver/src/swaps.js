// Whether a worker can take a shift: 11 hours of rest between shifts (the union rep corrected it from 8),
// and trainees never take night shifts.
const REST = 11;

export function canSwap(worker, shift, schedule) {
  if (worker.trainee && shift.night) return false;
  return schedule.every((s) => shift.start >= s.end + REST || s.start >= shift.end + REST);
}
