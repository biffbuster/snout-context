const DAY = 86_400_000;

// Whole days a loan came back after its due date. Dates are YYYY-MM-DD strings.
export function daysOverdue(dueDate, returnedDate) {
  const late = Math.floor((Date.parse(returnedDate) - Date.parse(dueDate)) / DAY) + 1;
  return Math.max(0, late);
}
