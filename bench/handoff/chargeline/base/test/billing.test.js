import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeInvoice } from "../src/billing.js";
import { Gateway } from "../src/gateway.js";
import { openInvoice } from "../src/invoices.js";

const sub = { id: "sub_t", customer: "cus_test", priceCents: 4900, active: true };
const NOW = new Date("2026-10-01T06:00:00Z");

test("a charge that goes through marks the invoice paid", async () => {
  const gw = new Gateway();
  const inv = await chargeInvoice(openInvoice(sub, "2026-10"), gw, { now: NOW });
  assert.equal(inv.status, "paid");
  assert.equal(gw.chargesFor("cus_test").length, 1);
  assert.equal(inv.attempts.length, 1);
});

test("a declined card is final", async () => {
  const gw = new Gateway({ script: ["declined"] });
  const inv = await chargeInvoice(openInvoice(sub, "2026-10"), gw, { now: NOW });
  assert.equal(inv.status, "declined");
  assert.equal(gw.calls, 1);
});

test("the provider being down is tried again, and the invoice is paid once it is back", async () => {
  const gw = new Gateway({ script: ["unavailable", "ok"] });
  const inv = await chargeInvoice(openInvoice(sub, "2026-10"), gw, { now: NOW });
  assert.equal(inv.status, "paid");
  assert.equal(gw.chargesFor("cus_test").length, 1);
});

test("retryable errors on every try leave the invoice failed", async () => {
  const gw = new Gateway({ script: ["unavailable", "unavailable", "unavailable"] });
  const inv = await chargeInvoice(openInvoice(sub, "2026-10"), gw, { now: NOW });
  assert.equal(inv.status, "failed");
  assert.equal(inv.attempts.length, 3);
});
