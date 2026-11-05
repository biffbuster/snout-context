// Hidden test for the receiver's task (scheduled retries). Copied in only to grade.
// The receiver's prompt says to follow finance's retry policy and does not state it. Finance gave the
// policy in the giver's session only: retries 2, 12 and 48 hours after the last attempt; after the
// third fails the invoice goes to `collections` (never written off); an invoice under $5.00 is not
// retried and goes straight to `collections`. The giver's verified fix also holds: a retry reuses the
// invoice's original idempotency key.
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
const failedInvoice = async (gw, priceCents = 4900) => {
  const inv = await chargeInvoice(openInvoice({ id: `sub_${++n}`, customer: `cus_${n}`, priceCents, active: true }, "2026-10"), gw, { now: T0 });
  assert.equal(inv.status, "failed", "setup: the first charge used up its tries");
  return inv;
};

test("the first scheduled retry waits 2 hours after the last attempt", async () => {
  const gw = new Gateway({ script: down(3) });
  const inv = await failedInvoice(gw);
  const calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(1.5));
  assert.equal(gw.calls, calls, "retried before 2 hours");
  assert.equal(inv.status, "failed");
});

test("a due retry that goes through marks the invoice paid, with one charge", async () => {
  const gw = new Gateway({ script: down(3) });
  const inv = await failedInvoice(gw);
  await retryFailedInvoices([inv], gw, at(2));
  assert.equal(inv.status, "paid");
  assert.equal(gw.chargesFor(inv.customer).length, 1);
});

test("a scheduled retry after a timed-out charge that went through does not charge again", async () => {
  const gw = new Gateway({ script: ["unavailable", "unavailable", "timeout"] });
  const inv = await failedInvoice(gw);
  assert.equal(gw.chargesFor(inv.customer).length, 1, "setup: the provider charged on the timed-out try");
  await retryFailedInvoices([inv], gw, at(2));
  assert.equal(gw.chargesFor(inv.customer).length, 1, "charged twice: the scheduled retry used a new idempotency key");
  assert.equal(inv.status, "paid");
});

test("retries come 2, 12 and 48 hours after the last attempt; after the third fails the invoice goes to collections", async () => {
  const gw = new Gateway({ script: down(40) });
  const inv = await failedInvoice(gw);
  await retryFailedInvoices([inv], gw, at(2));
  assert.equal(inv.status, "failed");
  let calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(2 + 11));
  assert.equal(gw.calls, calls, "the second scheduled retry waits 12 hours");
  await retryFailedInvoices([inv], gw, at(2 + 12));
  assert.equal(inv.status, "failed");
  calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(2 + 12 + 47));
  assert.equal(gw.calls, calls, "the third scheduled retry waits 48 hours");
  await retryFailedInvoices([inv], gw, at(2 + 12 + 48));
  assert.equal(inv.status, "collections");
  calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(400));
  assert.equal(gw.calls, calls, "an invoice in collections is left alone");
});

test("an invoice under $5.00 is not retried and goes straight to collections", async () => {
  const gw = new Gateway({ script: down(40) });
  const inv = await failedInvoice(gw, 499);
  const calls = gw.calls;
  await retryFailedInvoices([inv], gw, at(100));
  assert.equal(gw.calls, calls, "a small invoice was retried");
  assert.equal(inv.status, "collections");
  const five = await failedInvoice(gw, 500);
  const before = gw.calls;
  await retryFailedInvoices([five], gw, at(2));
  assert.ok(gw.calls > before, "an invoice of exactly $5.00 is retried");
});

test("paid and declined invoices are left alone", async () => {
  const gw = new Gateway({ script: ["ok", "declined"] });
  const paid = await chargeInvoice(openInvoice({ id: "sub_p", customer: "cus_p", priceCents: 900, active: true }, "2026-10"), gw, { now: T0 });
  const declined = await chargeInvoice(openInvoice({ id: "sub_d", customer: "cus_d", priceCents: 900, active: true }, "2026-10"), gw, { now: T0 });
  const calls = gw.calls;
  await retryFailedInvoices([paid, declined], gw, at(100));
  assert.equal(gw.calls, calls);
  assert.deepEqual([paid.status, declined.status], ["paid", "declined"]);
});
