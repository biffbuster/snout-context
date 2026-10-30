from berthbook.billing import invoices_for_month
from berthbook.store import Store


def test_one_invoice_per_vessel_in_name_order(data_dir):
    invoices = invoices_for_month(Store(data_dir), "2026-09")
    assert [(i.number, i.vessel, i.amount_cents) for i in invoices] == [
        ("INV-2026-09-001", "Marlin", 123480),
        ("INV-2026-09-002", "Osprey", 13650),
    ]


def test_other_months_left_out(data_dir):
    assert [i.vessel for i in invoices_for_month(Store(data_dir), "2026-08")] == ["Kittiwake"]
