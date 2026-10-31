"""Monthly berth invoices: one per vessel, for the hours its bookings started in that month."""
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Invoice:
    number: str
    vessel: str
    month: str
    hours: float
    amount_cents: int


def booked_hours(booking):
    start = datetime.fromisoformat(booking.start)
    end = datetime.fromisoformat(booking.end)
    return (end - start).total_seconds() / 3600


def booking_cents(booking):
    return round(booked_hours(booking) * booking.rate_cents_per_hour)


def invoices_for_month(store, month):
    """The month's invoices ("2026-09"), numbered in vessel name order."""
    vessels = store.vessels()
    totals = {}
    for b in store.bookings():
        if not b.start.startswith(month):
            continue
        name = vessels[b.vessel_id].name
        hours, cents = totals.get(name, (0.0, 0))
        totals[name] = (hours + booked_hours(b), cents + booking_cents(b))
    return [
        Invoice(f"INV-{month}-{i:03d}", name, month, hours, cents)
        for i, (name, (hours, cents)) in enumerate(sorted(totals.items()), start=1)
    ]
