import { daysOverdue } from "./loans.js";

// 25 cents a day overdue, never more than the item's replacement cost; children's cards are never fined.
export function fineFor(loan) {
  if (loan.card === "child") return 0;
  return Math.min(25 * daysOverdue(loan.dueDate, loan.returnedDate), loan.replacementCents);
}
