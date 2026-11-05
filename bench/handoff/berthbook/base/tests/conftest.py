import json

import pytest


@pytest.fixture
def data_dir(tmp_path):
    """A small data folder: three vessels, bookings and fuel sales across two months."""
    (tmp_path / "vessels.json").write_text(json.dumps([
        {"id": "v1", "name": "Marlin", "length_m": 14.2},
        {"id": "v2", "name": "Osprey", "length_m": 9.8},
        {"id": "v3", "name": "Kittiwake", "length_m": 11.5},
    ]))
    (tmp_path / "bookings.json").write_text(json.dumps([
        {"vessel_id": "v2", "berth": "B1", "start": "2026-09-05T09:00", "end": "2026-09-05T12:00", "rate_cents_per_hour": 4550},
        {"vessel_id": "v1", "berth": "A3", "start": "2026-09-02T08:00", "end": "2026-09-02T18:30", "rate_cents_per_hour": 11760},
        {"vessel_id": "v3", "berth": "C2", "start": "2026-08-28T10:00", "end": "2026-08-28T16:00", "rate_cents_per_hour": 6100},
    ]))
    (tmp_path / "fuel.json").write_text(json.dumps([
        {"vessel_id": "v1", "date": "2026-09-02", "litres": 400.0, "price_cents_per_litre": 189},
        {"vessel_id": "v2", "date": "2026-09-05", "litres": 1500.0, "price_cents_per_litre": 101},
        {"vessel_id": "v1", "date": "2026-09-20", "litres": 120.5, "price_cents_per_litre": 192},
        {"vessel_id": "v3", "date": "2026-08-28", "litres": 310.0, "price_cents_per_litre": 185},
    ]))
    return tmp_path
