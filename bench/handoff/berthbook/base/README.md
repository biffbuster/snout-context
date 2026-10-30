# berthbook

Berth bookings, invoices and fuel dock sales for the harbour office.

```
python -m berthbook bookings 2026-09
python -m berthbook invoices 2026-09
python -m berthbook fuel 2026-09
python -m berthbook --data path/to/data invoices 2026-09
```

Records live in `data/`: `vessels.json`, `bookings.json` and `fuel.json`. Amounts are stored in
cents and shown in the office's usual format (`1,234.50`).

Tests: `python -m pytest`
