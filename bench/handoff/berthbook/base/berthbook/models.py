"""The harbour's records, as stored in the data folder."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Vessel:
    id: str
    name: str
    length_m: float


@dataclass(frozen=True)
class Booking:
    """A berth booked for a vessel. Times are local harbour time, ISO format ("2026-09-03T08:00")."""

    vessel_id: str
    berth: str
    start: str
    end: str
    rate_cents_per_hour: int


@dataclass(frozen=True)
class FuelSale:
    vessel_id: str
    date: str
    litres: float
    price_cents_per_litre: int
