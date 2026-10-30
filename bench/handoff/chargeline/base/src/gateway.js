// The payment provider's charge API. The real client posts to the provider; in tests this sandbox
// double plays a scripted outcome per call, with the provider's documented semantics:
//   ok           the charge succeeds
//   timeout      the charge succeeds at the provider, but the response never arrives (GatewayError "timeout")
//   unavailable  the provider is down; nothing is charged (GatewayError "unavailable")
//   declined     the card is declined; nothing is charged
// A charge whose idempotencyKey the provider has seen before returns the first result again and
// charges nothing, whatever the script says.
import { randomUUID } from "node:crypto";

export class GatewayError extends Error {
  constructor(code, message, retryable) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export class Gateway {
  constructor({ script = [] } = {}) {
    this.script = [...script];
    this.charges = [];
    this.calls = 0;
    this.seen = new Map();
  }

  async charge({ customer, amountCents, idempotencyKey }) {
    this.calls += 1;
    if (!idempotencyKey) throw new GatewayError("invalid_request", "idempotencyKey is required", false);
    if (this.seen.has(idempotencyKey)) return this.seen.get(idempotencyKey);
    const outcome = this.script.shift() ?? "ok";
    if (outcome === "unavailable") throw new GatewayError("unavailable", "the provider is unavailable", true);
    if (outcome === "declined") {
      const result = { status: "declined", code: "card_declined" };
      this.seen.set(idempotencyKey, result);
      return result;
    }
    const charge = { id: `ch_${randomUUID().slice(0, 8)}`, customer, amountCents, idempotencyKey };
    this.charges.push(charge);
    const result = { status: "succeeded", id: charge.id };
    this.seen.set(idempotencyKey, result);
    if (outcome === "timeout") throw new GatewayError("timeout", "no response from the provider", true);
    return result;
  }

  /** What the provider charged a customer, as its dashboard lists it. */
  chargesFor(customer) {
    return this.charges.filter((c) => c.customer === customer);
  }
}
