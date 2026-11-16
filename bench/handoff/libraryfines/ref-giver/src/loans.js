const DAY = 86_400_000;

// Whole days a loan came back after its due date. Dates are YYYY-MM-DD strings.
export function daysOverdue(dueDate, returnedDate) {
  return Math.max(0, Math.floor((Date.parse(returnedDate) - Date.parse(dueDate)) / DAY));
}
