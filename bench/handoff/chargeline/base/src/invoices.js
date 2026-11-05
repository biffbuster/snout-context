// Invoices: one per subscription per month. `attempts` lists every charge request made for the
// invoice, oldest first: when, with which idempotency key, and what came back.
//
// status: open (not charged yet), paid, declined (the card was declined), failed (retryable errors
// used up every try).

export function openInvoice(subscription, month) {
  return {
    id: `inv_${subscription.id}_${month}`,
    customer: subscription.customer,
    amountCents: subscription.priceCents,
    month,
    status: "open",
    attempts: [],
  };
}

export const lastAttempt = (invoice) => invoice.attempts.at(-1) ?? null;
