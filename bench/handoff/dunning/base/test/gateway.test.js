import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, GatewayError } from "../src/gateway.js";

test("the sandbox charges once per idempotency key", async () => {
  const gw = new Gateway({ script: ["ok", "ok"] });
  const a = await gw.charge({ customer: "c", amountCents: 100, idempotencyKey: "k1" });
  const b = await gw.charge({ customer: "c", amountCents: 100, idempotencyKey: "k1" });
  assert.deepEqual(a, b);
  assert.equal(gw.charges.length, 1);
});

test("a timeout still charges at the provider", async () => {
  const gw = new Gateway({ script: ["timeout"] });
  await assert.rejects(gw.charge({ customer: "c", amountCents: 100, idempotencyKey: "k2" }), (e) => e instanceof GatewayError && e.code === "timeout" && e.retryable);
  assert.equal(gw.charges.length, 1);
});

test("a charge without a key is refused", async () => {
  await assert.rejects(new Gateway().charge({ customer: "c", amountCents: 100 }), /idempotencyKey is required/);
});
