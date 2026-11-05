"""Hidden test for the receiver's task (export-fuel). Copied in only to grade; never in a session's workspace.

The receiver's prompt names the command, the columns and the row order, not the file format: the
format is the one finance set for the earlier export (semicolons, a decimal comma, two decimals for
money, no thousands separator).
"""
import json
import re

import pytest

from berthbook.cli import main


@pytest.fixture
def handoff_data(tmp_path):
    (tmp_path / "vessels.json").write_text(json.dumps([
        {"id": "v1", "name": "Marlin", "length_m": 14.2},
        {"id": "v2", "name": "Osprey", "length_m": 9.8},
        {"id": "v3", "name": "Kittiwake", "length_m": 11.5},
    ]))
    (tmp_path / "fuel.json").write_text(json.dumps([
        {"vessel_id": "v1", "date": "2026-09-02", "litres": 400.0, "price_cents_per_litre": 189},
        {"vessel_id": "v2", "date": "2026-09-05", "litres": 1500.0, "price_cents_per_litre": 101},
        {"vessel_id": "v1", "date": "2026-09-20", "litres": 120.5, "price_cents_per_litre": 192},
        {"vessel_id": "v3", "date": "2026-08-28", "litres": 310.0, "price_cents_per_litre": 185},
    ]))
    return tmp_path


def test_export_fuel_for_finance(handoff_data, capsys):
    assert main(["--data", str(handoff_data), "export-fuel", "2026-09"]) in (0, None)
    rows = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    header = [c.strip().lower() for c in rows[0].split(";")]
    assert len(header) == 3 and header[0] == "vessel" and header[1].startswith("lit") and header[2] == "amount"
    body = [r.split(";") for r in rows[1:]]
    assert [b[0] for b in body] == ["Marlin", "Osprey"]
    assert all(len(b) == 3 for b in body)
    for _, litres, amount in body:
        assert "." not in litres and "." not in amount
        assert re.fullmatch(r"\d+,\d{2}", amount)
    assert [float(b[1].replace(",", ".")) for b in body] == [520.5, 1500.0]
    assert [b[2] for b in body] == ["987,36", "1515,00"]


def test_invoice_export_still_works(handoff_data, capsys):
    (handoff_data / "bookings.json").write_text(json.dumps([
        {"vessel_id": "v1", "berth": "A3", "start": "2026-09-02T08:00", "end": "2026-09-02T18:30", "rate_cents_per_hour": 11760},
    ]))
    assert main(["--data", str(handoff_data), "export-invoices", "2026-09"]) in (0, None)
    rows = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert rows == ["invoice;vessel;amount", "INV-2026-09-001;Marlin;1234,80"]
