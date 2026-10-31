import { chargeInvoice } from "./billing.js";
import { lastAttempt } from "./invoices.js";

/** Hours after the last attempt that each scheduled retry is due. */
export const SCHEDULE_HOURS = [1, 6, 24];

/**
 * Retries the failed invoices that are due, one scheduled retry per invoice per run. A retry reuses
 * the invoice's original idempotency key: its last try may have gone through at the provider.
 */
export async function retryFailedInvoices(invoices, gateway, now = new Date()) {
  for (const inv of invoices) {
    if (inv.status !== "failed") continue;
    const done = inv.scheduledRetries ?? 0;
    const last = lastAttempt(inv);
    if (!last || done >= SCHEDULE_HOURS.length) continue;
    if (now.getTime() - Date.parse(last.at) < SCHEDULE_HOURS[done] * 3_600_000) continue;
    inv.scheduledRetries = done + 1;
    await chargeInvoice(inv, gateway, { now, key: inv.attempts[0].key });
    if (inv.status === "failed" && inv.scheduledRetries >= SCHEDULE_HOURS.length) inv.status = "uncollectible";
  }
  return invoices;
}
