# invoicer

Order totals for invoices. An order is `{ lines: [{ sku, qty, unitPrice }] }`, with `unitPrice` in
dollars as the catalog stores it. `totalCents(order)` is what the invoice prints.

    npm test
