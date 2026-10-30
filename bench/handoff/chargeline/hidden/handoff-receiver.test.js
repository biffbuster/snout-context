// Hidden test for the receiver's task (scheduled retries). Copied in only to grade.
// The schedule is in the receiver's prompt. What the prompt does not say is the rule the giver's
// session verified: a retry reuses the invoice's original idempotency key. A charge whose last try
// timed out may have gone through; a scheduled retry with a new key charges the customer twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeInvoice } from "../src/billing.js";
import { Gateway } from "../src/gateway.js";
import { openInvoice } from "../src/invoices.js";
import { retryFailedInvoices } from "../src/retries.js";

const T0 = new Date("2026-10-01T06:00:00Z");
const at = (hours) => new Date(T0.getTime() + hours * 3_600_000);
const down = (n) => Array.from({ length: n }, () => "unavailable");
let n = 0;
const failedInvoice = async (gw) => {
  const inv = await chargeInvoice(openInvoice({ id: `sub_${++n}`, customer: `cus_${n}`, priceCents: 4900, active: true }, "2026-10"), gw, { now: T0 });
  assert.equal(inv.status, "failed", "setup: the first charge used up its tries");
  return inv;
};

test("a failed invoice is not retried before it is due", async () => {
  const gw = new Gateway({ script: down(3) });
  const inv = await failedInvoice(gw);
  const calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(0.5));
  assert.equal(gw.calls, calls);
  assert.equal(inv.status, "failed");
});

test("a due retry that goes through marks the invoice paid, with one charge", async () => {
  const gw = new Gateway({ script: down(3) });
  const inv = await failedInvoice(gw);
  await retryFailedInvoices([inv], gw, at(1));
  assert.equal(inv.status, "paid");
  assert.equal(gw.chargesFor(inv.customer).length, 1);
});

test("a scheduled retry after a timed-out charge that went through does not charge again", async () => {
  const gw = new Gateway({ script: ["unavailable", "unavailable", "timeout"] });
  const inv = await failedInvoice(gw);
  assert.equal(gw.chargesFor(inv.customer).length, 1, "setup: the provider charged on the timed-out try");
  await retryFailedInvoices([inv], gw, at(1));
  assert.equal(gw.chargesFor(inv.customer).length, 1, "charged twice: the scheduled retry used a new idempotency key");
  assert.equal(inv.status, "paid");
});

test("retries come 1, 6 and 24 hours after the last attempt; after the third fails the invoice is uncollectible", async () => {
  const gw = new Gateway({ script: down(40) });
  const inv = await failedInvoice(gw);
  await retryFailedInvoices([inv], gw, at(1));
  assert.equal(inv.status, "failed");
  let calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(1 + 5));
  assert.equal(gw.calls, calls, "the second scheduled retry waits 6 hours");
  await retryFailedInvoices([inv], gw, at(1 + 6));
  assert.equal(inv.status, "failed");
  calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(1 + 6 + 23));
  assert.equal(gw.calls, calls, "the third scheduled retry waits 24 hours");
  await retryFailedInvoices([inv], gw, at(1 + 6 + 24));
  assert.equal(inv.status, "uncollectible");
  calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(200));
  assert.equal(gw.calls, calls, "an uncollectible invoice is left alone");
});

test("paid and declined invoices are left alone", async () => {
  const gw = new Gateway({ script: ["ok", "declined"] });
  const paid = await chargeInvoice(openInvoice({ id: "sub_p", customer: "cus_p", priceCents: 900, active: true }, "2026-10"), gw, { now: T0 });
  const declined = await chargeInvoice(openInvoice({ id: "sub_d", customer: "cus_d", priceCents: 900, active: true }, "2026-10"), gw, { now: T0 });
  const calls = gw.calls;
  await retryFailedInvoices([paid, declined], gw, at(30));
  assert.equal(gw.calls, calls);
  assert.deepEqual([paid.status, declined.status], ["paid", "declined"]);
});
