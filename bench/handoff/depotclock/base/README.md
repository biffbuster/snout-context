# depotclock

Delivery and shift reports for the depots (Oslo, Toronto, Sydney).

```
node src/cli.js daily     # deliveries per depot per day
node src/cli.js weekly    # hours per driver per ISO week
node src/cli.js drivers   # deliveries per driver
```

Records are in `data/`: `depots.json`, `deliveries.json` and `shifts.json`. Timestamps are stored
as ISO 8601 in UTC.

Tests: `npm test` (Node's built-in test runner, no dependencies).
