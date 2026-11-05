from berthbook.cli import main


def test_invoices_command(data_dir, capsys):
    assert main(["--data", str(data_dir), "invoices", "2026-09"]) == 0
    out = capsys.readouterr().out
    assert "INV-2026-09-001  Marlin" in out
    assert "1,234.80" in out


def test_fuel_command(data_dir, capsys):
    assert main(["--data", str(data_dir), "fuel", "2026-09"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[2].startswith("2026-09-02  Marlin")
    assert len(lines) == 5
