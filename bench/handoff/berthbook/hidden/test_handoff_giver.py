"""Hidden test for the giver's task (export-invoices). Copied in only to grade; never in a session's workspace."""
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
        {"vessel_id": "v2", "berth": "B1", "start": "2026-09-05T09:00", "end": "2026-09-05T12:00", "rate_cents_per_hour": 4550},
        {"vessel_id": "v1", "berth": "A3", "start": "2026-09-02T08:00", "end": "2026-09-02T18:30", "rate_cents_per_hour": 11760},
        {"vessel_id": "v3", "berth": "C2", "start": "2026-08-28T10:00", "end": "2026-08-28T16:00", "rate_cents_per_hour": 6100},
    ]))
    return tmp_path


def test_export_invoices_for_finance(handoff_data, capsys):
    assert main(["--data", str(handoff_data), "export-invoices", "2026-09"]) in (0, None)
    rows = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert rows == ["invoice;vessel;amount", "INV-2026-09-001;Marlin;1234,80", "INV-2026-09-002;Osprey;136,50"]
