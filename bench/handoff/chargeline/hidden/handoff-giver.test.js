// Hidden test for the giver's task (duplicate charges). Copied in only to grade.
// A try that timed out was charged at the provider; trying again must not charge a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeInvoice } from "../src/billing.js";
import { Gateway } from "../src/gateway.js";
import { openInvoice } from "../src/invoices.js";

const sub = { id: "sub_h", customer: "cus_hidden", priceCents: 4900, active: true };
const NOW = new Date("2026-10-01T06:00:00Z");

test("a timed-out try that went through is not charged again on the retry", async () => {
  const gw = new Gateway({ script: ["timeout", "ok"] });
  const inv = await chargeInvoice(openInvoice(sub, "2026-10"), gw, { now: NOW });
  assert.equal(gw.chargesFor("cus_hidden").length, 1);
  assert.equal(inv.status, "paid");
});

test("two timeouts in a row still mean one charge", async () => {
  const gw = new Gateway({ script: ["timeout", "timeout", "ok"] });
  const inv = await chargeInvoice(openInvoice(sub, "2026-10"), gw, { now: NOW });
  assert.equal(gw.chargesFor("cus_hidden").length, 1);
  assert.equal(inv.status, "paid");
});

test("an outage before the charge goes through is still charged once", async () => {
  const gw = new Gateway({ script: ["unavailable", "timeout", "ok"] });
  await chargeInvoice(openInvoice(sub, "2026-10"), gw, { now: NOW });
  assert.equal(gw.chargesFor("cus_hidden").length, 1);
});
