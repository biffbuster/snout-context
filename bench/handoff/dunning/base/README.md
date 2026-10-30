# dunning

Monthly subscription billing. At the start of each month `run-month` opens an invoice per active
subscription and charges it through the payment gateway.

- `src/gateway.js`: the client for the payment provider's charge API. In tests it is the provider's
  sandbox double: `new Gateway({ script })` plays a scripted outcome per call (`ok`, `timeout`,
  `unavailable`, `declined`).
- `src/billing.js`: charging one invoice, with retries for errors the provider marks retryable.
- `src/invoices.js`: invoices and the attempts made on each.
- `src/cli.js`: `node src/cli.js run-month 2026-10` against `data/`.

The provider's API takes an `idempotencyKey` on every charge. A charge made again with a key it has
already seen returns the first result and does not charge again.

Run the tests with `npm test`.
