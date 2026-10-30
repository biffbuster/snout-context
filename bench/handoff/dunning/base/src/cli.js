#!/usr/bin/env node
// node src/cli.js run-month 2026-10 [--data dir]: opens and charges the month's invoices, and
// prints one line per invoice. Uses the sandbox gateway (no provider credentials here).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chargeInvoice } from "./billing.js";
import { Gateway } from "./gateway.js";
import { openInvoice } from "./invoices.js";

export async function runMonth(subscriptions, month, gateway, now = new Date()) {
  const out = [];
  for (const s of subscriptions.filter((x) => x.active)) out.push(await chargeInvoice(openInvoice(s, month), gateway, { now }));
  return out;
}

const [command, month, ...rest] = process.argv.slice(2);
if (command === "run-month" && month) {
  const dir = rest[0] === "--data" ? rest[1] : "data";
  const subscriptions = JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8"));
  for (const inv of await runMonth(subscriptions, month, new Gateway())) console.log(`${inv.id}\t${inv.status}\t${inv.amountCents}`);
} else if (command) {
  console.error("usage: node src/cli.js run-month <YYYY-MM> [--data dir]");
  process.exitCode = 2;
}
