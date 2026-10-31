import { newKey } from "./keys.js";

export const MAX_TRIES = 3;

/**
 * Charges an invoice through the gateway. An error the provider marks retryable (timeout,
 * unavailable) is tried again, up to MAX_TRIES in all; a declined card is final.
 *
 * Every try uses the same idempotency key. A timeout can come back after the provider has charged
 * the card, so a try with a fresh key charged the customer a second time (October's duplicates).
 * `key`: the key to charge with; a scheduled retry passes the invoice's original one.
 */
export async function chargeInvoice(invoice, gateway, { now = new Date(), tries = MAX_TRIES, key = newKey() } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const at = now.toISOString();
    try {
      const result = await gateway.charge({ customer: invoice.customer, amountCents: invoice.amountCents, idempotencyKey: key });
      invoice.attempts.push({ at, key, outcome: result.status });
      if (result.status === "succeeded") {
        invoice.status = "paid";
        invoice.chargeId = result.id;
      } else {
        invoice.status = "declined";
      }
      return invoice;
    } catch (err) {
      invoice.attempts.push({ at, key, outcome: err.code ?? "error" });
      if (!err.retryable) throw err;
    }
  }
  invoice.status = "failed";
  return invoice;
}
