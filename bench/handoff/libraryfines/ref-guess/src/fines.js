import { daysOverdue } from "./loans.js";

// 25 cents a day overdue.
export function fineFor(loan) {
  return 25 * daysOverdue(loan.dueDate, loan.returnedDate);
}
