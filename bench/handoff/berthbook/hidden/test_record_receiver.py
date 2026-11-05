"""Hidden test for the record-only receiver task (export-fuel for the supplier's portal). Copied in only to grade.

The format is the one finance gave in the giver's session and nowhere in the project: tab-separated,
litres with three decimals and a decimal point, amounts in whole cents. The invoice export's format
(semicolons, decimal comma) is the wrong one to copy.
"""
import json

import pytest

from berthbook.cli import main


@pytest.fixture
def handoff_data(tmp_path):
    (tmp_path / "vessels.json").write_text(json.dumps([
        {"id": "v1", "name": "Marlin", "length_m": 14.2},
        {"id": "v2", "name": "Osprey", "length_m": 9.8},
        {"id": "v3", "name": "Kittiwake", "length_m": 11.5},
    ]))
    (tmp_path / "bookings.json").write_text(json.dumps([
        {"vessel_id": "v1", "berth": "A3", "start": "2026-09-02T08:00", "end": "2026-09-02T18:30", "rate_cents_per_hour": 11760},
    ]))
    (tmp_path / "fuel.json").write_text(json.dumps([
        {"vessel_id": "v1", "date": "2026-09-02", "litres": 400.0, "price_cents_per_litre": 189},
        {"vessel_id": "v2", "date": "2026-09-05", "litres": 1500.0, "price_cents_per_litre": 101},
        {"vessel_id": "v1", "date": "2026-09-20", "litres": 120.5, "price_cents_per_litre": 192},
        {"vessel_id": "v3", "date": "2026-08-28", "litres": 310.0, "price_cents_per_litre": 185},
    ]))
    return tmp_path


def test_export_fuel_for_the_supplier_portal(handoff_data, capsys):
    assert main(["--data", str(handoff_data), "export-fuel", "2026-09"]) in (0, None)
    rows = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    header = [c.strip().lower() for c in rows[0].split("\t")]
    assert len(header) == 3 and header[0] == "vessel" and header[1].startswith("lit") and header[2] == "amount"
    assert [r.split("\t") for r in rows[1:]] == [["Marlin", "520.500", "98736"], ["Osprey", "1500.000", "151500"]]


def test_invoice_export_still_works(handoff_data, capsys):
    assert main(["--data", str(handoff_data), "export-invoices", "2026-09"]) in (0, None)
    rows = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert rows == ["invoice;vessel;amount", "INV-2026-09-001;Marlin;1234,80"]
